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
  /** Plaintext policy number — matched against leads.policy_id directly, or against
   *  decrypted leads.tracking_id for leads that don't have policy_id yet. */
  trackingId: string
  /** DDF disposition status — used to look up the matching pipeline_stage name */
  status: string
}

/**
 * Policy numbers from the batch that matched no lead at all — neither by policy_id
 * nor by decrypting tracking_id. Deliberately not auto-matched any other way (no
 * scoring, no name/phone fuzzy matching): these need a human to attach the policy
 * manually.
 */
export type SyncLeadStagesResult = {
  matchedCount: number
  unmatchedPolicyNumbers: string[]
}

type LeadRow = { id: string; tracking_id?: string | null; policy_id: string | null; stage_id: number | null; pipeline_id: number | null }

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

export type LeadMatchResult = {
  /** plaintext policyNumber → the one lead row it resolved to */
  matchedByPolicy: Map<string, LeadRow>
  unmatchedPolicyNumbers: string[]
}

/**
 * Read-only resolution of the two exact-key paths — no scoring, no name/phone
 * fuzzy matching, no submission_id (see syncLeadStagesFromDdfStatus's doc comment
 * for why). Shared by syncLeadStagesFromDdfStatus (which applies stage updates for
 * every match) and any read-only caller that just needs to know which policies
 * already have a lead and which don't — e.g. the AI-assisted unmatched-lead review
 * page, which only wants the `unmatchedPolicyNumbers` half of this.
 *
 *   1. policy_id — the lead already has this policy attached (from a prior sync,
 *      or attached manually).
 *   2. tracking_id decryption — the lead doesn't have policy_id yet (a brand-new
 *      policy that isn't in the accounting database yet). Decrypt each candidate
 *      lead's tracking_id and compare to the incoming policy number.
 *
 * If (in some data-integrity edge case) both a policy_id lead and a separate
 * tracking_id lead resolve to the same incoming policy number, the policy_id match
 * wins — a policy already attached to a lead takes precedence over a decrypted
 * guess from a possibly-stale tracking_id.
 */
export async function findLeadsForPolicyNumbers(
  ddf: ReturnType<typeof getDdfClient>['client'],
  policyNumbers: string[]
): Promise<LeadMatchResult> {
  const wanted = new Set(policyNumbers.map(trimPolicy).filter(Boolean))
  const matchedByPolicy = new Map<string, LeadRow>()
  if (wanted.size === 0) return { matchedByPolicy, unmatchedPolicyNumbers: [] }

  const processedLeadIds = new Set<string>()

  // ── Path 1: already-attached leads — exact policy_id match ─────────────────
  {
    const { data: rows, error } = await ddf
      .from(LEADS_TABLE)
      .select('id, policy_id, stage_id, pipeline_id')
      .in('policy_id', Array.from(wanted))

    if (error) console.error('[leadMatch] policy_id lookup error:', error.message)
    console.log(`[leadMatch] policy_id path found ${(rows ?? []).length} lead(s)`)

    for (const raw of (rows ?? []) as LeadRow[]) {
      const policyNumber = trimPolicy(raw.policy_id)
      if (!policyNumber || !wanted.has(policyNumber)) continue
      processedLeadIds.add(raw.id)
      matchedByPolicy.set(policyNumber, raw)
    }
  }

  // ── Path 2: new/unattached leads — decrypt tracking_id ──────────────────────
  // Scans every lead with a non-null tracking_id and decrypts to compare — the
  // only way to find a lead that has no policy_id yet.
  {
    const { data: rows, error } = await ddf
      .from(LEADS_TABLE)
      .select('id, tracking_id, policy_id, stage_id, pipeline_id')
      .not('tracking_id', 'is', null)

    if (error) console.error('[leadMatch] tracking_id fetch error:', error.message)
    console.log(`[leadMatch] tracking_id path: scanning ${(rows ?? []).length} leads with non-null tracking_id`)

    for (const raw of (rows ?? []) as LeadRow[]) {
      if (!raw.tracking_id || processedLeadIds.has(raw.id)) continue
      const policyNumber = trimPolicy(decryptTrackingIdSafe(raw.tracking_id))
      if (!policyNumber || !wanted.has(policyNumber) || matchedByPolicy.has(policyNumber)) continue
      console.log(`[leadMatch] tracking_id path matched lead ${raw.id} → policyNumber=${policyNumber}`)
      processedLeadIds.add(raw.id)
      matchedByPolicy.set(policyNumber, raw)
    }
  }

  const unmatchedPolicyNumbers = Array.from(wanted).filter(pn => !matchedByPolicy.has(pn))
  return { matchedByPolicy, unmatchedPolicyNumbers }
}

/** Resolve `status` to a pipeline_stages row and write it (plus policy_id) to `lead`, if anything changed. */
async function resolveAndWriteLeadUpdate(
  ddf: ReturnType<typeof getDdfClient>['client'],
  stageMatchesByName: Map<string, PipelineStageRow[]>,
  lead: LeadRow,
  policyNumber: string,
  status: string
): Promise<{ wrote: boolean; error?: string }> {
  const matches = status ? stageMatchesByName.get(status.toLowerCase()) ?? [] : []
  const stageRow = resolvePreferredStage(matches)
  if (status && !stageRow) {
    console.log(`[sync] no pipeline_stage row for status="${status}" — stage not changed`)
  }
  const update = buildLeadStageUpdate(lead, policyNumber, stageRow)
  if (Object.keys(update).length === 0) {
    console.log(`[sync] lead ${lead.id} already up-to-date (policy_id=${lead.policy_id}, stage_id=${lead.stage_id})`)
    return { wrote: false }
  }
  console.log(`[sync] updating lead ${lead.id}:`, JSON.stringify(update))
  const { error } = await ddf.from(LEADS_TABLE).update(update as never).eq('id', lead.id)
  if (error) {
    console.error(`[sync] update failed for lead ${lead.id}:`, error.message)
    return { wrote: false, error: error.message }
  }
  return { wrote: true }
}

/**
 * For each matched policy: write leads.policy_id (when not already set) and update
 * leads.stage/stage_id/pipeline_id whenever the status maps to a known pipeline_stages
 * name — moving the lead to whichever pipeline that stage lives in (stages are not
 * confined to a single pipeline; e.g. FDPF stages live in the Chargeback pipeline,
 * Active milestones in the Customer pipeline).
 *
 * Matching itself is delegated to findLeadsForPolicyNumbers (the two exact-key paths
 * — no scoring, no name/phone fuzzy matching, no submission_id). A policy number that
 * matches neither path is left completely untouched and is reported back in
 * `unmatchedPolicyNumbers` — that lead needs a human to attach the policy manually.
 */
export async function syncLeadStagesFromDdfStatus(
  ddf: ReturnType<typeof getDdfClient>['client'],
  updates: DdfStatusStageSync[]
): Promise<SyncLeadStagesResult> {
  // ── build lookup map ────────────────────────────────────────────────────────
  /** plaintext policyNumber → status */
  const byPolicyNumber = new Map<string, string>()

  for (const u of updates) {
    const policyNumber = trimPolicy(u.trackingId)
    if (!policyNumber) continue
    byPolicyNumber.set(policyNumber, trimPolicy(u.status))
  }

  if (byPolicyNumber.size === 0) return { matchedCount: 0, unmatchedPolicyNumbers: [] }

  console.log(`[sync] byPolicyNumber size=${byPolicyNumber.size}`)

  const { matchedByPolicy, unmatchedPolicyNumbers } = await findLeadsForPolicyNumbers(
    ddf,
    Array.from(byPolicyNumber.keys())
  )

  // ── resolve pipeline stages once, across every pipeline ────────────────────
  const stageMatchesByName = await fetchPipelineStagesByName(ddf)

  for (const [policyNumber, lead] of matchedByPolicy) {
    const status = byPolicyNumber.get(policyNumber) ?? ''
    await resolveAndWriteLeadUpdate(ddf, stageMatchesByName, lead, policyNumber, status)
  }

  if (unmatchedPolicyNumbers.length > 0) {
    console.log(`[sync] ${unmatchedPolicyNumbers.length} polic${unmatchedPolicyNumbers.length === 1 ? 'y' : 'ies'} matched no lead (needs manual attach):`, unmatchedPolicyNumbers)
  }

  return { matchedCount: matchedByPolicy.size, unmatchedPolicyNumbers }
}

export type AttachPolicyResult = { ok: boolean; error?: string }

/**
 * Write policy_id + stage directly to one specific lead, identified by id — used
 * when a human has already confirmed which lead a policy belongs to (the
 * AI-assisted unmatched-lead review flow), bypassing the policy_id/tracking_id
 * search in findLeadsForPolicyNumbers entirely. This is the one place in the app
 * that attaches a policy without an exact-key match having found it first, so it
 * must only ever be reached via an explicit human confirmation click.
 */
export async function attachPolicyToLeadById(
  ddf: ReturnType<typeof getDdfClient>['client'],
  leadId: string,
  policyNumber: string,
  ghlStage: string | null
): Promise<AttachPolicyResult> {
  const id = trimPolicy(leadId)
  const policyNumberTrimmed = trimPolicy(policyNumber)
  if (!id || !policyNumberTrimmed) {
    return { ok: false, error: 'leadId and policyNumber are required.' }
  }

  const { data: leadRows, error: fetchError } = await ddf
    .from(LEADS_TABLE)
    .select('id, policy_id, stage_id, pipeline_id')
    .eq('id', id)

  if (fetchError) return { ok: false, error: fetchError.message }
  const leadRow = ((leadRows ?? []) as LeadRow[])[0]
  if (!leadRow) return { ok: false, error: 'Lead not found.' }

  const existingPolicyId = trimPolicy(leadRow.policy_id)
  if (existingPolicyId && existingPolicyId !== policyNumberTrimmed) {
    // Guards against a stale UI/candidate list (or a repeated confirm click) clobbering
    // an already-correct attachment — this path has no exact-key match to fall back on,
    // so an unexpected mismatch here must stop rather than silently overwrite.
    return {
      ok: false,
      error: `Lead already has a different policy attached (${existingPolicyId}). Refusing to overwrite.`,
    }
  }

  const stageMatchesByName = await fetchPipelineStagesByName(ddf)
  const result = await resolveAndWriteLeadUpdate(
    ddf,
    stageMatchesByName,
    leadRow,
    policyNumberTrimmed,
    trimPolicy(ghlStage)
  )
  return result.error ? { ok: false, error: result.error } : { ok: true }
}

export type LeadCandidateRow = {
  id: string
  first_name: string | null
  last_name: string | null
  phone: string | null
  submission_id: string | null
  carrier: string | null
  /** Licensed writing agent on the lead — compared against deal_tracker.sales_agent for the
   *  name+agent+carrier fallback (see lib/leadMatchCandidates.ts) used when tracking_id
   *  matching itself fails for a carrier (e.g. AMAM). */
  licensed_agent_account: string | null
  monthly_premium: number | null
  draft_date: string | null
  created_at: string | null
}

const LEAD_CANDIDATE_FETCH_LIMIT = 2000

/**
 * Leads with no policy attached yet — the candidate pool for the AI-assisted match
 * review (see lib/leadMatchCandidates.ts for scoring). Leads that already have a
 * policy_id are excluded: reassigning an already-attached lead is a higher-risk
 * action this flow deliberately doesn't offer in v1.
 */
export async function fetchUnattachedLeadCandidates(
  ddf: ReturnType<typeof getDdfClient>['client']
): Promise<LeadCandidateRow[]> {
  const { data, error } = await ddf
    .from(LEADS_TABLE)
    .select('id, first_name, last_name, phone, submission_id, carrier, licensed_agent_account, monthly_premium, draft_date, created_at')
    .is('policy_id', null)
    .order('created_at', { ascending: false })
    .limit(LEAD_CANDIDATE_FETCH_LIMIT)

  if (error) {
    console.error('[leadMatch] fetchUnattachedLeadCandidates error:', error.message)
    return []
  }
  return (data ?? []) as LeadCandidateRow[]
}
