import { getDdfClient } from '@/lib/ddfSource'
import { decryptTrackingIdSafe } from '@/lib/trackingIdCrypto'

const LEADS_TABLE = process.env.NEW_DDF_LEADS_TABLE || 'leads'
const LEAD_NOTES_TABLE = process.env.NEW_DDF_LEAD_NOTES_TABLE || 'lead_notes'

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

  const inserted = await insertLeadNote({
    leadId,
    body,
    dealTrackerReviewNoteId,
    createdBy: input.createdBy,
  })

  if (!inserted.ok) {
    return {
      synced: false,
      reason: 'insert_failed',
      message: `Lead note save failed: ${inserted.message}`,
    }
  }

  return {
    synced: true,
    leadId,
    leadNoteId: inserted.leadNoteId,
  }
}

export type InsertLeadNoteInput = {
  leadId: string
  body: string
  dealTrackerReviewNoteId: string
  /**
   * CRM user id. `lead_notes.created_by` is a uuid column, so anything that is
   * not a UUID (an email address, for instance) is dropped rather than sent —
   * Postgres would reject the whole insert. Portal users have no CRM user id, so
   * this is normally null and authorship is carried in the note body.
   */
  createdBy?: string | null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function uuidOrNull(value: unknown): string | null {
  const raw = String(value ?? '').trim()
  return UUID_RE.test(raw) ? raw : null
}

export type InsertLeadNoteResult =
  | { ok: true; leadNoteId: string }
  | { ok: false; message: string }

/**
 * Insert one row into the CRM `lead_notes` table against an already-resolved lead.
 *
 * Split out of syncReviewNoteToLeadNotes so callers that have already located the
 * lead (e.g. a stage change that just updated it) can write the note without
 * repeating the lookup — which would otherwise miss leads matched by decrypting
 * `tracking_id` rather than by `policy_id`.
 */
export async function insertLeadNote(input: InsertLeadNoteInput): Promise<InsertLeadNoteResult> {
  const leadId = trimPolicy(input.leadId)
  const body = trimPolicy(input.body)
  const dealTrackerReviewNoteId = trimPolicy(input.dealTrackerReviewNoteId)

  if (!leadId || !body) {
    return { ok: false, message: 'leadId and body are required.' }
  }

  const { client: ddf } = getDdfClient('new')

  const payload = {
    lead_id: leadId,
    body,
    // Both are uuid columns; a non-UUID here fails the whole insert.
    deal_tracker_review_note_id: uuidOrNull(dealTrackerReviewNoteId),
    created_by: uuidOrNull(input.createdBy),
  }

  const { data: inserted, error: insertError } = await ddf
    .from(LEAD_NOTES_TABLE)
    .insert(payload as never)
    .select('id')
    .single()

  if (insertError) return { ok: false, message: insertError.message }

  const insertedRow = inserted as Record<string, unknown> | null
  return { ok: true, leadNoteId: String(insertedRow?.id ?? '') }
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

export type PipelineStageRow = { id: number; pipeline_id: number; name: string }

/**
 * Resolve which pipeline_stages row a stage name should apply to: the first
 * match by name. Matches app/api/amam-correspondence/update-stage/route.ts's
 * resolution (its own `resolvePipelineStage`, kept independent/unshared there)
 * so both land on the same stage for the same name — no stage name currently
 * sent by the carrier-portal side collides across more than one pipeline, so
 * "first match" and "first match in the lead's pipeline" are equivalent today.
 */
export function resolvePreferredStage(matches: PipelineStageRow[]): PipelineStageRow | null {
  return matches[0] ?? null
}

/**
 * Fetch the whole `pipeline_stages` table, grouped by name (trimmed, lowercased).
 * The table is small (a few dozen rows across all pipelines) so fetching it in
 * full and matching in memory is cheap and sidesteps casing/exact-match issues
 * with querying by name directly.
 */
export async function fetchPipelineStagesByName(
  ddf: ReturnType<typeof getDdfClient>['client']
): Promise<Map<string, PipelineStageRow[]>> {
  const stageMatchesByName = new Map<string, PipelineStageRow[]>()
  const { data: stageRows } = await ddf.from('pipeline_stages').select('id, pipeline_id, name')
  for (const row of (stageRows ?? []) as PipelineStageRow[]) {
    const key = row.name.trim().toLowerCase()
    const bucket = stageMatchesByName.get(key)
    if (bucket) bucket.push(row)
    else stageMatchesByName.set(key, [row])
  }
  return stageMatchesByName
}

type LeadStageFields = { policy_id: string | null; stage_id: number | null; pipeline_id: number | null }

/**
 * Build the `leads` update payload for moving one lead to `stageRow` (or just
 * self-healing `policy_id` when `stageRow` is null — e.g. a GHL stage with no
 * CRM pipeline_stages equivalent yet). Returns `{}` when nothing would change.
 * Shared so every caller writes the same fields the same way.
 */
export function buildLeadStageUpdate(
  lead: LeadStageFields,
  policyNumber: string,
  stageRow: PipelineStageRow | null
): Record<string, unknown> {
  const update: Record<string, unknown> = {}
  if (policyNumber && lead.policy_id !== policyNumber) update.policy_id = policyNumber
  if (stageRow && (lead.stage_id !== stageRow.id || lead.pipeline_id !== stageRow.pipeline_id)) {
    update.stage = stageRow.name
    update.stage_id = stageRow.id
    update.pipeline_id = stageRow.pipeline_id
  }
  return update
}

/**
 * For each matched DDF record: write leads.policy_id (always) and update
 * leads.stage/stage_id/pipeline_id whenever the DDF status maps to a known
 * pipeline_stages name — moving the lead to whichever pipeline that stage lives
 * in (stages are not confined to a single pipeline; e.g. FDPF stages live in the
 * Chargeback pipeline, Active milestones in the Customer pipeline), the same as
 * a manual CRM Sync Operations sync would.
 *
 * Lookup priority:
 *   1. submission_id — direct reliable join, works even when leads.tracking_id is null.
 *   2. policy_id — direct match for leads already self-healed/attached to a policy.
 *   3. tracking_id decryption — fallback for rows that have neither of the above.
 *
 * policy_id is written unconditionally whenever the matched policyNumber differs.
 */
export async function syncLeadStagesFromDdfStatus(
  ddf: ReturnType<typeof getDdfClient>['client'],
  updates: DdfStatusStageSync[]
): Promise<void> {
  // ── build lookup maps ──────────────────────────────────────────────────────
  /** submissionId → { policyNumber, status } */
  const bySubmissionId = new Map<string, { policyNumber: string; status: string }>()
  /** plaintext policyNumber → status (for the policy_id and tracking_id fallback paths) */
  const byPolicyNumber = new Map<string, string>()

  for (const u of updates) {
    const policyNumber = trimPolicy(u.trackingId)
    if (!policyNumber) continue
    const status = trimPolicy(u.status)
    if (u.submissionId) bySubmissionId.set(trimPolicy(u.submissionId), { policyNumber, status })
    byPolicyNumber.set(policyNumber, status)
  }

  if (bySubmissionId.size === 0 && byPolicyNumber.size === 0) return

  // ── resolve pipeline stages once, across every pipeline ────────────────────
  const stageMatchesByName = await fetchPipelineStagesByName(ddf)

  const processedLeadIds = new Set<string>()

  async function applyUpdate(lead: LeadRow, policyNumber: string, status: string) {
    const matches = status ? stageMatchesByName.get(status.toLowerCase()) ?? [] : []
    const stageRow = resolvePreferredStage(matches)
    if (status && !stageRow) {
      console.log(`[sync] no pipeline_stage row for status="${status}" — stage not changed`)
    }
    const update = buildLeadStageUpdate(lead, policyNumber, stageRow)
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

  // ── Path 2: find remaining leads directly by policy_id ──────────────────────
  // Covers leads already self-healed/attached (a prior sync wrote policy_id, or
  // someone attached the policy manually via CRM Sync Operations / Pipeline
  // Audit) but that have no submission_id and no tracking_id to decrypt — those
  // leads are otherwise invisible to this function even though policy_id is a
  // direct, reliable match.
  if (byPolicyNumber.size > 0) {
    const policyNumbers = Array.from(byPolicyNumber.keys())
    const { data: rows, error } = await ddf
      .from(LEADS_TABLE)
      .select('id, policy_id, stage_id, pipeline_id')
      .in('policy_id', policyNumbers)

    if (error) console.error('[sync] policy_id lookup error:', error.message)
    console.log(`[sync] policy_id path found ${(rows ?? []).length} lead(s)`)

    for (const raw of (rows ?? []) as LeadRow[]) {
      if (processedLeadIds.has(raw.id)) continue
      const policyNumber = trimPolicy(raw.policy_id)
      if (!policyNumber) continue
      const status = byPolicyNumber.get(policyNumber)
      if (status === undefined) continue
      processedLeadIds.add(raw.id)
      await applyUpdate(raw, policyNumber, status)
    }
  }

  // ── Path 3: find remaining leads by decrypting tracking_id ──────────────────
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
