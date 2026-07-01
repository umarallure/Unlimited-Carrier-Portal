import { getDdfClient } from '@/lib/ddfSource'
import { decryptTrackingIdSafe } from '@/lib/trackingIdCrypto'

const LEADS_TABLE = process.env.NEW_DDF_LEADS_TABLE || 'leads'
const LEAD_NOTES_TABLE = process.env.NEW_DDF_LEAD_NOTES_TABLE || 'lead_notes'
/** Transfer pipeline — the only pipeline DDF-status-driven stage sync is allowed to touch. */
const TRANSFER_PIPELINE_ID = 4

function trimPolicy(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Build lookup candidates so numeric policies match with/without leading zeros. */
export function policyLookupCandidates(value: unknown): string[] {
  const raw = trimPolicy(value)
  if (!raw) return []

  const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (!cleaned) return []
  if (!/^\d+$/.test(cleaned)) return [cleaned, raw]

  const out = new Set<string>()
  const stripped = cleaned.replace(/^0+/, '') || '0'
  out.add(cleaned)
  out.add(stripped)
  out.add(raw)
  for (let len = Math.max(cleaned.length, stripped.length); len <= 12; len++) {
    if (stripped.length > len) continue
    out.add(stripped.padStart(len, '0'))
  }
  return Array.from(out)
}

export type SyncLeadNoteInput = {
  policyNumber: string
  body: string
  dealTrackerReviewNoteId: string
  createdBy?: string | null
}

export type SyncLeadNoteResult =
  | { synced: true; leadId: string; leadNoteId: string }
  | { synced: false; reason: 'no_lead' | 'invalid_input' | 'insert_failed'; message: string }

export async function syncReviewNoteToLeadNotes(
  input: SyncLeadNoteInput
): Promise<SyncLeadNoteResult> {
  const policyNumber = trimPolicy(input.policyNumber)
  const body = trimPolicy(input.body)
  const dealTrackerReviewNoteId = trimPolicy(input.dealTrackerReviewNoteId)

  if (!policyNumber || !body || !dealTrackerReviewNoteId) {
    return {
      synced: false,
      reason: 'invalid_input',
      message: 'Policy number, note body, and review note id are required.',
    }
  }

  const { client: ddf } = getDdfClient('new')
  const candidates = policyLookupCandidates(policyNumber)

  const { data: leadRows, error: leadError } = await ddf
    .from(LEADS_TABLE)
    .select('id, policy_id')
    .in('policy_id', candidates)
    .limit(5)

  if (leadError) {
    return {
      synced: false,
      reason: 'insert_failed',
      message: `Lead lookup failed: ${leadError.message}`,
    }
  }

  const leadId = String(
    ((leadRows ?? []) as Array<Record<string, unknown>>)[0]?.id ?? ''
  ).trim()
  if (!leadId) {
    return {
      synced: false,
      reason: 'no_lead',
      message:
        'Note saved to Deal Tracker, but no matching lead was found for this policy number. Attach policy in CRM to sync lead notes.',
    }
  }

  const payload = {
    lead_id: leadId,
    body,
    deal_tracker_review_note_id: dealTrackerReviewNoteId,
    created_by: input.createdBy?.trim() || null,
  }

  const { data: inserted, error: insertError } = await ddf
    .from(LEAD_NOTES_TABLE)
    .insert(payload as never)
    .select('id')
    .single()

  if (insertError) {
    return {
      synced: false,
      reason: 'insert_failed',
      message: `Lead note save failed: ${insertError.message}`,
    }
  }

  const insertedRow = inserted as Record<string, unknown> | null

  return {
    synced: true,
    leadId,
    leadNoteId: String(insertedRow?.id ?? ''),
  }
}

export type DdfStatusStageSync = {
  /** Plaintext policy number — used as the value to write to leads.policy_id */
  trackingId: string
  /** DDF disposition status — used to look up the matching pipeline_stage name */
  status: string
  /** daily_deal_flow.submission_id — primary join key to find the lead reliably */
  submissionId?: string | null
}

type LeadRow = { id: string; submission_id?: string | null; tracking_id?: string | null; policy_id: string | null; stage_id: number | null; pipeline_id: number | null }

/**
 * For each matched DDF record: write leads.policy_id (always) and update leads.stage/stage_id
 * when the lead sits in the Transfer pipeline and the DDF status maps to a known stage name.
 *
 * Lookup priority:
 *   1. submission_id — direct reliable join, works even when leads.tracking_id is null.
 *   2. tracking_id decryption — fallback for rows that lack a submission_id link.
 *
 * Stage moves are scoped to Transfer pipeline (pipeline_id 4) only.
 * policy_id is written unconditionally whenever the matched policyNumber differs.
 */
export async function syncLeadStagesFromDdfStatus(
  ddf: ReturnType<typeof getDdfClient>['client'],
  updates: DdfStatusStageSync[]
): Promise<void> {
  // ── build lookup maps ──────────────────────────────────────────────────────
  /** submissionId → { policyNumber, status } */
  const bySubmissionId = new Map<string, { policyNumber: string; status: string }>()
  /** plaintext policyNumber → status (for tracking_id fallback path) */
  const byPolicyNumber = new Map<string, string>()

  for (const u of updates) {
    const policyNumber = trimPolicy(u.trackingId)
    if (!policyNumber) continue
    const status = trimPolicy(u.status)
    if (u.submissionId) bySubmissionId.set(trimPolicy(u.submissionId), { policyNumber, status })
    byPolicyNumber.set(policyNumber, status)
  }

  if (bySubmissionId.size === 0 && byPolicyNumber.size === 0) return

  // ── resolve pipeline stages once ──────────────────────────────────────────
  const distinctStatuses = Array.from(new Set([...bySubmissionId.values()].map(v => v.status).concat(Array.from(byPolicyNumber.values())))).filter(Boolean)
  const stageByName = new Map<string, { id: number; pipeline_id: number; name: string }>()

  if (distinctStatuses.length > 0) {
    const { data: stageRows } = await ddf
      .from('pipeline_stages')
      .select('id, pipeline_id, name')
      .eq('pipeline_id', TRANSFER_PIPELINE_ID)
      .in('name', distinctStatuses)
    for (const row of (stageRows ?? []) as { id: number; pipeline_id: number; name: string }[]) {
      stageByName.set(row.name.trim().toLowerCase(), row)
    }
  }

  const processedLeadIds = new Set<string>()

  async function applyUpdate(lead: LeadRow, policyNumber: string, status: string) {
    const update: Record<string, unknown> = {}
    if (lead.policy_id !== policyNumber) update.policy_id = policyNumber
    if (status) {
      const stageRow = stageByName.get(status.toLowerCase())
      if (stageRow && (lead.pipeline_id === TRANSFER_PIPELINE_ID || lead.pipeline_id == null)) {
        if (lead.stage_id !== stageRow.id || lead.pipeline_id !== stageRow.pipeline_id) {
          update.stage = stageRow.name
          update.stage_id = stageRow.id
          update.pipeline_id = stageRow.pipeline_id
        }
      } else if (stageRow) {
        console.log(`[sync] skipping stage update for lead ${lead.id}: pipeline_id=${lead.pipeline_id} (not Transfer or null)`)
      } else {
        console.log(`[sync] no pipeline_stage row for status="${status}" — stage not changed`)
      }
    }
    if (Object.keys(update).length > 0) {
      console.log(`[sync] updating lead ${lead.id}:`, JSON.stringify(update))
      const { error } = await ddf.from(LEADS_TABLE).update(update as never).eq('id', lead.id)
      if (error) console.error(`[sync] update failed for lead ${lead.id}:`, error.message)
    } else {
      console.log(`[sync] lead ${lead.id} already up-to-date (policy_id=${lead.policy_id}, stage_id=${lead.stage_id})`)
    }
  }

  // ── Path 1: find leads directly by submission_id ───────────────────────────
  console.log(`[sync] bySubmissionId size=${bySubmissionId.size}, byPolicyNumber size=${byPolicyNumber.size}`)
  if (bySubmissionId.size > 0) {
    const submissionIds = Array.from(bySubmissionId.keys())
    console.log('[sync] querying leads by submission_id:', submissionIds)
    const { data: rows, error } = await ddf
      .from(LEADS_TABLE)
      .select('id, submission_id, policy_id, stage_id, pipeline_id')
      .in('submission_id', submissionIds)

    if (error) console.error('[sync] submission_id lookup error:', error.message)
    console.log(`[sync] submission_id path found ${(rows ?? []).length} lead(s)`)

    for (const raw of (rows ?? []) as LeadRow[]) {
      const sid = trimPolicy(raw.submission_id)
      if (!sid) continue
      const entry = bySubmissionId.get(sid)
      if (!entry) continue
      processedLeadIds.add(raw.id)
      await applyUpdate(raw, entry.policyNumber, entry.status)
    }
  }

  // ── Path 2: find remaining leads by decrypting tracking_id ─────────────────
  if (byPolicyNumber.size > 0) {
    const { data: rows, error } = await ddf
      .from(LEADS_TABLE)
      .select('id, tracking_id, policy_id, stage_id, pipeline_id')
      .not('tracking_id', 'is', null)

    if (error) console.error('[sync] tracking_id fetch error:', error.message)
    console.log(`[sync] tracking_id path: scanning ${(rows ?? []).length} leads with non-null tracking_id`)

    for (const raw of (rows ?? []) as LeadRow[]) {
      if (!raw.tracking_id || processedLeadIds.has(raw.id)) continue
      const policyNumber = trimPolicy(decryptTrackingIdSafe(raw.tracking_id))
      if (!policyNumber) continue
      const status = byPolicyNumber.get(policyNumber)
      if (status === undefined) continue
      console.log(`[sync] tracking_id path matched lead ${raw.id} → policyNumber=${policyNumber}`)
      await applyUpdate(raw, policyNumber, status)
    }
  }
}
