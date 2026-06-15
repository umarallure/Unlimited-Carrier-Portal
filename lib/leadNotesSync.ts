import { getDdfClient } from '@/lib/ddfSource'

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
