/**
 * Policy change exceptions — the "freeze list".
 *
 * Policies on this list are skipped by the file-upload pipeline: nothing is
 * written to deal_tracker, commission_tracker, or the CRM lead for them. Raw
 * carrier rows (*_policies / *_commissions) are still stored — that is the
 * source record and staying faithful to the carrier file is the point.
 *
 * Deliberate human edits are NOT blocked. Enforcement sits at the upload write
 * funnel (saveDealTrackerEntries) rather than on the table, so the Deal Tracker
 * grid, Policy Audit, Review Policies and the stage-change routes keep working —
 * otherwise a frozen policy could never be corrected or unfrozen.
 */

import { supabase } from './supabaseClient'

export const POLICY_EXCEPTIONS_TABLE = 'policy_change_exceptions'

export interface PolicyException {
  id: string
  policy_number: string
  policy_number_key: string
  carrier: string | null
  reason: string | null
  active: boolean
  created_at: string
  updated_at: string
  created_by_email: string | null
}

/**
 * Match key for a policy number: punctuation stripped, uppercased, leading
 * zeros removed for all-numeric values.
 *
 * Must stay byte-identical in behaviour to normalizePolicyKey in
 * lib/amamCorrespondence.ts — the codebase already carries two variants of this
 * (there and policyLookupCandidates in lib/leadNotesSync.ts) and they are
 * deliberately not consolidated here, because leadNotesSync is under test on an
 * open branch. If you change one, change all three.
 */
export function normalizePolicyKey(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+/, '') || '0'
}

/**
 * Active exceptions keyed by normalized policy number.
 *
 * Build this once per save and pass it around — the table is small (tens to
 * hundreds of rows) so one read covers a whole upload batch.
 */
export type ExceptionIndex = Map<string, PolicyException>

/** An empty index — nothing is frozen. Used by callers that opt out of the check. */
export const EMPTY_EXCEPTION_INDEX: ExceptionIndex = new Map()

/**
 * Load every active exception.
 *
 * FAIL-CLOSED: throws when the list cannot be read. A silent empty list would
 * let an upload overwrite exactly the policies someone asked to protect, so a
 * loud failure is the safer default. Callers that genuinely want to proceed
 * without protection must pass EMPTY_EXCEPTION_INDEX explicitly.
 */
export async function fetchExceptionIndex(): Promise<ExceptionIndex> {
  const { data, error } = await supabase
    .from(POLICY_EXCEPTIONS_TABLE)
    .select('*')
    .eq('active', true)

  if (error) {
    throw new Error(
      `Could not load the policy exception list, so the save was stopped to avoid ` +
        `overwriting protected policies: ${error.message}`
    )
  }

  const index: ExceptionIndex = new Map()
  for (const row of (data as PolicyException[]) || []) {
    const key = row.policy_number_key || normalizePolicyKey(row.policy_number)
    if (key) index.set(key, row)
  }
  return index
}

/** The matching exception for a policy number, or null when it is not frozen. */
export function findException(
  index: ExceptionIndex,
  policyNumber: unknown
): PolicyException | null {
  const key = normalizePolicyKey(policyNumber)
  if (!key) return null
  return index.get(key) ?? null
}

export interface PartitionResult<T> {
  /** Rows that may be written. */
  kept: T[]
  /** Rows skipped, paired with the exception that stopped them. */
  skipped: Array<{ row: T; exception: PolicyException }>
}

/**
 * Split rows into writable and frozen. `getPolicyNumber` pulls the policy number
 * out of whatever row shape the caller has.
 */
export function partitionByException<T>(
  index: ExceptionIndex,
  rows: T[],
  getPolicyNumber: (row: T) => unknown
): PartitionResult<T> {
  if (index.size === 0) return { kept: rows, skipped: [] }

  const kept: T[] = []
  const skipped: Array<{ row: T; exception: PolicyException }> = []
  for (const row of rows) {
    const exception = findException(index, getPolicyNumber(row))
    if (exception) skipped.push({ row, exception })
    else kept.push(row)
  }
  return { kept, skipped }
}

/** One-line progress/log summary for a set of skipped rows. Null when nothing was skipped. */
export function describeSkipped<T>(
  skipped: Array<{ row: T; exception: PolicyException }>,
  getPolicyNumber: (row: T) => unknown
): string | null {
  if (skipped.length === 0) return null
  const shown = skipped
    .slice(0, 5)
    .map(({ row, exception }) => {
      const pn = String(getPolicyNumber(row) ?? '').trim() || exception.policy_number
      return exception.reason ? `${pn} (${exception.reason})` : pn
    })
    .join(', ')
  const more = skipped.length > 5 ? `, +${skipped.length - 5} more` : ''
  return (
    `Skipped ${skipped.length.toLocaleString()} polic${skipped.length === 1 ? 'y' : 'ies'} ` +
    `on the exception list — no changes applied: ${shown}${more}`
  )
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

/** Split pasted text (newlines, commas, semicolons, tabs) into policy numbers. */
export function parsePolicyNumberList(input: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of String(input ?? '').split(/[\s,;]+/)) {
    const value = token.trim()
    if (!value) continue
    const key = normalizePolicyKey(value)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export interface AddExceptionsResult {
  added: number
  /** Entries whose policy number produced no usable match key. */
  invalid: string[]
}

/**
 * Add (or refresh) exceptions. Upserts on the normalized key, so re-adding an
 * existing policy updates its reason/carrier and re-activates it rather than
 * creating a duplicate.
 */
export async function addExceptions(input: {
  policyNumbers: string[]
  carrier?: string | null
  reason?: string | null
}): Promise<AddExceptionsResult> {
  const now = new Date().toISOString()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const invalid: string[] = []
  const byKey = new Map<string, Record<string, unknown>>()

  for (const raw of input.policyNumbers) {
    const policyNumber = String(raw ?? '').replace(/\s+/g, ' ').trim()
    const key = normalizePolicyKey(policyNumber)
    if (!key) {
      if (policyNumber) invalid.push(policyNumber)
      continue
    }
    byKey.set(key, {
      policy_number: policyNumber,
      policy_number_key: key,
      carrier: input.carrier?.trim() || null,
      reason: input.reason?.trim() || null,
      active: true,
      updated_at: now,
      created_by: user?.id ?? null,
      created_by_email: user?.email ?? null,
    })
  }

  const payload = Array.from(byKey.values())
  if (payload.length === 0) return { added: 0, invalid }

  const { error } = await supabase
    .from(POLICY_EXCEPTIONS_TABLE)
    .upsert(payload, { onConflict: 'policy_number_key' })

  if (error) throw new Error(`Failed to save exceptions: ${error.message}`)
  return { added: payload.length, invalid }
}

/** Every exception, newest first — for the management page. */
export async function listExceptions(): Promise<PolicyException[]> {
  const { data, error } = await supabase
    .from(POLICY_EXCEPTIONS_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(`Failed to load exceptions: ${error.message}`)
  return (data as PolicyException[]) || []
}

/** Turn enforcement on/off without losing the audit trail. */
export async function setExceptionActive(id: string, active: boolean): Promise<void> {
  const { error } = await supabase
    .from(POLICY_EXCEPTIONS_TABLE)
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(`Failed to update exception: ${error.message}`)
}

export async function deleteException(id: string): Promise<void> {
  const { error } = await supabase.from(POLICY_EXCEPTIONS_TABLE).delete().eq('id', id)
  if (error) throw new Error(`Failed to delete exception: ${error.message}`)
}
