/**
 * Deal Tracker Processing Logic
 * Handles mapping carrier files to standardized deal tracker format
 */

import { supabase } from './supabaseClient'
import { createClient } from '@supabase/supabase-js'
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview } from './calendarDate'
import { getDdfClient } from './ddfSource'

export { mergeEffectiveDate } from './calendarDate'
export { mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'

/** Bulk-fetch DDF when there is no row, no contact on row, or no effective_date (need external draft_date). */
export function policyNeedsDdfLookup(
  existing: {
    call_center?: unknown
    phone_number?: unknown
    effective_date?: unknown
    ghl_name?: unknown
  } | null | undefined
): boolean {
  if (!existing) return true
  const hasContact =
    (existing.call_center != null && String(existing.call_center).trim() !== '') ||
    (existing.phone_number != null && String(existing.phone_number).trim() !== '')
  const hasEffective =
    existing.effective_date != null && String(existing.effective_date).trim() !== ''
  const hasGhlName =
    existing.ghl_name != null &&
    String(existing.ghl_name).trim() !== '' &&
    String(existing.ghl_name).trim() !== '-'
  if (!hasContact) return true
  if (!hasEffective) return true
  if (!hasGhlName) return true
  return false
}

// External Supabase client for daily_deal_flow (from another database)
let externalSupabaseClient: ReturnType<typeof createClient> | null = null

function getExternalSupabaseClient() {
  if (!externalSupabaseClient) {
    const url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY
    
    if (!url || !key) {
      throw new Error('Missing external Supabase credentials. Please set NEXT_PUBLIC_EXTERNAL_SUPABASE_URL and NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY')
    }
    
    externalSupabaseClient = createClient(url, key)
  }
  return externalSupabaseClient
}

export interface DealTrackerEntry {
  id?: string
  agency_carrier_id: string
  name: string | null
  tasks: string | null
  ghl_name: string | null
  ghl_stage: string | null
  policy_status: string | null
  deal_creation_date: string | null
  policy_number: string
  carrier: string
  carrier_id: string | null
  deal_value: number | null
  cc_value: number | null
  charge_back?: number | null
  notes: string | null
  status: string | null
  last_updated: string
  sales_agent: string | null
  writing_number: string | null
  commission_type: string | null
  effective_date: string | null
  /** Commission statement / paid date from carrier file (e.g. AMAM RptDate, Corebridge statement_date). Not stored on deal_tracker — preview/UI only; stripped on save. */
  commission_date?: string | null
  call_center: string | null
  phone_number: string | null
  cc_pmt_ws: string | null
  cc_cb_ws: string | null
  carrier_status: string | null
  policy_type: string | null
  daily_deal_flow_fetched: boolean
  daily_deal_flow_fetched_at: string | null
  source_policy_table: string | null
  source_policy_id: string | null
  source_commission_table: string | null
  source_commission_id: string | null
}

/** Fields we compare to detect "what changed" for the verification dialog highlight */
export const DEAL_TRACKER_COMPARABLE_FIELDS = [
  'name', 'policy_status', 'ghl_stage', 'carrier_status', 'deal_value', 'cc_value', 'charge_back',
  'sales_agent', 'writing_number', 'call_center', 'phone_number',
  'deal_creation_date', 'commission_date', 'effective_date', 'notes', 'status',
] as const

export interface DealTrackerPreviewEntry extends DealTrackerEntry {
  isNew: boolean
  isUpdated: boolean
  /** Set for updated rows: list of field names that differ from existing row (for UI highlight) */
  changedFields?: string[]
  /** Set for updated rows: previous values for changed fields only (for "what changed" view) */
  previousValues?: Partial<Record<string, unknown>>
}

/** GHL Stage must not be null, blank, or a lone "-" placeholder when saving to the database. */
export function isInvalidGhlStageForSave(v: unknown): boolean {
  if (v == null) return true
  const t = String(v).trim()
  return t === '' || t === '-'
}

/**
 * resolveGhlStage can return null when carrier_status is missing. Preview rows must still pass
 * isInvalidGhlStageForSave when the user saves after the Commission Report step.
 */
export function ensureGhlStageForPreviewSave(stage: string | null | undefined): string {
  if (!isInvalidGhlStageForSave(stage)) return String(stage).trim()
  return 'Issued - Pending First Draft'
}

/**
 * Compare old and new row and return field names whose values changed (for highlighting in verification dialog).
 */
export function getChangedFields(
  oldRow: Record<string, unknown> | null | undefined,
  newRow: Record<string, unknown> | null | undefined
): string[] {
  if (!oldRow || !newRow) return []
  const changed: string[] = []
  for (const key of DEAL_TRACKER_COMPARABLE_FIELDS) {
    const a = oldRow[key]
    const b = newRow[key]
    if (valueEqual(a, b)) continue
    changed.push(key)
  }
  return changed
}

/**
 * Return changed field names and previous values for those fields (for "what changed" detail view).
 */
export function getChangedFieldsAndPrevious(
  oldRow: Record<string, unknown> | null | undefined,
  newRow: Record<string, unknown> | null | undefined
): { changedFields: string[]; previousValues: Partial<Record<string, unknown>> } {
  const changedFields = getChangedFields(oldRow, newRow)
  const previousValues: Partial<Record<string, unknown>> = {}
  if (oldRow && changedFields.length > 0) {
    for (const key of changedFields) {
      previousValues[key] = oldRow[key]
    }
  }
  return { changedFields, previousValues }
}

/**
 * Derive changed field names from version_history (for deal tracker page highlight).
 * version_history is [{ at, snapshot }, ...] with oldest first; we compare latest snapshot to current row.
 * Status is rule-based from deal_value/charge_back; we only mark it "changed" when that derived value
 * actually differs, so we don't highlight Status for every row (snapshot often has raw DB status vs enriched derived).
 */
export function getChangedFieldsFromHistory(entry: { version_history?: Array<{ snapshot?: Record<string, unknown> }> } & Record<string, unknown>): string[] {
  const vh = Array.isArray(entry?.version_history) ? entry.version_history : []
  if (vh.length === 0) return []
  const prev = vh[vh.length - 1]?.snapshot
  if (!prev || typeof prev !== 'object') return []
  let changed = getChangedFields(prev as Record<string, unknown>, entry as Record<string, unknown>)
  if (changed.includes('status')) {
    const derivedPrev = statusFromDealValueAndChargeback(prev.deal_value as number | null | undefined, prev.charge_back as number | null | undefined)
    const derivedCur = statusFromDealValueAndChargeback(entry.deal_value as number | null | undefined, entry.charge_back as number | null | undefined)
    if (valueEqual(derivedPrev, derivedCur)) changed = changed.filter(f => f !== 'status')
  }
  return changed
}

/** Policy status is mapped from carrier_status; it should only change when carrier_status (raw) changes. */
export function carrierStatusUnchanged(
  existing: { carrier_status?: string | null } | null | undefined,
  newCarrierStatus: string | null | undefined
): boolean {
  return valueEqual(existing?.carrier_status, newCarrierStatus)
}

/**
 * Resolve `stage_monday` from bulk-fetched `carrier_status_mapping`.
 * Keys in DB must match file text; this adds fuzzy matching (whitespace, case)
 * so small differences do not skip the mapping.
 */
export function lookupMappedStageMonday(
  statusMappingMap: Map<string, string>,
  carrierStatusRaw: string | null | undefined
): string | null {
  if (carrierStatusRaw == null) return null
  const raw = String(carrierStatusRaw).trim()
  if (!raw) return null
  if (statusMappingMap.has(raw)) {
    const v = statusMappingMap.get(raw)
    if (v != null && String(v).trim() !== '') return String(v).trim()
  }
  const normRaw = normalizeTextForCompare(raw)
  for (const [k, v] of statusMappingMap.entries()) {
    if (normalizeTextForCompare(k) === normRaw) {
      if (v != null && String(v).trim() !== '') return String(v).trim()
    }
  }
  const lower = normRaw.toLowerCase()
  for (const [k, v] of statusMappingMap.entries()) {
    if (normalizeTextForCompare(String(k)).toLowerCase() === lower) {
      if (v != null && String(v).trim() !== '') return String(v).trim()
    }
  }
  return null
}

/**
 * `policy_status`: always use DB mapping when it matches `carrier_status` (raw).
 * If there is no mapping row, keep prior `policy_status` only when carrier raw is unchanged; otherwise use raw.
 */
export function resolvePolicyStatusFromCarrierMapping(
  statusMappingMap: Map<string, string>,
  carrierStatusRaw: string | null | undefined,
  carrierUnchanged: boolean,
  existingPolicyStatus: string | null | undefined
): string | null {
  const mapped = lookupMappedStageMonday(statusMappingMap, carrierStatusRaw)
  if (mapped != null) return mapped
  if (carrierUnchanged) return existingPolicyStatus ?? carrierStatusRaw ?? null
  return carrierStatusRaw ?? null
}

function normalizePolicyStatusForMappedGhlStage(
  mappedGhlStage: string | null | undefined,
  policyStatus: string | null | undefined,
): string | null {
  if (!mappedGhlStage) return policyStatus ?? null
  const stage = mappedGhlStage.trim().toLowerCase()
  if (stage === 'pending lapse' || stage.startsWith('pending lapse ')) return 'Pending Lapse'
  if (
    stage === 'fdpf pending reason' ||
    stage === 'fdpf insufficient funds' ||
    stage === 'fdpf incorrect banking info' ||
    stage === 'issued - pending first draft'
  ) {
    return 'Issued Not Paid'
  }
  return policyStatus ?? null
}

/** Pending approval / in-process — not pending lapse / lapsed / lapsing. */
function looksLikePendingApprovalNotLapse(
  policyStatus: string | null | undefined,
  carrierStatusRaw: string | null | undefined
): boolean {
  for (const raw of [policyStatus, carrierStatusRaw]) {
    if (raw == null || String(raw).trim() === '') continue
    const s = String(raw).toLowerCase()
    if (!s.includes('pending')) continue
    if (s.includes('lapse') || s.includes('lapsing') || s.includes('lapsed')) continue
    if (s.includes('pending payment') || s.includes('commission pending')) continue
    return true
  }
  return false
}

function pendingAgingForcesWithdrawn(
  mappedGhlStage: string | null | undefined,
  dealCreationDate: string | null | undefined,
  policyStatus: string | null | undefined,
  carrierStatusRaw: string | null | undefined
): boolean {
  if (mappedGhlStage !== 'Application Withdrawn') return false
  if (!looksLikePendingApprovalNotLapse(policyStatus, carrierStatusRaw)) return false
  if (!dealCreationDate || String(dealCreationDate).trim() === '') return false
  const p = parseDateParts(String(dealCreationDate))
  if (!p) return false
  const createdDay = new Date(p.y, p.m, p.d).getTime()
  const now = new Date()
  const todayDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const days = Math.floor((todayDay - createdDay) / (1000 * 60 * 60 * 24))
  return days > 30
}

/**
 * Normalize string for comparison: trim and collapse internal whitespace so
 * "Issued  Paid" and "Issued Paid" match.
 */
function normalizeTextForCompare(v: unknown): string {
  if (v == null) return ''
  return String(v).trim().replace(/\s+/g, ' ')
}

/** Parse date string to { y, m, d } for comparison; no timezone. Returns null if not a known format. */
function parseDateParts(s: string): { y: number; m: number; d: number } | null {
  const t = s.trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t)
  if (iso) {
    const y = parseInt(iso[1], 10)
    const m = parseInt(iso[2], 10) - 1
    const d = parseInt(iso[3], 10)
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) return { y, m, d }
  }
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (us) {
    const m = parseInt(us[1], 10) - 1
    const d = parseInt(us[2], 10)
    const y = parseInt(us[3], 10)
    if (m >= 0 && m <= 11 && d >= 1 && d <= 31) return { y, m, d }
  }
  return null
}

function valueEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'number' || typeof b === 'number') {
    const an = typeof a === 'number' ? a : parseFloat(String(a))
    const bn = typeof b === 'number' ? b : parseFloat(String(b))
    if (Number.isFinite(an) && Number.isFinite(bn)) return an === bn
  }
  const sa = normalizeTextForCompare(a)
  const sb = normalizeTextForCompare(b)
  if (sa === sb) return true
  // Case-insensitive compare for text (avoids "Issued Paid" vs "Issued paid" or "NOT yet paid" vs "Not Yet payed")
  if (sa.toLowerCase() === sb.toLowerCase()) return true
  // Date comparison: same calendar day = equal (so "2025-09-09" and "09/09/2025" are not a "change").
  // Parse as date parts so timezone and format don't affect result.
  const pa = sa ? parseDateParts(sa) : null
  const pb = sb ? parseDateParts(sb) : null
  if (pa && pb && pa.y === pb.y && pa.m === pb.m && pa.d === pb.d) return true
  return false
}

type DailyDealFlowInfo = {
  call_center: string | null
  phone_number: string | null
  draft_date: string | null
  lead_name: string | null
}

/**
 * Bulk fetch all status mappings for a carrier (OPTIMIZED)
 * Returns a Map of status -> mapped_status for fast lookups
 *
 * Fallback chain: carrier_id → carrier_code → AETNA (only if map still empty) →
 * for non-AETNA carriers, **fill missing keys** from AETNA (same portal string) so partial
 * per-carrier tables still resolve common statuses.
 */
export async function bulkFetchStatusMappings(
  carrierId: string,
  carrierCode: string | null
): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>()

  console.log('[Deal Tracker] Bulk fetching status mappings for carrier_id:', carrierId)

  const { data: mappings, error } = await supabase
    .from('carrier_status_mapping')
    .select('policy_status_in_carrier_portal, stage_monday')
    .eq('carrier_id', carrierId)

  if (!error && mappings && mappings.length > 0) {
    const typedMappings = mappings as Array<{ policy_status_in_carrier_portal: string; stage_monday: string }>
    typedMappings.forEach((m) => {
      statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
    })
    console.log('[Deal Tracker] Loaded', mappings.length, 'status mappings by carrier_id')
  }

  if (statusMap.size === 0 && carrierCode) {
    console.log('[Deal Tracker] No mappings by carrier_id, trying carrier_code:', carrierCode)
    const { data: fallbackMappings, error: fallbackError } = await supabase
      .from('carrier_status_mapping')
      .select('policy_status_in_carrier_portal, stage_monday')
      .eq('carrier_code', carrierCode)

    if (!fallbackError && fallbackMappings && fallbackMappings.length > 0) {
      const typedFallbackMappings = fallbackMappings as Array<{ policy_status_in_carrier_portal: string; stage_monday: string }>
      typedFallbackMappings.forEach((m) => {
        statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
      })
      console.log('[Deal Tracker] Loaded', fallbackMappings.length, 'status mappings by carrier_code')
    }
  }

  if (statusMap.size === 0) {
    const isAlreadyAetna =
      (carrierCode || '').toUpperCase() === 'AETNA' ||
      carrierId === ''
    if (!isAlreadyAetna) {
      console.log('[Deal Tracker] No status mappings found, falling back to AETNA default mappings')
      const { data: aetnaMappings, error: aetnaError } = await supabase
        .from('carrier_status_mapping')
        .select('policy_status_in_carrier_portal, stage_monday')
        .eq('carrier_code', 'AETNA')

      if (!aetnaError && aetnaMappings && aetnaMappings.length > 0) {
        const typedAetnaMappings = aetnaMappings as Array<{ policy_status_in_carrier_portal: string; stage_monday: string }>
        typedAetnaMappings.forEach((m) => {
          statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
        })
        console.log('[Deal Tracker] Loaded', aetnaMappings.length, 'AETNA fallback status mappings')
      }
    }
  }

  // Non-AETNA: fill missing portal keys from AETNA so a partial carrier_status_mapping row set
  // (e.g. AFLAC) still resolves statuses present on Aetna but not duplicated for this carrier.
  if ((carrierCode || '').toUpperCase() !== 'AETNA' && carrierId) {
    const { data: aetnaStatusFill, error: aetnaFillErr } = await supabase
      .from('carrier_status_mapping')
      .select('policy_status_in_carrier_portal, stage_monday')
      .eq('carrier_code', 'AETNA')
    if (!aetnaFillErr && aetnaStatusFill && aetnaStatusFill.length > 0) {
      let added = 0
      for (const m of aetnaStatusFill) {
        if (!m.policy_status_in_carrier_portal || m.stage_monday == null) continue
        if (!statusMap.has(m.policy_status_in_carrier_portal)) {
          statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
          added++
        }
      }
      if (added > 0) {
        console.log('[Deal Tracker] Filled', added, 'policy_status portal keys from AETNA where carrier had no row')
      }
    }
  }

  return statusMap
}

/**
 * MOH: "Placed" and "Inforce" are the same for GHL — both should allow Advanced and,
 * after deal_tracker.effective_date + 3 calendar months, ACTIVE - 3 Months +.
 * The DB may only list one status fully; merge stage lists and alias both keys.
 */
function unionMohPlacedInforceGhlStages(ghlMap: Map<string, string[]>): void {
  const norm = (k: string) => k.replace(/\s+/g, ' ').trim().toLowerCase()
  const keys = Array.from(ghlMap.keys())
  const matched = keys.filter(k => norm(k) === 'placed' || norm(k) === 'inforce')
  if (matched.length === 0) return

  const merged = new Set<string>()
  for (const k of matched) {
    ghlMap.get(k)?.forEach(s => merged.add(s))
  }
  const stages = Array.from(merged)

  const hasPlaced = matched.some(k => norm(k) === 'placed')
  const hasInforce = matched.some(k => norm(k) === 'inforce')
  const outKeys = new Set<string>(matched)
  if (!hasPlaced) outKeys.add('Placed')
  if (!hasInforce) outKeys.add('Inforce')

  for (const k of outKeys) {
    ghlMap.set(k, [...stages])
  }
}

/**
 * Bulk fetch GHL stage mappings for a carrier.
 * Maps raw carrier status -> ALL possible ghl_stages using carrier_ghl_stage_mappings table.
 * Returns a Map<string, string[]> so the resolver can pick the correct stage
 * based on context (time, commission, previous stage, grace period).
 *
 * Fallback chain: carrier_id → carrier_code → AETNA (only if map still empty) →
 * for non-AETNA carriers, **union-merge** all AETNA `carrier_ghl_stage_mappings` rows so each
 * portal status gets carrier-specific stages plus Aetna defaults (fixes missing/partial AFLAC rows).
 */
export async function bulkFetchGhlStageMappings(
  carrierId: string,
  carrierCode: string | null
): Promise<Map<string, string[]>> {
  const ghlMap = new Map<string, string[]>()

  const mergeIntoMap = (rows: { carrier_status_in_carrier_portal: string; ghl_stage: string }[]) => {
    rows.forEach(m => {
      const status = m.carrier_status_in_carrier_portal
      const stage = m.ghl_stage
      if (!status || !stage) return
      const existing = ghlMap.get(status) ?? []
      if (!existing.includes(stage)) existing.push(stage)
      ghlMap.set(status, existing)
    })
  }

  console.log('[Deal Tracker] Bulk fetching GHL stage mappings for carrier_id:', carrierId)

  const { data: mappings, error } = await supabase
    .from('carrier_ghl_stage_mappings')
    .select('carrier_status_in_carrier_portal, ghl_stage')
    .eq('carrier_id', carrierId)

  if (!error && mappings && mappings.length > 0) {
    mergeIntoMap(mappings)
    console.log('[Deal Tracker] Loaded', mappings.length, 'GHL mappings by carrier_id (unique statuses:', ghlMap.size, ')')
  }

  if (ghlMap.size === 0 && carrierCode) {
    console.log('[Deal Tracker] No GHL mappings by carrier_id, trying carrier_code:', carrierCode)
    const { data: fallbackMappings, error: fallbackError } = await supabase
      .from('carrier_ghl_stage_mappings')
      .select('carrier_status_in_carrier_portal, ghl_stage')
      .eq('carrier_code', carrierCode)

    if (!fallbackError && fallbackMappings && fallbackMappings.length > 0) {
      mergeIntoMap(fallbackMappings)
      console.log('[Deal Tracker] Loaded', fallbackMappings.length, 'GHL mappings by carrier_code (unique statuses:', ghlMap.size, ')')
    }
  }

  if (ghlMap.size === 0) {
    const isAlreadyAetna =
      (carrierCode || '').toUpperCase() === 'AETNA' ||
      carrierId === ''
    if (!isAlreadyAetna) {
      console.log('[Deal Tracker] No GHL mappings found, falling back to AETNA default mappings')
      const { data: aetnaMappings, error: aetnaError } = await supabase
        .from('carrier_ghl_stage_mappings')
        .select('carrier_status_in_carrier_portal, ghl_stage')
        .eq('carrier_code', 'AETNA')

      if (!aetnaError && aetnaMappings && aetnaMappings.length > 0) {
        mergeIntoMap(aetnaMappings)
        console.log('[Deal Tracker] Loaded', aetnaMappings.length, 'AETNA fallback GHL mappings (unique statuses:', ghlMap.size, ')')
      }
    }
  }

  // Non-AETNA carriers: union-merge AETNA rows so statuses missing or incomplete on this carrier
  // (e.g. AFLAC only lists "Issued" for a status) still get Aetna's default GHL options for the same
  // portal string — lookupStagesForCarrierStatus + resolveGhlStage can then pick Premium Paid / Active, etc.
  if ((carrierCode || '').toUpperCase() !== 'AETNA' && carrierId) {
    const { data: aetnaUnionRows, error: aetnaUnionErr } = await supabase
      .from('carrier_ghl_stage_mappings')
      .select('carrier_status_in_carrier_portal, ghl_stage')
      .eq('carrier_code', 'AETNA')
    if (!aetnaUnionErr && aetnaUnionRows && aetnaUnionRows.length > 0) {
      const keysBefore = ghlMap.size
      mergeIntoMap(aetnaUnionRows)
      console.log(
        '[Deal Tracker] Union-merged',
        aetnaUnionRows.length,
        'AETNA GHL rows into',
        carrierCode || carrierId,
        '| unique statuses:',
        keysBefore,
        '→',
        ghlMap.size,
      )
    }
  }

  if ((carrierCode || '').toUpperCase() === 'MOH') {
    unionMohPlacedInforceGhlStages(ghlMap)
  }

  return ghlMap
}

/**
 * Map carrier status to standardized status using carrier_status_mapping table
 * Uses carrier_id (UUID) from carriers table for reliable matching
 * NOTE: For bulk operations, use bulkFetchStatusMappings instead
 */
export async function mapCarrierStatus(
  carrierId: string, // UUID from carriers table
  carrierStatus: string | null
): Promise<string | null> {
  if (!carrierStatus || !carrierId) return null

  // Primary method: Match by carrier_id (UUID from carriers table)
  let { data, error } = await supabase
    .from('carrier_status_mapping')
    .select('stage_monday')
    .eq('carrier_id', carrierId)
    .eq('policy_status_in_carrier_portal', carrierStatus)
    .single()

  // Fallback to carrier_code if carrier_id not found (for backward compatibility)
  if (error || !data) {
    // Get carrier code to try fallback
    const { data: carrierData } = await supabase
      .from('carriers')
      .select('code')
      .eq('id', carrierId)
      .single()

    if (carrierData?.code) {
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('carrier_status_mapping')
        .select('stage_monday')
        .eq('carrier_code', carrierData.code)
        .eq('policy_status_in_carrier_portal', carrierStatus)
        .single()

      if (!fallbackError && fallbackData) {
        return fallbackData.stage_monday
      }
    }

    console.warn(`No mapping found for carrier_id: ${carrierId}, status: ${carrierStatus}`)
    return carrierStatus // Return original if no mapping found
  }

  return data.stage_monday
}

/**
 * Normalize name for better matching (remove extra spaces, commas -> space so "Last, First" matches "First Last")
 */
export function normalizeNameForSearch(name: string): string {
  if (!name) return ''
  // Replace commas with space so "Walker, Diane" becomes "Walker Diane" for consistent part extraction
  const noComma = name.replace(/,/g, ' ')
  return noComma.replace(/\s+/g, ' ').trim()
}

/**
 * Extract first and last name for flexible matching.
 * Returns a canonical key (sorted first|last) so "Diane Walker", "Walker, Diane", and "HART, RAYMOND L" vs "Raymond Lee Hart" match.
 * When a comma is present, treat "Last, First MI" so last = before comma, first = first word after comma.
 */
function extractNameParts(fullName: string): { firstName: string; lastName: string; allParts: string[]; firstLastKey: string } {
  const raw = (fullName ?? '').trim()
  if (!raw) {
    return { firstName: '', lastName: '', allParts: [], firstLastKey: '' }
  }

  const commaIdx = raw.indexOf(',')
  if (commaIdx >= 0) {
    // "Last, First MI" or "HART, RAYMOND L" -> last = before comma, first = first word after comma
    const beforeComma = raw.slice(0, commaIdx).replace(/\s+/g, ' ').trim()
    const afterComma = raw.slice(commaIdx + 1).replace(/\s+/g, ' ').trim()
    const firstWordAfter = afterComma.split(' ').filter(Boolean)[0] ?? ''
    if (beforeComma && firstWordAfter) {
      const lastName = beforeComma
      const firstName = firstWordAfter
      const firstLastKey = [firstName, lastName].sort().join('|').toLowerCase()
      return {
        firstName,
        lastName,
        allParts: [firstName, lastName],
        firstLastKey,
      }
    }
  }

  const normalized = normalizeNameForSearch(fullName)
  const parts = normalized.split(' ').filter(p => p.length > 0)
  if (parts.length === 0) {
    return { firstName: '', lastName: '', allParts: [], firstLastKey: '' }
  }
  const firstName = parts[0]
  const lastName = parts[parts.length - 1]
  const allParts = parts.filter((p, i) => i === 0 || i === parts.length - 1)
  const firstLastKey = [firstName, lastName].sort().join('|').toLowerCase()
  return { firstName, lastName, allParts, firstLastKey }
}

/**
 * Levenshtein edit distance (for fuzzy first-name matching: Lakeysha vs Lekeysha vs Leteysha)
 */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/**
 * Build insured name from AMAM policy fields to match DDF format: "First MI Last" (e.g. "Martha J Klar")
 */
function buildAmamInsuredName(p: { firstname?: string | null; lastname?: string | null; mi?: string | null }): string {
  const first = p.firstname?.trim() ?? ''
  const last = p.lastname?.trim() ?? ''
  const mi = p.mi?.trim() ?? ''
  const parts = first ? [first, mi, last].filter(Boolean) : [mi, last].filter(Boolean)
  return parts.join(' ').trim() || ''
}

function appendPreferredDealCreationDate(
  map: Map<string, string | null>,
  rawName: string | null | undefined,
  candidateDate: string | null | undefined,
) {
  const normalized = normalizeNameForSearch(rawName || '')
  if (!normalized) return
  const current = map.get(normalized) ?? null
  if (!current && candidateDate) {
    map.set(normalized, candidateDate)
  } else if (!map.has(normalized)) {
    map.set(normalized, null)
  }
}


/**
 * When running in browser, DDF is fetched via our API to avoid CORS with external Supabase.
 * Chunks large requests to prevent timeouts.
 */
async function fetchDdfViaApi(
  insuredNames: string[],
  carrier: string,
  dealCreationDateByName?: Map<string, string | null>,
): Promise<Map<string, DailyDealFlowInfo>> {
  const CHUNK_SIZE = 200 // Process 200 names per request to avoid timeouts
  const allResults = new Map<string, DailyDealFlowInfo>()
  
  if (insuredNames.length > CHUNK_SIZE) {
    console.log(`[Deal Tracker] Chunking DDF fetch: ${insuredNames.length} names into ${Math.ceil(insuredNames.length / CHUNK_SIZE)} requests`)
  }
  
  // Chunk the names array
  for (let i = 0; i < insuredNames.length; i += CHUNK_SIZE) {
    const chunk = insuredNames.slice(i, i + CHUNK_SIZE)
    const items = chunk.map((name) => {
      const normalized = normalizeNameForSearch(name)
      const date = dealCreationDateByName?.get(normalized) ?? null
      return { key: normalized, name, dealCreationDate: date }
    })
    const res = await fetch('/api/ddf-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrier, items }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('[Deal Tracker] DDF API error:', data.error || res.statusText)
      throw new Error(data.error || `DDF lookup failed: ${res.status}`)
    }
    const results = data.results || {}
    Object.entries(results).forEach(([k, v]) => {
      const val =
        (v as { call_center?: string | null; phone_number?: string | null; draft_date?: string | null; lead_name?: string | null }) || {}
      allResults.set(normalizeNameForSearch(k), {
        call_center: val.call_center ?? null,
        phone_number: val.phone_number ?? null,
        draft_date: val.draft_date ?? null,
        lead_name: val.lead_name ?? null,
      })
    })
    const withData = Object.values(results).filter((v: any) => v?.call_center || v?.phone_number).length
    if (chunk.length > 0 && withData === 0) {
      console.warn('[Deal Tracker] DDF API returned no call_center/phone for', chunk.length, 'names (carrier:', carrier, '). Check server logs for [ddf-lookup] and that external DDF has rows for this carrier.')
    }
    
    // Log progress for large batches
    if (insuredNames.length > CHUNK_SIZE) {
      console.log(`[Deal Tracker] DDF fetch progress: ${Math.min(i + CHUNK_SIZE, insuredNames.length)}/${insuredNames.length} names`)
    }
  }
  
  return allResults
}

const DDF_FETCH_LIMIT = 5000
/** Supabase project default max rows per request; we paginate to get more */
const SUPABASE_PAGE_SIZE = 1000

/**
 * Fetch all rows by paginating with .range(from, to).
 * queryFactory() must return a query with .order() so range is deterministic.
 */
export async function fetchAllPaginated<T = any>(queryFactory: () => any): Promise<T[]> {
  const acc: T[] = []
  let from = 0
  while (true) {
    const to = from + SUPABASE_PAGE_SIZE - 1
    const { data, error } = await queryFactory().range(from, to)
    if (error) throw error
    const chunk = (data ?? []) as T[]
    acc.push(...chunk)
    if (chunk.length < SUPABASE_PAGE_SIZE) break
    from = to + 1
  }
  return acc
}

/**
 * Fetch raw daily_deal_flow rows for a carrier (server-side only).
 * Exported for /api/ddf-lookup to cache and reuse across chunked requests.
 */
export async function getDdfRecordsForCarrier(
  externalSupabase: ReturnType<typeof createClient>,
  carrier: string,
  tableName: string = 'daily_deal_flow',
): Promise<{
  insured_name?: string | null
  lead_vendor?: string | null
  lead_vendor_name?: string | null
  client_phone_number?: string | null
  phone_number?: string | null
  carrier?: string | null
  draft_date?: string | null
}[]> {
  const carrierUpper = (carrier || '').toUpperCase()
  const isAmam = carrierUpper === 'AMAM' || carrierUpper === 'ANAM' || carrierUpper.includes('AMERICAN AMICABLE')
  // External DDF table may not have lead_vendor_name or phone_number; use only columns that exist there
  let query = externalSupabase
    .from(tableName)
    .select('insured_name, lead_vendor, client_phone_number, carrier, draft_date')
    .order('created_at', { ascending: false })
    .limit(DDF_FETCH_LIMIT)
  if (isAmam) {
    query = query.or('carrier.ilike.%AMAM%,carrier.ilike.%ANAM%,carrier.ilike.%American%')
  } else if (carrierUpper === 'LIBERTY') {
    query = query.ilike('carrier', '%Liberty%')
  } else if (carrierUpper === 'COREBRIDGE') {
    query = query.ilike('carrier', '%Corebridge%')
  } else {
    query = query.ilike('carrier', carrier)
  }
  const { data, error } = await query
  if (error || !data) return []
  return data as {
    insured_name?: string | null
    lead_vendor?: string | null
    lead_vendor_name?: string | null
    client_phone_number?: string | null
    phone_number?: string | null
    carrier?: string | null
    draft_date?: string | null
  }[]
}

/**
 * Match insured names against already-fetched DDF records. Used by API with cached records.
 */
export function matchDdfNamesToRecords(
  allRecords: {
    insured_name?: string | null
    lead_vendor?: string | null
    lead_vendor_name?: string | null
    client_phone_number?: string | null
    phone_number?: string | null
    draft_date?: string | null
  }[],
  insuredNames: string[]
): Map<string, DailyDealFlowInfo> {
  const resultMap = new Map<string, DailyDealFlowInfo>()
  if (!insuredNames?.length || !allRecords?.length) return resultMap

  const normalizedNames = insuredNames.map(n => normalizeNameForSearch(n))
  // Use original names for extractNameParts so "Last, First MI" (e.g. HART, RAYMOND L) is parsed correctly
  const nameParts = insuredNames.map(n => extractNameParts((n ?? '').trim()))
  type DailyDealFlowRecord = typeof allRecords[0]
  const getCallCenter = (r: DailyDealFlowRecord): string | null =>
    ((r.lead_vendor ?? r.lead_vendor_name ?? null) && String(r.lead_vendor ?? r.lead_vendor_name ?? '').trim()) || null
  const getPhone = (r: DailyDealFlowRecord): string | null =>
    ((r.client_phone_number ?? r.phone_number ?? null) && String(r.client_phone_number ?? r.phone_number ?? '').trim()) || null
  const hasContact = (r: DailyDealFlowRecord) => !!(getCallCenter(r) || getPhone(r))
  const hasDraft = (r: DailyDealFlowRecord) => {
    const d = r.draft_date
    return d != null && String(d).trim() !== ''
  }
  const pickBestMatch = (matches: DailyDealFlowRecord[]): DailyDealFlowRecord | null => {
    if (!matches?.length) return null
    const both = matches.find(r => hasContact(r) && hasDraft(r))
    if (both) return both
    const withDraft = matches.find(hasDraft)
    if (withDraft) return withDraft
    const withData = matches.find(hasContact)
    return withData ?? matches[0]
  }
  const exactMap = new Map<string, DailyDealFlowRecord[]>()
  const firstLastMap = new Map<string, DailyDealFlowRecord[]>()
  const firstNameMap = new Map<string, DailyDealFlowRecord[]>()
  const lastNameMap = new Map<string, DailyDealFlowRecord[]>()
  for (const record of allRecords as DailyDealFlowRecord[]) {
    const recordName = normalizeNameForSearch(record.insured_name || '')
    const recordParts = extractNameParts(recordName)
    if (recordName) {
      if (!exactMap.has(recordName)) exactMap.set(recordName, [])
      exactMap.get(recordName)!.push(record)
    }
    if (recordParts.firstName && recordParts.lastName) {
      const key = recordParts.firstLastKey
      if (!firstLastMap.has(key)) firstLastMap.set(key, [])
      firstLastMap.get(key)!.push(record)
    }
    if (recordParts.firstName) {
      const key = recordParts.firstName.toLowerCase()
      if (!firstNameMap.has(key)) firstNameMap.set(key, [])
      firstNameMap.get(key)!.push(record)
    }
    if (recordParts.lastName) {
      const key = recordParts.lastName.toLowerCase()
      if (!lastNameMap.has(key)) lastNameMap.set(key, [])
      lastNameMap.get(key)!.push(record)
    }
  }
  for (let i = 0; i < normalizedNames.length; i++) {
    const normalizedName = normalizedNames[i]
    const parts = nameParts[i]
    let bestMatch: DailyDealFlowRecord | null = null
    let bestScore = 0
    const exactMatches = exactMap.get(normalizedName)
    if (exactMatches?.length) {
      bestMatch = pickBestMatch(exactMatches)
      bestScore = 100
    } else if (parts.firstName && parts.lastName && parts.firstLastKey) {
      const matches = firstLastMap.get(parts.firstLastKey)
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 80
      }
    }
    if (!bestMatch && parts.firstName && parts.lastName) {
      const lastNameKey = parts.lastName.toLowerCase()
      const lastMatches = lastNameMap.get(lastNameKey)
      if (lastMatches?.length) {
        const policyFirst = parts.firstName.toLowerCase()
        const fuzzyMatches = lastMatches.filter(r => {
          const rName = normalizeNameForSearch(r.insured_name || '')
          const rParts = extractNameParts(rName)
          const rFirst = (rParts.firstName || '').toLowerCase()
          return rFirst.length > 0 && editDistance(policyFirst, rFirst) <= 2
        })
        if (fuzzyMatches.length) {
          bestMatch = pickBestMatch(fuzzyMatches)
          bestScore = 55
        }
      }
    }
    if (!bestMatch && parts.firstName) {
      const matches = firstNameMap.get(parts.firstName.toLowerCase())
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 60
      }
    }
    if (!bestMatch && parts.lastName) {
      const matches = lastNameMap.get(parts.lastName.toLowerCase())
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 50
      }
    }
    if (!bestMatch && parts.firstName && parts.lastName) {
      const policyFirst = parts.firstName.toLowerCase()
      const policyLast = parts.lastName.toLowerCase()
      const fuzzyBoth = (allRecords as DailyDealFlowRecord[]).filter(r => {
        const rName = normalizeNameForSearch(r.insured_name || '')
        const rParts = extractNameParts(rName)
        const rFirst = (rParts.firstName || '').toLowerCase()
        const rLast = (rParts.lastName || '').toLowerCase()
        if (!rFirst || !rLast) return false
        return editDistance(policyFirst, rFirst) <= 2 && editDistance(policyLast, rLast) <= 2
      })
      if (fuzzyBoth.length) {
        bestMatch = pickBestMatch(fuzzyBoth)
        bestScore = 52
      }
    }
    if (bestMatch && bestScore >= 50) {
      resultMap.set(normalizedName, {
        call_center: getCallCenter(bestMatch) ?? null,
        phone_number: getPhone(bestMatch) ?? null,
        draft_date: bestMatch.draft_date != null ? String(bestMatch.draft_date).trim() : null,
        lead_name: bestMatch.insured_name != null ? String(bestMatch.insured_name).trim() : null,
      })
    }
  }
  return resultMap
}

/**
 * Bulk fetch daily_deal_flow records (server-side implementation).
 * Exported for use by /api/ddf-lookup so the browser never calls external Supabase (avoids CORS).
 */
export async function doBulkFetchDailyDealFlowInfo(
  externalSupabase: ReturnType<typeof createClient>,
  insuredNames: string[],
  carrier: string
): Promise<Map<string, DailyDealFlowInfo>> {
  const resultMap = new Map<string, DailyDealFlowInfo>()
  if (!insuredNames || insuredNames.length === 0) return resultMap

  try {
    const normalizedNames = insuredNames.map(n => normalizeNameForSearch(n))
    // Use original names for extractNameParts so "Last, First MI" (e.g. HART, RAYMOND L) matches "Raymond Lee Hart"
    const nameParts = insuredNames.map(n => extractNameParts((n ?? '').trim()))
    
    console.log('[Deal Tracker] Bulk fetching daily_deal_flow for carrier:', carrier, 'names:', normalizedNames.length)
    
    // STEP 1: Fetch DDF records for carrier (getDdfRecordsForCarrier only – no direct query here)
    console.log('[Deal Tracker] Step 1: Filtering daily_deal_flow records by carrier:', carrier)
    const ddfRecords = await getDdfRecordsForCarrier(externalSupabase, carrier)
    if (!ddfRecords || ddfRecords.length === 0) {
      console.log('[Deal Tracker] No daily_deal_flow records found for carrier:', carrier)
      return resultMap
    }

    // Type assertion for external database records
    type DailyDealFlowRecord = {
      insured_name?: string | null
      lead_vendor?: string | null
      lead_vendor_name?: string | null
      client_phone_number?: string | null
      phone_number?: string | null
      carrier?: string | null
      draft_date?: string | null
    }
    const typedRecords = ddfRecords as DailyDealFlowRecord[]
    const getCallCenter = (r: DailyDealFlowRecord) =>
      (r.lead_vendor ?? r.lead_vendor_name ?? null) && String(r.lead_vendor ?? r.lead_vendor_name ?? '').trim() || null
    const getPhone = (r: DailyDealFlowRecord) =>
      (r.client_phone_number ?? r.phone_number ?? null) && String(r.client_phone_number ?? r.phone_number ?? '').trim() || null
    const hasContact = (r: DailyDealFlowRecord) => !!(getCallCenter(r) || getPhone(r))
    const hasDraft = (r: DailyDealFlowRecord) => {
      const d = r.draft_date
      return d != null && String(d).trim() !== ''
    }
    const pickBestMatch = (matches: DailyDealFlowRecord[]): DailyDealFlowRecord | null => {
      if (!matches?.length) return null
      const both = matches.find(r => hasContact(r) && hasDraft(r))
      if (both) return both
      const withDraft = matches.find(hasDraft)
      if (withDraft) return withDraft
      const withData = matches.find(hasContact)
      return withData ?? matches[0]
    }
    const exactMap = new Map<string, DailyDealFlowRecord[]>()
    const firstLastMap = new Map<string, DailyDealFlowRecord[]>()
    const firstNameMap = new Map<string, DailyDealFlowRecord[]>()
    const lastNameMap = new Map<string, DailyDealFlowRecord[]>()
    // Build lookup maps from records (O(n) instead of O(n*m) later)
    for (const record of typedRecords) {
      const recordName = normalizeNameForSearch(record.insured_name || '')
      const recordParts = extractNameParts(recordName)
      
      // Exact match map
      if (recordName) {
        if (!exactMap.has(recordName)) exactMap.set(recordName, [])
        exactMap.get(recordName)!.push(record)
      }
      
      // First + Last map (canonical key so "Diane Walker" and "Walker, Diane" match)
      if (recordParts.firstName && recordParts.lastName && recordParts.firstLastKey) {
        const key = recordParts.firstLastKey
        if (!firstLastMap.has(key)) firstLastMap.set(key, [])
        firstLastMap.get(key)!.push(record)
      }
      
      // First name map
      if (recordParts.firstName) {
        const key = recordParts.firstName.toLowerCase()
        if (!firstNameMap.has(key)) firstNameMap.set(key, [])
        firstNameMap.get(key)!.push(record)
      }
      
      // Last name map
      if (recordParts.lastName) {
        const key = recordParts.lastName.toLowerCase()
        if (!lastNameMap.has(key)) lastNameMap.set(key, [])
        lastNameMap.get(key)!.push(record)
      }
    }

    console.log('[Deal Tracker] Step 2 complete: Lookup maps built from carrier-filtered records')
    
    // STEP 3: Match each policy name using lookup maps (only matches within carrier-filtered records)
    console.log('[Deal Tracker] Step 3: Matching', normalizedNames.length, 'names against carrier-filtered records...')
    let strategyUsed: string = 'none'
    for (let i = 0; i < normalizedNames.length; i++) {
      const normalizedName = normalizedNames[i]
      const parts = nameParts[i]
      strategyUsed = 'none'

      let bestMatch: any = null
      let bestScore = 0

      // Strategy 1: Exact match (highest priority)
      const exactMatches = exactMap.get(normalizedName)
      if (exactMatches && exactMatches.length > 0) {
        bestMatch = pickBestMatch(exactMatches)
        bestScore = 100
      }
      // Strategy 2: First + Last name match (canonical key for "First Last" vs "Last, First")
      else if (parts.firstName && parts.lastName && parts.firstLastKey) {
        const matches = firstLastMap.get(parts.firstLastKey)
        if (matches && matches.length > 0) {
          bestMatch = pickBestMatch(matches)
          bestScore = 80
        }
      }
      // Strategy 2b: Last name + fuzzy first name (handles typos: Lakeysha vs Lekeysha vs Leteysha)
      if (!bestMatch && parts.firstName && parts.lastName) {
        const lastNameKey = parts.lastName.toLowerCase()
        const lastMatches = lastNameMap.get(lastNameKey)
        if (lastMatches && lastMatches.length > 0) {
          const policyFirst = parts.firstName.toLowerCase()
          const fuzzyMatches = lastMatches.filter((r: DailyDealFlowRecord) => {
            const rName = normalizeNameForSearch(r.insured_name || '')
            const rParts = extractNameParts(rName)
            const rFirst = (rParts.firstName || '').toLowerCase()
            return rFirst.length > 0 && editDistance(policyFirst, rFirst) <= 2
          })
          if (fuzzyMatches.length > 0) {
            bestMatch = pickBestMatch(fuzzyMatches)
            bestScore = 55
            strategyUsed = 'fuzzyFirst'
          }
        }
      }
      // Strategy 3: First name match
      else if (parts.firstName) {
        const key = parts.firstName.toLowerCase()
        const matches = firstNameMap.get(key)
        if (matches && matches.length > 0) {
          bestMatch = pickBestMatch(matches)
          bestScore = 60
        }
      }
      // Strategy 4: Last name match
      else if (parts.lastName) {
        const key = parts.lastName.toLowerCase()
        const matches = lastNameMap.get(key)
        if (matches && matches.length > 0) {
          bestMatch = pickBestMatch(matches)
          bestScore = 50
        }
      }

      // Only use match if score is reasonable (>= 50)
      if (bestMatch && bestScore >= 50) {
        resultMap.set(normalizedName, {
          call_center: getCallCenter(bestMatch) ?? null,
          phone_number: getPhone(bestMatch) ?? null,
          draft_date: bestMatch.draft_date != null ? String(bestMatch.draft_date).trim() : null,
          lead_name: bestMatch.insured_name != null ? String(bestMatch.insured_name).trim() : null,
        })
      }
    }

    console.log('[Deal Tracker] Bulk fetch matched', resultMap.size, 'out of', normalizedNames.length, 'names')
    return resultMap
  } catch (error) {
    console.error('[Deal Tracker] Error in bulk fetch:', error)
    return resultMap
  }
}

/**
 * Bulk fetch daily_deal_flow records for multiple insured names at once.
 * In the browser we call /api/ddf-lookup (server proxy) to avoid CORS with external Supabase.
 */
export async function bulkFetchDailyDealFlowInfo(
  insuredNames: string[],
  carrier: string,
  dealCreationDateByName?: Map<string, string | null>,
): Promise<Map<string, DailyDealFlowInfo>> {
  if (!insuredNames || insuredNames.length === 0) {
    return new Map()
  }
  if (typeof window !== 'undefined') {
    return fetchDdfViaApi(insuredNames, carrier, dealCreationDateByName)
  }

  const out = new Map<string, DailyDealFlowInfo>()
  const { client, table } = getDdfClient('new')
  const fresh = await getDdfRecordsForCarrier(client, carrier, table)
  const matched = matchDdfNamesToRecords(fresh, insuredNames)
  matched.forEach((v, k) => out.set(k, v))
  return out
}

/**
 * Fetch call center and phone number from daily_deal_flow table (single lookup)
 * Uses flexible name matching to handle variations in name formatting
 * NOTE: For bulk operations, use bulkFetchDailyDealFlowInfo instead
 */
export async function fetchDailyDealFlowInfo(
  insuredName: string | null,
  carrier: string
): Promise<{ call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }> {
  if (!insuredName) {
    return { call_center: null, phone_number: null, draft_date: null, lead_name: null }
  }

  try {
    const externalSupabase = getExternalSupabaseClient()
    const normalizedName = normalizeNameForSearch(insuredName)
    const { firstName, lastName, allParts } = extractNameParts(normalizedName)
    
    console.log('[Deal Tracker] Searching daily_deal_flow:', {
      originalName: insuredName,
      normalizedName,
      firstName,
      lastName,
      carrier,
    })

    // Try multiple search strategies for better matching
    // Note: Carrier name might be "Aetna" in daily_deal_flow, so try both exact and case-insensitive
    let data: any = null
    let error: any = null

    // Strategy 1: Try exact match first (case-insensitive, full name)
    console.log('[Deal Tracker] Strategy 1: Exact match')
    let result = await externalSupabase
      .from('daily_deal_flow')
      .select('insured_name, lead_vendor, client_phone_number, draft_date')
      .ilike('insured_name', normalizedName)
      .ilike('carrier', carrier) // Case-insensitive carrier match
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!result.error && result.data) {
      data = result.data
      error = null
    }

    // Strategy 2: Try with partial name match (first + last)
    if ((error || !data) && firstName && lastName && firstName !== lastName) {
      console.log('[Deal Tracker] Strategy 2: First + Last name match')
      const firstLastPattern = `${firstName}%${lastName}`
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('insured_name, lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', firstLastPattern)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 3: Try partial match with first name
    if ((error || !data) && firstName && firstName.length > 2) {
      console.log('[Deal Tracker] Strategy 3: First name partial match')
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('insured_name, lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', `${firstName}%`)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 4: Try last name match
    if ((error || !data) && lastName && lastName.length > 2) {
      console.log('[Deal Tracker] Strategy 4: Last name match')
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('insured_name, lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', `%${lastName}`)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 5: Try fuzzy match with any significant name part
    if ((error || !data) && allParts.length > 0) {
      console.log('[Deal Tracker] Strategy 5: Fuzzy match with name parts')
      for (const part of allParts) {
        if (part.length > 2) {
          result = await externalSupabase
            .from('daily_deal_flow')
            .select('insured_name, lead_vendor, client_phone_number, draft_date')
            .ilike('insured_name', `%${part}%`)
            .ilike('carrier', carrier)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          
          if (!result.error && result.data) {
            data = result.data
            error = null
            break
          }
        }
      }
    }

    if (error || !data) {
      console.warn(
        `[Deal Tracker] No daily_deal_flow entry found after all strategies for insured_name: ${insuredName}, carrier: ${carrier}`
      )
      return { call_center: null, phone_number: null, draft_date: null, lead_name: null }
    }

    // Type assertion for external database response
    const ddfData = data as { insured_name?: string | null; lead_vendor?: string | null; client_phone_number?: string | null; draft_date?: string | null } | null

    console.log('[Deal Tracker] Found daily_deal_flow match:', {
      insuredName,
      call_center: ddfData?.lead_vendor,
      phone_number: ddfData?.client_phone_number,
    })

    return {
      call_center: ddfData?.lead_vendor || null,
      phone_number: ddfData?.client_phone_number || null,
      draft_date: ddfData?.draft_date != null ? String(ddfData.draft_date).trim() : null,
      lead_name: ddfData?.insured_name != null ? String(ddfData.insured_name).trim() : null,
    }
  } catch (error) {
    console.error('[Deal Tracker] Error fetching daily_deal_flow info:', error)
    return { call_center: null, phone_number: null, draft_date: null, lead_name: null }
  }
}

/**
 * Process Aetna commission files and update deal tracker entries
 * Updates existing entries with commission data, or creates new ones if policy exists
 */
export async function processAetnaCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  /** In-memory rows when upload deferred commission insert until Commission Report Save */
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAetnaCommissionsForDealTracker called', {
    agencyCarrierId,
    fileId,
    fromMemory: !!(commissionsOverride && commissionsOverride.length > 0),
  })

  // Get carrier information
  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AETNA'
  const carrierCode = carrier.code || 'AETNA'
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    console.log('[Deal Tracker] Using in-memory Aetna commission rows (deferred DB write)...')
    commissions = commissionsOverride as any[]
  } else {
    console.log('[Deal Tracker] Fetching commissions from aetna_commissions...')
    const { data: fetched, error: commissionsError } = await supabase
      .from('aetna_commissions')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .eq('file_id', fileId)

    if (commissionsError) {
      console.error('[Deal Tracker] Error fetching commissions:', commissionsError)
      throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
    }

    if (!fetched || fetched.length === 0) {
      console.warn('[Deal Tracker] No commissions found for file_id:', fileId)
      return []
    }
    commissions = fetched
  }

  console.log('[Deal Tracker] Commissions found:', commissions.length)

  // Get unique policy numbers from commissions
  const policyNumbers = Array.from(new Set(commissions.map(c => c.policy_number)))
  
  // Fetch existing deal_tracker entries for these policy numbers
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing entries:', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    const typedExistingEntries = existingEntries as Array<{ policy_number: string }>
    typedExistingEntries.forEach((entry) => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  // Group commissions by policy_number
  // For deal_value, we should SUM all commission amounts for the same policy
  // But keep the latest commission for other fields (sales_agent, writing_number, etc.)
  const commissionMap = new Map<string, any>()
  const commissionPositiveMap = new Map<string, number>() // Sum of positive commission amounts
  const commissionChargebackMap = new Map<string, number>() // Sum of negative commission amounts (<= 0)
  
  commissions.forEach(comm => {
    const policyNum = comm.policy_number
    if (!policyNum) {
      console.warn('[Deal Tracker] Skipping commission with no policy_number:', comm.id)
      return
    }
    
    const existing = commissionMap.get(policyNum)
    
    // Sum commission amounts, separating positive and negative (chargebacks)
    const commAmount = comm.commissionamount != null 
      ? (typeof comm.commissionamount === 'string' ? parseFloat(comm.commissionamount) : comm.commissionamount)
      : 0
    if (!isNaN(commAmount)) {
      if (commAmount > 0) {
        const currentPos = commissionPositiveMap.get(policyNum) || 0
        commissionPositiveMap.set(policyNum, currentPos + commAmount)
      } else if (commAmount < 0) {
        const currentCb = commissionChargebackMap.get(policyNum) || 0
        commissionChargebackMap.set(policyNum, currentCb + commAmount)
      }
    }
    
    // Use latest commission for other fields (sales_agent, writing_number, etc.)
    if (!existing || (comm.created_at && existing.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })
  
  console.log('[Deal Tracker] Commission aggregation complete:', {
    uniquePolicies: commissionMap.size,
    totalCommissions: commissions.length,
    samplePositive: Array.from(commissionPositiveMap.entries()).slice(0, 5).map(([pn, amt]) => ({ policy: pn, amount: amt })),
    sampleChargebacks: Array.from(commissionChargebackMap.entries()).slice(0, 5).map(([pn, amt]) => ({ policy: pn, amount: amt })),
  })

  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(
    pn => !existingMap.has(pn)
  )

  const allCommissionPolicyNumbers = Array.from(commissionMap.keys())
  let policiesMap = new Map<string, any>()
  if (allCommissionPolicyNumbers.length > 0) {
    console.log('[Deal Tracker] Batch fetching aetna_policies for', allCommissionPolicyNumbers.length, 'policy numbers...')
    const { data: policies, error: policiesError } = await supabase
      .from('aetna_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', allCommissionPolicyNumbers)

    if (!policiesError && policies) {
      const typedPolicies = policies as Array<{ policy_number: string }>
      typedPolicies.forEach((p) => {
        policiesMap.set(p.policy_number, p)
      })
      console.log('[Deal Tracker] Found', policies.length, 'policy rows for commission batch')
    }
  }

  // Bulk fetch status mappings, GHL mappings, and daily_deal_flow.
  // GHL mappings are needed for BOTH existing-entry updates and new entries so
  // commission financial changes (e.g. 0 -> positive) can move stages correctly.
  // DDF draft_date is required for ACTIVE 3M+ — fetch names for every commission policy (existing + new).
  let statusMappingMap = new Map<string, string>()
  let ghlStageMappingMap = new Map<string, string[]>()
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  if (missingPolicyNumbers.length > 0) {
    statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  }
  const policyNamesForDDF = Array.from(
    new Set(
      allCommissionPolicyNumbers
        .map(pn => {
          const p = policiesMap.get(pn)
          const ex = existingMap.get(pn)
          return (p?.insuredname || ex?.name || '').trim()
        })
        .filter((n): n is string => n.length > 0)
    )
  )
  if (policyNamesForDDF.length > 0) {
    const dealCreationDateByName = new Map<string, string | null>()
    allCommissionPolicyNumbers.forEach((pn) => {
      const p = policiesMap.get(pn)
      const ex = existingMap.get(pn)
      const name = (p?.insuredname || ex?.name || '').trim()
      const date = ex?.deal_creation_date ?? p?.apprecddate ?? p?.issuedate ?? null
      appendPreferredDealCreationDate(dealCreationDateByName, name, date)
    })
    dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName, dealCreationDateByName)
  }

  // Create preview entries for updates/new entries
  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    
    // Calculate financials for this policy:
    // - deal_value: sum of POSITIVE commissions. If that sum is <= 0 and there is an existing row,
    //   KEEP the existing deal_value (do not overwrite with a negative or zero).
    // - charge_back: sum of NEGATIVE commissions (can be null if none).
    const positiveAmount = commissionPositiveMap.get(policyNumber)
    const chargeBack: number | null = commissionChargebackMap.get(policyNumber) ?? null
    let dealValue: number | null
    if (positiveAmount != null && positiveAmount > 0) {
      dealValue = positiveAmount
    } else if (existing && existing.deal_value != null) {
      // No positive commissions in this batch – preserve prior deal_value
      dealValue =
        typeof existing.deal_value === 'number'
          ? existing.deal_value
          : parseFloat(String(existing.deal_value))
    } else {
      dealValue = null
    }
    const ccValue: number | null =
      dealValue !== null && dealValue !== undefined ? dealValue / 2 : null

    console.log(`[Deal Tracker] Processing commission for policy ${policyNumber}:`, {
      existing: !!existing,
      dealValue,
      ccValue,
      singleCommissionAmount: commission.commissionamount,
      positiveAmount,
      chargeBack,
    })

    if (existing) {
      // Update existing entry - policy_status stays from mapping; status considers deal_value and charge_back
      const effectiveChargeBack = chargeBack ?? existing.charge_back ?? null
      const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)
      const policyRow = policiesMap.get(policyNumber)
      const normalizedName = normalizeNameForSearch(policyRow?.insuredname || existing.name || '')
      const draftFromDdf = dailyDealFlowMap.get(normalizedName)?.draft_date ?? null
      const carrierForRoll =
        policyRow?.statusdisplaytext ||
        policyRow?.statuscategory ||
        existing.carrier_status ||
        null
      const mergedEffective = mergeEffectiveDateWithPendingRoll(
        carrierForRoll,
        existing.policy_status ?? null,
        existing.effective_date,
        draftFromDdf,
        commission.effectivedate,
      )
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierForRoll ?? existing.carrier_status ?? null,
        allMappings: ghlStageMappingMap,
        effectiveDate: mergedEffective,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(
          existing,
          mergedEffective,
        ),
        dealCreationDate:
          existing.deal_creation_date ??
          policyRow?.apprecddate ??
          policyRow?.issuedate ??
          null,
        dealValue,
        chargeBack: effectiveChargeBack,
        commissionType: commission.commissiontype || existing.commission_type || null,
        existingGhlStage: existing.ghl_stage ?? null,
        carrierCode,
      })
      const entry: DealTrackerPreviewEntry = {
        ...existing,
        ghl_stage: mappedGhlStage ?? existing.ghl_stage,
        carrier_status: existing.carrier_status ?? null,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        policy_status: existing.policy_status,
        status: derivedStatus,
        sales_agent: existing.sales_agent ?? null,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
        effective_date: mergedEffective,
        source_commission_table: 'aetna_commissions',
        source_commission_id: commission.id != null ? commission.id : null,
        isNew: false,
        isUpdated: true,
      }
      const newSnapshot = {
        ...existing,
        ghl_stage: mappedGhlStage ?? existing.ghl_stage,
        carrier_status: existing.carrier_status ?? null,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        status: derivedStatus,
        sales_agent: existing.sales_agent ?? null,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
        effective_date: mergedEffective,
      } as Record<string, unknown>
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as Record<string, unknown>, newSnapshot)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
      previewEntries.push(entry)
    } else {
      // Check if policy exists (to create new deal_tracker entry)
      const policy = policiesMap.get(commission.policy_number)
      
      if (policy) {
        // Policy exists but no deal_tracker entry - create new one
        const originalStatus = policy.statusdisplaytext || policy.statuscategory
        const mappedStatus =
          lookupMappedStageMonday(statusMappingMap, originalStatus) ?? originalStatus ?? null

        // Get daily_deal_flow info from bulk fetch map
        const normalizedName = normalizeNameForSearch(policy.insuredname || '')
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        const callCenter = ddfInfo?.call_center || null
        const phoneNumber = ddfInfo?.phone_number || null
        const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

        const proposedEff = mergeEffectiveDateWithPendingRoll(
          originalStatus || null,
          mappedStatus,
          null,
          effectiveDateFromDdf,
          commission.effectivedate,
        )
        const mappedGhlStage = resolveGhlStage({
          carrierStatus: originalStatus || null,
          allMappings: ghlStageMappingMap,
          effectiveDate: proposedEff,
          effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(null, proposedEff),
          dealCreationDate: policy.apprecddate || policy.issuedate || null,
          dealValue,
          chargeBack,
          commissionType: commission.commissiontype || null,
          existingGhlStage: null,
          carrierCode,
        })

        const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
        const entry: DealTrackerPreviewEntry = {
          agency_carrier_id: agencyCarrierId,
          name: policy.insuredname || null,
          tasks: null,
          ghl_name: ddfInfo?.lead_name ?? null,
          ghl_stage: mappedGhlStage,
          policy_status: mappedStatus,
          deal_creation_date: policy.apprecddate || policy.issuedate || null,
          policy_number: commission.policy_number,
          carrier: carrierName,
          carrier_id: carrier.id,
          deal_value: dealValue,
          cc_value: ccValue,
          charge_back: chargeBack,
          notes: null,
          status: derivedStatus,
          last_updated: new Date().toISOString(),
          sales_agent: policy.agentcompletename || commission.writingagentname || null,
          writing_number: policy.agentnumber || commission.writingagentnumber || null,
          commission_type: commission.commissiontype || null,
          effective_date: proposedEff,
          call_center: callCenter,
          phone_number: phoneNumber,
          cc_pmt_ws: null,
          cc_cb_ws: null,
          carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
          policy_type: policy.product || null,
          daily_deal_flow_fetched: !!callCenter || !!phoneNumber,
          daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
          source_policy_table: 'aetna_policies',
          source_policy_id: policy.id,
          source_commission_table: 'aetna_commissions',
          source_commission_id: commission.id != null ? commission.id : null,
          isNew: true,
          isUpdated: false,
        }
        previewEntries.push(entry)
      }
      // If no policy exists, skip (can't create deal_tracker entry without policy)
    }
  }

  console.log('[Deal Tracker] Commission processing complete:', {
    totalEntries: previewEntries.length,
    newEntries: previewEntries.filter(e => e.isNew).length,
    updatedEntries: previewEntries.filter(e => e.isUpdated && !e.isNew).length,
    sampleEntries: previewEntries.slice(0, 3).map(e => ({
      policy_number: e.policy_number,
      isNew: e.isNew,
      isUpdated: e.isUpdated,
      deal_value: e.deal_value,
      cc_value: e.cc_value,
    })),
  })
  return previewEntries
}

/**
 * Process Aetna carrier files and create deal tracker entries
 */
export async function processAetnaFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAetnaFilesForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  // Get carrier information
  console.log('[Deal Tracker] Fetching agency_carrier info...')
  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AETNA'
  const carrierCode = carrier.code || 'AETNA'
  const carrierId = carrier.id // UUID from carriers table - use this for status mapping

  console.log('[Deal Tracker] Carrier info:', {
    carrierName,
    carrierCode,
    carrierId,
    agencyCarrierId,
  })

  // Fetch all policies from the uploaded file (paginated to exceed Supabase 1000-row default)
  console.log('[Deal Tracker] Fetching policies from aetna_policies...')
  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('aetna_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  console.log('[Deal Tracker] Policies found:', { count: policies?.length || 0, fileId, agencyCarrierId })

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)

  let existingEntries: any[] = []
  try {
    existingEntries = await fetchAllPaginated(() =>
      supabase
        .from('deal_tracker')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (existingError: any) {
    console.warn(`Failed to fetch existing entries: ${existingError?.message}`)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  // OPTIMIZATION: Bulk fetch status + GHL mappings once (instead of querying for each policy)
  console.log('[Deal Tracker] Bulk fetching status + GHL mappings...')
  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  console.log(
    '[Deal Tracker] Status mappings loaded:',
    statusMappingMap.size,
    'status mappings; GHL mappings:',
    ghlStageMappingMap.size
  )

  // BULK FETCH DDF when contact or effective_date is missing (need draft_date from external DDF)
  const policiesNeedingDdf = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
  const uniqueInsuredNames = Array.from(new Set(
    policiesNeedingDdf.map(p => (p.insuredname || '').trim()).filter(n => n.length > 0)
  ))
  const dealCreationDateByName = new Map<string, string | null>()
  policiesNeedingDdf.forEach((p) => {
    const existing = existingMap.get(p.policy_number)
    const date = existing?.deal_creation_date ?? p.apprecddate ?? p.issuedate ?? null
    appendPreferredDealCreationDate(dealCreationDateByName, p.insuredname, date)
  })
  const skipCount = policies.length - policiesNeedingDdf.length
  console.log('[Deal Tracker] Bulk fetching daily_deal_flow for', uniqueInsuredNames.length, 'names (skip', skipCount, 'policies already have call_center/phone)...')
  const dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, carrierName, dealCreationDateByName)
  console.log('[Deal Tracker] Bulk fetch complete. Found matches for', dailyDealFlowMap.size, 'out of', uniqueInsuredNames.length, 'names')

  // Process each policy and create deal tracker entries
  console.log('[Deal Tracker] Processing', policies.length, 'policies...')
  const previewEntries: DealTrackerPreviewEntry[] = []

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]
    if (i < 3) {
      console.log(`[Deal Tracker] Processing policy ${i + 1}/${policies.length}:`, {
        policy_number: policy.policy_number,
        insuredname: policy.insuredname,
      })
    }
    const existing = existingMap.get(policy.policy_number)

    // Map policy status using cached mapping (NO database query!)
    const originalStatus = policy.statusdisplaytext || policy.statuscategory
    const mappedForLog = lookupMappedStageMonday(statusMappingMap, originalStatus)
    if (i < 3) {
      console.log(`[Deal Tracker] Status mapping for policy ${i + 1}:`, {
        original: originalStatus,
        mapped: mappedForLog ?? originalStatus,
        carrierId,
      })
    }

    // Use existing call_center/phone if already set; else look up DDF. Always read draft_date from the bulk map when present (for missing effective_date).
    const alreadyHasDdfContact = existing?.call_center != null || existing?.phone_number != null
    const normalizedName = normalizeNameForSearch(policy.insuredname || '')
    const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdfContact) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
      if (i < 3) console.log(`[Deal Tracker] policy ${i + 1}: using existing DDF contact (draft_date still from map if fetched)`)
    } else {
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      if (i < 3) {
        console.log(`[Deal Tracker] daily_deal_flow lookup for policy ${i + 1}:`, {
          insuredname: policy.insuredname,
          normalizedName,
          found: !!ddfInfo,
          callCenter,
          phoneNumber,
        })
      }
    }
    const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

    // Policy file only: financials stay on deal_tracker — never from aetna_commissions (use processAetnaCommissionsForDealTracker).
    let dealValue: number | null = null
    let ccValue: number | null = null
    let chargeBackForEntry: number | null = null
    if (existing) {
      dealValue =
        existing.deal_value != null
          ? typeof existing.deal_value === 'string'
            ? parseFloat(existing.deal_value)
            : existing.deal_value
          : null
      ccValue =
        existing.cc_value != null
          ? typeof existing.cc_value === 'string'
            ? parseFloat(existing.cc_value)
            : existing.cc_value
          : dealValue != null
            ? dealValue / 2
            : null
      chargeBackForEntry =
        existing.charge_back != null
          ? typeof existing.charge_back === 'string'
            ? parseFloat(existing.charge_back)
            : existing.charge_back
          : null
      if (Number.isNaN(dealValue as number)) dealValue = null
      if (Number.isNaN(ccValue as number)) ccValue = null
      if (Number.isNaN(chargeBackForEntry as number)) chargeBackForEntry = null
    }

    const carrierStatusForPolicy = policy.statusdisplaytext || policy.statuscategory || null
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      carrierStatusForPolicy,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
    )
    const effectiveDateForGhl = effectiveDate

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBackForEntry)
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, chargeBackForEntry)
        ? (existing.status ?? derivedStatus)
        : derivedStatus
    const statusUnchanged = existing && carrierStatusUnchanged(existing, carrierStatusForPolicy)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      carrierStatusForPolicy,
      !!statusUnchanged,
      existing?.policy_status
    )

    // Re-resolve GHL stage even when raw carrier status is unchanged so that
    // time-based transitions (based on draft/effective_date) still trigger.
    // Manual-audited stages are protected inside resolveGhlStage().
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: carrierStatusForPolicy,
      allMappings: ghlStageMappingMap,
      effectiveDate: effectiveDateForGhl,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate: existing?.deal_creation_date ?? (policy.apprecddate || policy.issuedate || null),
      dealValue,
      chargeBack: chargeBackForEntry,
      commissionType: existing?.commission_type || null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })
    const dealCreationDateForGhl =
      existing?.deal_creation_date ?? (policy.apprecddate || policy.issuedate || null)
    const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
      mappedGhlStage,
      dealCreationDateForGhl,
      policyStatusResolved,
      carrierStatusForPolicy,
    )

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: policy.insuredname || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: forceWithdrawnStatus
        ? 'Withdrawn'
        : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusResolved),
      // Preserve existing deal_creation_date when present
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBackForEntry,
      notes: existing?.notes ?? null,
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentcompletename || existing?.sales_agent || null,
      writing_number: policy.agentnumber || existing?.writing_number || null,
      commission_type: existing?.commission_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: forceWithdrawnStatus
        ? 'Application Withdrawn'
        : policy.statusdisplaytext || policy.statuscategory || null,
      policy_type: policy.product || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'aetna_policies',
      source_policy_id: policy.id,
      source_commission_table: existing?.source_commission_table ?? null,
      source_commission_id: existing?.source_commission_id ?? null,
      isNew: !existing,
      isUpdated: !!existing,
    }
    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }
    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Processing complete. Total entries:', previewEntries.length)
  console.log('[Deal Tracker] Sample entry:', previewEntries[0] || 'none')

  return previewEntries
}

/**
 * Process AMAM carrier policy files and create deal tracker entries
 */
export async function processAmamFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmamFilesForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('amam_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching AMAM policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No AMAM policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)

  let existingEntries: any[] = []
  try {
    existingEntries = await fetchAllPaginated(() =>
      supabase
        .from('deal_tracker')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (existingError: any) {
    console.warn('[Deal Tracker] Failed to fetch existing deal_tracker entries:', existingError?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  // Only fetch DDF for policies that don't already have call_center/phone (skip re-lookup for already-filled rows)
  const policiesNeedingDdfAmam = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
  const uniqueInsuredNamesAmam = Array.from(new Set(
    policiesNeedingDdfAmam.map(p => buildAmamInsuredName(p)).filter(n => n.length > 0)
  ))
  const dealCreationDateByNameAmam = new Map<string, string | null>()
  policiesNeedingDdfAmam.forEach((p) => {
    const existing = existingMap.get(p.policy_number)
    const date = existing?.deal_creation_date ?? p.recvdate ?? p.policydate ?? p.app_date ?? null
    appendPreferredDealCreationDate(dealCreationDateByNameAmam, buildAmamInsuredName(p), date)
  })
  const skipCountAmam = policies.length - policiesNeedingDdfAmam.length
  console.log('[Deal Tracker] AMAM: carrier=', carrierName, '| names to DDF=', uniqueInsuredNamesAmam.length, '| skip (already have DDF)=', skipCountAmam)
  console.log('[Deal Tracker] AMAM: sample names sent to DDF (first 10):', uniqueInsuredNamesAmam.slice(0, 10))
  const dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(uniqueInsuredNamesAmam, carrierName, dealCreationDateByNameAmam)
  console.log('[Deal Tracker] AMAM: DDF map size after fetch:', dailyDealFlowMap.size, 'of', uniqueInsuredNamesAmam.length, 'names')

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null

    // Use existing call_center/phone if already set; else look up DDF. Read draft_date from bulk map whenever fetched (fill missing effective_date).
    const alreadyHasDdfContact = existing?.call_center != null || existing?.phone_number != null
    const normalizedNameAmam = normalizeNameForSearch(insuredName)
    const ddfInfoAmam = dailyDealFlowMap.get(normalizedNameAmam) || null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdfContact) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      callCenter = ddfInfoAmam?.call_center ?? null
      phoneNumber = ddfInfoAmam?.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfoAmam?.draft_date ?? null

    const entryIndex = previewEntries.length
    if (entryIndex < 3) {
      console.log('[Deal Tracker] AMAM policy sample', entryIndex + 1, '| insuredName:', insuredName, '| normalized:', normalizeNameForSearch(insuredName), '| ddfFound:', !!(callCenter || phoneNumber), '| call_center:', callCenter ?? '(empty)', '| phone:', phoneNumber ?? '(empty)')
    }

    // Policy file only: deal_value, cc_value, charge_back come from deal_tracker — never from amam_commissions
    // (commission uploads use processAmamCommissionsForDealTracker).
    let dealValue: number | null = null
    let ccValue: number | null = null
    let chargeBackPreserved: number | null = null
    if (existing) {
      dealValue =
        existing.deal_value != null
          ? typeof existing.deal_value === 'string'
            ? parseFloat(existing.deal_value)
            : existing.deal_value
          : null
      ccValue =
        existing.cc_value != null
          ? typeof existing.cc_value === 'string'
            ? parseFloat(existing.cc_value)
            : existing.cc_value
          : dealValue != null
            ? dealValue / 2
            : null
      chargeBackPreserved =
        existing.charge_back != null
          ? typeof existing.charge_back === 'string'
            ? parseFloat(existing.charge_back)
            : existing.charge_back
          : null
      if (Number.isNaN(dealValue as number)) dealValue = null
      if (Number.isNaN(ccValue as number)) ccValue = null
      if (Number.isNaN(chargeBackPreserved as number)) chargeBackPreserved = null
    }
    // Preserve existing deal_creation_date when present; for NEW policies,
    // take the deal date from AMAM's recvdate_raw (receipt date), falling
    // back to policydate_raw / app_date_raw only if recvdate_raw is missing.
    const dealCreationDate =
      existing?.deal_creation_date ??
      (policy.recvdate_raw || policy.policydate_raw || policy.app_date_raw || null)
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
    )
    const effectiveDateForGhl = effectiveDate

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBackPreserved)
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, chargeBackPreserved)
        ? (existing.status ?? derivedStatus)
        : derivedStatus

    const statusUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!statusUnchanged,
      existing?.policy_status
    )

    // Re-resolve GHL stage even when raw carrier status is unchanged so that
    // time-based transitions still trigger.
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate: effectiveDateForGhl,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate,
      dealValue,
      chargeBack: chargeBackPreserved,
      commissionType: existing?.commission_type || null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })
    const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
      mappedGhlStage,
      dealCreationDate,
      policyStatusResolved,
      originalStatus,
    )

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfoAmam?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: forceWithdrawnStatus
        ? 'Withdrawn'
        : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusResolved),
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBackPreserved,
      notes: existing?.notes ?? null,
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: policy.writingagent ?? existing?.writing_number ?? null,
      commission_type: existing?.commission_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: forceWithdrawnStatus ? 'Application Withdrawn' : originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: existing?.source_commission_table ?? null,
      source_commission_id: existing?.source_commission_id ?? null,
      isNew: !existing,
      isUpdated: !!existing,
    }
    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }
    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] AMAM policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Build AMAM deal tracker preview from in-memory policy rows (deferred write until confirm).
 * Commission data will be empty; source_policy_id/source_commission_id set on confirm after insert.
 */
export async function processAmamFilesForDealTrackerFromRows(
  agencyCarrierId: string,
  fileId: string,
  policyRows: any[]
): Promise<DealTrackerPreviewEntry[]> {
  if (!policyRows || policyRows.length === 0) return []
  const totalStart = Date.now()

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id
  const policyNumbers = policyRows.map((p: any) => p.policy_number)

  let stepStart = Date.now()
  const { data: existingEntries } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)
  console.log('[Deal Tracker] FromRows: existing deal_tracker fetch', policyNumbers.length, 'policies took', Math.round((Date.now() - stepStart) / 1000), 's')
  const existingMap = new Map<string, any>()
  if (existingEntries) existingEntries.forEach((e: any) => existingMap.set(e.policy_number, e))

  stepStart = Date.now()
  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  console.log(
    '[Deal Tracker] FromRows: mappings took',
    Math.round((Date.now() - stepStart) / 1000),
    's | status:',
    statusMappingMap.size,
    '| GHL:',
    ghlStageMappingMap.size
  )

  const policiesNeedingDdfAmam = policyRows.filter((p: any) =>
    policyNeedsDdfLookup(existingMap.get(p.policy_number))
  )
  const uniqueInsuredNamesAmam = Array.from(new Set(
    policiesNeedingDdfAmam.map((p: any) => buildAmamInsuredName(p)).filter((n: string) => n.length > 0)
  ))
  const dealCreationDateByNameAmam = new Map<string, string | null>()
  policiesNeedingDdfAmam.forEach((p: any) => {
    const existing = existingMap.get(p.policy_number)
    const date = existing?.deal_creation_date ?? p.recvdate_raw ?? p.policydate_raw ?? p.app_date_raw ?? null
    appendPreferredDealCreationDate(dealCreationDateByNameAmam, buildAmamInsuredName(p), date)
  })
  if (uniqueInsuredNamesAmam.length > 0) {
    console.log('[Deal Tracker] FromRows: fetching DDF for', uniqueInsuredNamesAmam.length, 'names (slow step for large files)...')
  }
  stepStart = Date.now()
  const dailyDealFlowMap = uniqueInsuredNamesAmam.length > 0
    ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNamesAmam, carrierName, dealCreationDateByNameAmam)
    : new Map<string, DailyDealFlowInfo>()
  if (uniqueInsuredNamesAmam.length > 0) {
    console.log('[Deal Tracker] FromRows: DDF fetch took', Math.round((Date.now() - stepStart) / 1000), 's')
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  for (const policy of policyRows) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const alreadyHasDdfContact = existing?.call_center != null || existing?.phone_number != null
    const normalizedNameRows = normalizeNameForSearch(insuredName)
    const ddfInfoRows = dailyDealFlowMap.get(normalizedNameRows) || null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdfContact) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      callCenter = ddfInfoRows?.call_center ?? null
      phoneNumber = ddfInfoRows?.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfoRows?.draft_date ?? null
    const dealCreationDate =
      existing?.deal_creation_date ??
      (policy.recvdate_raw || policy.policydate_raw || policy.app_date_raw || null)
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
    )
    const preserveDealValue = existing?.deal_value != null ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value) : null
    const preserveCcValue = existing?.cc_value != null ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value) : (preserveDealValue != null ? preserveDealValue / 2 : null)
    const preserveChargeBack =
      existing?.charge_back != null
        ? typeof existing.charge_back === 'string'
          ? parseFloat(existing.charge_back)
          : existing.charge_back
        : null
    const dealValueFromRows = Number.isFinite(preserveDealValue) ? preserveDealValue : null
    const ccValueFromRows = Number.isFinite(preserveCcValue) ? preserveCcValue : null
    const chargeBackFromRows = Number.isFinite(preserveChargeBack as number) ? preserveChargeBack : null
    const derivedStatus = statusFromDealValueAndChargeback(dealValueFromRows, chargeBackFromRows)
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValueFromRows, chargeBackFromRows)
        ? (existing.status ?? derivedStatus)
        : derivedStatus

    const statusUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!statusUnchanged,
      existing?.policy_status
    )

    // Re-resolve GHL stage even when raw carrier status is unchanged so that
    // time-based transitions still trigger.
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate,
      dealValue: dealValueFromRows,
      chargeBack: chargeBackFromRows,
      commissionType: existing?.commission_type || null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })
    const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
      mappedGhlStage,
      dealCreationDate,
      policyStatusResolved,
      originalStatus,
    )

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfoRows?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: forceWithdrawnStatus
        ? 'Withdrawn'
        : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusResolved),
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValueFromRows,
      cc_value: ccValueFromRows,
      charge_back: chargeBackFromRows,
      notes: existing?.notes ?? null,
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: policy.writingagent ?? existing?.writing_number ?? null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: forceWithdrawnStatus ? 'Application Withdrawn' : originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'amam_policies',
      source_policy_id: null,
      source_commission_table: null,
      source_commission_id: null,
      isNew: !existing,
      isUpdated: !!existing,
    }
    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }
    previewEntries.push(entry)
  }
  console.log('[Deal Tracker] FromRows: policy preview built in', Math.round((Date.now() - totalStart) / 1000), 's total')
  return previewEntries
}

/**
 * Process AMAM commission files and update deal tracker entries
 */
export async function processAmamCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmamCommissionsForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  const { data: commissions, error: commissionsError } = await supabase
    .from('amam_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (commissionsError) {
    console.error('[Deal Tracker] Error fetching AMAM commissions:', commissionsError)
    throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
  }

  if (!commissions || commissions.length === 0) {
    console.warn('[Deal Tracker] No AMAM commissions found for file_id:', fileId)
    return []
  }

  const typedCommissions = commissions as Array<{ policy_number: string; advance?: string | number | null; created_at?: string | null }>
  const policyNumbers = Array.from(new Set(typedCommissions.map((c) => c.policy_number)))
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing entries:', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    const typedExistingEntries = existingEntries as Array<{ policy_number: string }>
    typedExistingEntries.forEach((entry) => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  typedCommissions.forEach((comm) => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const amount = comm.advance != null
      ? (typeof comm.advance === 'string' ? parseFloat(comm.advance) : comm.advance)
      : 0
    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + (Number.isNaN(amount) ? 0 : amount))
    if (!commissionMap.has(policyNum) || (comm.created_at && commissionMap.get(policyNum)?.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })

  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(pn => !existingMap.has(pn))
  const existingNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const ex = existingMap.get(pn)
    return ex != null && policyNeedsDdfLookup(ex)
  })
  const allPolicyNumbersNeedingDDF = Array.from(new Set([...missingPolicyNumbers, ...existingNeedingDDF]))
  /** Every policy in this commission file — load rows so status_raw can drive resolveGhlStage even when DDF is already filled on deal_tracker. */
  const allCommissionPolicyNumbers = Array.from(new Set(commissionMap.keys()))
  const existingCount = Array.from(commissionMap.keys()).filter(pn => existingMap.has(pn)).length
  console.log('[Deal Tracker] AMAM commissions: commissions=', commissionMap.size, '| in deal_tracker=', existingCount, '| missing (new)=', missingPolicyNumbers.length, '| existing needing DDF (contact or effective)=', existingNeedingDDF.length)

  let policiesMap = new Map<string, any>()
  if (allCommissionPolicyNumbers.length > 0) {
    const { data: policies } = await supabase
      .from('amam_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', allCommissionPolicyNumbers)
    if (policies) {
      const typedPolicies = policies as Array<{ policy_number: string }>
      typedPolicies.forEach((p) => {
        policiesMap.set(p.policy_number, p)
      })
    }
    console.log(
      '[Deal Tracker] AMAM commissions: loaded',
      policiesMap.size,
      'policy rows from amam_policies for',
      allCommissionPolicyNumbers.length,
      'policy numbers in file',
    )
  }

  let statusMappingMap = new Map<string, string>()
  let ghlStageMappingMap = new Map<string, string[]>()
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  // GHL stage mapping is required for BOTH existing and new entries during
  // commission-only uploads (deal_value/cc/status changes should promote stages).
  // Status mapping: load whenever commission run may set policy_status from carrier raw (new or existing updates).
  ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = allPolicyNumbersNeedingDDF
      .map(pn => policiesMap.get(pn))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .map(p => buildAmamInsuredName(p))
      .filter(name => name.length > 0)
    const dealCreationDateByName = new Map<string, string | null>()
    allPolicyNumbersNeedingDDF.forEach((pn) => {
      const policy = policiesMap.get(pn)
      const existing = existingMap.get(pn)
      const name = policy ? buildAmamInsuredName(policy) : (existing?.name || '')
      const date = existing?.deal_creation_date ?? policy?.recvdate ?? policy?.policydate ?? policy?.app_date ?? null
      appendPreferredDealCreationDate(dealCreationDateByName, name, date)
    })
    if (policyNamesForDDF.length > 0) {
      console.log('[Deal Tracker] AMAM commissions: fetching DDF for', policyNamesForDDF.length, 'names (missing + existing without call_center/phone) | sample:', policyNamesForDDF.slice(0, 5))
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName, dealCreationDateByName)
      console.log('[Deal Tracker] AMAM commissions: DDF map size:', dailyDealFlowMap.size, 'of', policyNamesForDDF.length)
    } else {
      console.log('[Deal Tracker] AMAM commissions: no policy names for DDF – upload policy file first so amam_policies has rows for these policy numbers')
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  let newEntryLogCount = 0

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const totalAmount = commissionAmountsMap.get(policyNumber)
    let dealValue: number | null = totalAmount !== undefined && totalAmount !== null
      ? totalAmount
      : (commission.advance != null ? (typeof commission.advance === 'string' ? parseFloat(commission.advance) : commission.advance) : null)
    let chargeBack: number | null = existing?.charge_back ?? null

    // Business rule: when updating an existing policy, deal_value should never become negative.
    // If the net commission amount for this batch is negative, treat it as a charge back instead
    // and preserve the prior deal_value.
    // Also, when the net commission is exactly 0, treat it like "no commission" and keep existing
    // deal_value/charge_back so rule-based Status does not change.
    if (existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = existingDeal
        const existingCb =
          chargeBack != null
            ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack)))
            : 0
        const newCb = existingCb + numericDeal
        chargeBack = Number.isNaN(newCb) ? numericDeal : newCb
      } else if (!Number.isNaN(numericDeal) && numericDeal === 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = Number.isNaN(existingDeal as number) ? null : existingDeal
        chargeBack = existing.charge_back ?? null
      }
    }

    const ccValue = dealValue != null ? dealValue / 2 : null

    if (existing) {
      let callCenter = existing.call_center
      let phoneNumber = existing.phone_number
      let dailyDealFlowFetched = existing.daily_deal_flow_fetched
      let dailyDealFlowFetchedAt = existing.daily_deal_flow_fetched_at
      const policy = policiesMap.get(policyNumber)
      let effectiveDateFromDdf: string | null = null
      if (policy) {
        const normalizedName = normalizeNameForSearch(buildAmamInsuredName(policy))
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        if (ddfInfo && (callCenter == null && phoneNumber == null)) {
          callCenter = ddfInfo.call_center ?? null
          phoneNumber = ddfInfo.phone_number ?? null
          dailyDealFlowFetched = !!(callCenter || phoneNumber)
          dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
        }
        effectiveDateFromDdf = ddfInfo?.draft_date ?? null
      }
      const policyForWriting = policiesMap.get(policyNumber)
      const carrierStatusForGhl = policyForWriting?.status_raw ?? existing.carrier_status ?? null
      const effectiveDate = mergeEffectiveDateWithPendingRoll(
        carrierStatusForGhl,
        existing.policy_status ?? null,
        existing.effective_date,
        effectiveDateFromDdf,
        commission.issdate,
      )
      const effectiveDateForGhl = effectiveDate
      const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
      const carrierUnchanged = carrierStatusUnchanged(existing, carrierStatusForGhl)
      const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
        statusMappingMap,
        carrierStatusForGhl,
        !!carrierUnchanged,
        existing.policy_status
      )

      // Re-resolve GHL stage based on updated financials, even when we are
      // only uploading a commission file.
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierStatusForGhl,
        allMappings: ghlStageMappingMap,
        effectiveDate: effectiveDateForGhl,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
        dealCreationDate:
          existing.deal_creation_date ??
          policyForWriting?.recvdate_raw ??
          policyForWriting?.policydate_raw ??
          policyForWriting?.app_date_raw ??
          null,
        dealValue,
        chargeBack,
        commissionType: commission.action || existing.commission_type || null,
        existingGhlStage: existing.ghl_stage ?? null,
        carrierCode,
      })
      const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
        mappedGhlStage,
        existing.deal_creation_date ??
          policyForWriting?.recvdate_raw ??
          policyForWriting?.policydate_raw ??
          policyForWriting?.app_date_raw ??
          null,
        policyStatusResolved,
        carrierStatusForGhl,
      )

      const stmtRaw =
        commission.statement_date != null && String(commission.statement_date).trim() !== ''
          ? String(commission.statement_date).trim()
          : null

      const updatedEntry: DealTrackerPreviewEntry = {
        ...existing,
        ghl_stage: ensureGhlStageForPreviewSave(mappedGhlStage ?? existing.ghl_stage),
        carrier_status: existing.carrier_status ?? null,
        policy_status: forceWithdrawnStatus
          ? 'Withdrawn'
          : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusResolved),
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: chargeBack,
        status: derivedStatus ?? existing.status,
        writing_number: commission.writingagent ?? policyForWriting?.writingagent ?? existing.writing_number,
        commission_type: commission.action ?? existing.commission_type,
        effective_date: effectiveDate,
        commission_date: stmtRaw,
        call_center: callCenter,
        phone_number: phoneNumber,
        daily_deal_flow_fetched: dailyDealFlowFetched,
        daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
        source_commission_table: 'amam_commissions',
        source_commission_id: commission.id,
        isNew: false,
        isUpdated: true,
      }
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, updatedEntry as unknown as Record<string, unknown>)
      updatedEntry.changedFields = changedFields
      updatedEntry.previousValues = previousValues
      previewEntries.push(updatedEntry)
      continue
    }

    const policy = policiesMap.get(policyNumber)
    if (!policy) continue

    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const policyStatusForNew =
      lookupMappedStageMonday(statusMappingMap, originalStatus) ?? originalStatus ?? null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = dailyDealFlowMap.get(normalizedName)
    const callCenter = ddfInfo?.call_center ?? null
    const phoneNumber = ddfInfo?.phone_number ?? null
    const dealCreationDate =
      policy.recvdate_raw || policy.policydate_raw || policy.app_date_raw || null
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      policyStatusForNew,
      null,
      ddfInfo?.draft_date ?? null,
      commission.issdate,
    )

    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(null, effectiveDate),
      dealCreationDate,
      dealValue,
      chargeBack,
      commissionType: commission.action || null,
      existingGhlStage: null,
      carrierCode,
    })
    const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
      mappedGhlStage,
      dealCreationDate,
      policyStatusForNew,
      originalStatus,
    )

    if (newEntryLogCount < 3) {
      console.log('[Deal Tracker] AMAM commission new-entry sample', newEntryLogCount + 1, '| insuredName:', insuredName, '| normalized:', normalizedName, '| ddfFound:', !!(callCenter || phoneNumber), '| call_center:', callCenter ?? '(empty)', '| phone:', phoneNumber ?? '(empty)')
      newEntryLogCount++
    }

    const derivedStatus = statusFromDealValue(dealValue)
    const stmtNew =
      commission.statement_date != null && String(commission.statement_date).trim() !== ''
        ? String(commission.statement_date).trim()
        : null
    previewEntries.push({
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: ddfInfo?.lead_name ?? null,
      ghl_stage: ensureGhlStageForPreviewSave(mappedGhlStage),
      policy_status: forceWithdrawnStatus
        ? 'Withdrawn'
        : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusForNew),
      deal_creation_date: dealCreationDate,
      commission_date: stmtNew,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: commission.writingagent || policy.writingagent || null,
      commission_type: commission.action || null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: forceWithdrawnStatus ? 'Application Withdrawn' : originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: 'amam_commissions',
      source_commission_id: commission.id,
      isNew: true,
      isUpdated: false,
    })
  }

  console.log('[Deal Tracker] AMAM commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Build AMAM commission deal tracker preview from in-memory commission rows (deferred write until confirm).
 * Loads policies from DB for names/DDF; source_commission_id set on confirm after insert.
 */
export async function processAmamCommissionsForDealTrackerFromRows(
  agencyCarrierId: string,
  fileId: string,
  commissionRows: any[]
): Promise<DealTrackerPreviewEntry[]> {
  if (!commissionRows || commissionRows.length === 0) return []

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissionRows.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const amount = comm.advance != null ? (typeof comm.advance === 'string' ? parseFloat(comm.advance) : comm.advance) : 0
    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + (Number.isNaN(amount) ? 0 : amount))
    if (!commissionMap.has(policyNum) || (comm.created_at && commissionMap.get(policyNum)?.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })

  const policyNumbers = Array.from(commissionMap.keys())
  const { data: existingEntries } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)
  const existingMap = new Map<string, any>()
  if (existingEntries) existingEntries.forEach((e: any) => existingMap.set(e.policy_number, e))

  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(pn => !existingMap.has(pn))
  const existingNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const ex = existingMap.get(pn)
    return ex != null && policyNeedsDdfLookup(ex)
  })
  const allPolicyNumbersNeedingDDF = Array.from(new Set([...missingPolicyNumbers, ...existingNeedingDDF]))
  const allCommissionPolicyNumbers = Array.from(new Set(commissionMap.keys()))
  let policiesMap = new Map<string, any>()
  if (allCommissionPolicyNumbers.length > 0) {
    const { data: policies } = await supabase
      .from('amam_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', allCommissionPolicyNumbers)
    if (policies) policies.forEach((p: any) => policiesMap.set(p.policy_number, p))
  }

  let statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = allPolicyNumbersNeedingDDF
      .map(pn => policiesMap.get(pn))
      .filter((p): p is NonNullable<typeof p> => p != null)
      .map((p: any) => buildAmamInsuredName(p))
      .filter((n: string) => n.length > 0)
    const dealCreationDateByName = new Map<string, string | null>()
    allPolicyNumbersNeedingDDF.forEach((pn) => {
      const policy = policiesMap.get(pn)
      const existing = existingMap.get(pn)
      const name = policy ? buildAmamInsuredName(policy) : (existing?.name || '')
      const date = existing?.deal_creation_date ?? policy?.recvdate ?? policy?.policydate ?? policy?.app_date ?? null
      appendPreferredDealCreationDate(dealCreationDateByName, name, date)
    })
    if (policyNamesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName, dealCreationDateByName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  let newEntryLogCount = 0

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const totalAmount = commissionAmountsMap.get(policyNumber)
    let dealValue: number | null =
      totalAmount !== undefined && totalAmount !== null
        ? totalAmount
        : (commission.advance != null
            ? (typeof commission.advance === 'string' ? parseFloat(commission.advance) : commission.advance)
            : null)
    let chargeBack: number | null = existing?.charge_back ?? null

    // Business rule: when updating an existing policy, deal_value should never become negative.
    // If the net commission amount for this batch is negative, treat it as a charge back instead
    // and preserve the prior deal_value.
    // Also, when the net commission is exactly 0, treat it like "no commission" and keep existing
    // deal_value/charge_back so rule-based Status does not change.
    if (existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = existingDeal
        const existingCb =
          chargeBack != null
            ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack)))
            : 0
        const newCb = existingCb + numericDeal
        chargeBack = Number.isNaN(newCb) ? numericDeal : newCb
      } else if (!Number.isNaN(numericDeal) && numericDeal === 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = Number.isNaN(existingDeal as number) ? null : existingDeal
        chargeBack = existing.charge_back ?? null
      }
    }

    const ccValue = dealValue != null ? dealValue / 2 : null

    if (existing) {
      let callCenter = existing.call_center
      let phoneNumber = existing.phone_number
      let dailyDealFlowFetched = existing.daily_deal_flow_fetched
      let dailyDealFlowFetchedAt = existing.daily_deal_flow_fetched_at
      const policy = policiesMap.get(policyNumber)
      let effectiveDateFromDdf: string | null = null
      if (policy) {
        const normalizedName = normalizeNameForSearch(buildAmamInsuredName(policy))
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        if (ddfInfo && (callCenter == null && phoneNumber == null)) {
          callCenter = ddfInfo.call_center ?? null
          phoneNumber = ddfInfo.phone_number ?? null
          dailyDealFlowFetched = !!(callCenter || phoneNumber)
          dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
        }
        effectiveDateFromDdf = ddfInfo?.draft_date ?? null
      }
      const policyForWriting = policiesMap.get(policyNumber)
      const carrierStatusForGhl = policyForWriting?.status_raw ?? existing.carrier_status ?? null
      const effectiveDate = mergeEffectiveDateWithPendingRoll(
        carrierStatusForGhl,
        existing.policy_status ?? null,
        existing.effective_date,
        effectiveDateFromDdf,
        commission.issdate,
      )
      const effectiveDateForGhl = effectiveDate
      const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
      const carrierUnchanged = carrierStatusUnchanged(existing, carrierStatusForGhl)
      const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
        statusMappingMap,
        carrierStatusForGhl,
        !!carrierUnchanged,
        existing.policy_status
      )
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierStatusForGhl,
        allMappings: ghlStageMappingMap,
        effectiveDate: effectiveDateForGhl,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
        dealCreationDate:
          existing.deal_creation_date ??
          policyForWriting?.recvdate_raw ??
          policyForWriting?.policydate_raw ??
          policyForWriting?.app_date_raw ??
          null,
        dealValue,
        chargeBack,
        commissionType: commission.action || existing.commission_type || null,
        existingGhlStage: existing.ghl_stage ?? null,
        carrierCode,
      })
      const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
        mappedGhlStage,
        existing.deal_creation_date ??
          policyForWriting?.recvdate_raw ??
          policyForWriting?.policydate_raw ??
          policyForWriting?.app_date_raw ??
          null,
        policyStatusResolved,
        carrierStatusForGhl,
      )
      const stmtRaw =
        commission.statement_date != null && String(commission.statement_date).trim() !== ''
          ? String(commission.statement_date).trim()
          : null
      const updatedEntry: DealTrackerPreviewEntry = {
        ...existing,
        ghl_stage: ensureGhlStageForPreviewSave(mappedGhlStage ?? existing.ghl_stage),
        carrier_status: existing.carrier_status ?? null,
        policy_status: forceWithdrawnStatus
          ? 'Withdrawn'
          : normalizePolicyStatusForMappedGhlStage(mappedGhlStage, policyStatusResolved),
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: chargeBack,
        status: derivedStatus ?? existing.status,
        writing_number: commission.writingagent ?? policyForWriting?.writingagent ?? existing.writing_number,
        commission_type: commission.action ?? existing.commission_type,
        effective_date: effectiveDate,
        commission_date: stmtRaw,
        call_center: callCenter,
        phone_number: phoneNumber,
        daily_deal_flow_fetched: dailyDealFlowFetched,
        daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
        source_commission_table: 'amam_commissions',
        source_commission_id: null,
        isNew: false,
        isUpdated: true,
      }
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, updatedEntry as unknown as Record<string, unknown>)
      updatedEntry.changedFields = changedFields
      updatedEntry.previousValues = previousValues
      previewEntries.push(updatedEntry)
      continue
    }

    const policy = policiesMap.get(policyNumber)
    if (!policy) continue

    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const policyStatusForNew =
      lookupMappedStageMonday(statusMappingMap, originalStatus) ?? originalStatus ?? null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = dailyDealFlowMap.get(normalizedName)
    const callCenter = ddfInfo?.call_center ?? null
    const phoneNumber = ddfInfo?.phone_number ?? null
    const dealCreationDate =
      policy.recvdate_raw || policy.policydate_raw || policy.app_date_raw || null
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      policyStatusForNew,
      null,
      ddfInfo?.draft_date ?? null,
      commission.issdate,
    )
    const mappedGhlNew = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(null, effectiveDate),
      dealCreationDate,
      dealValue,
      chargeBack,
      commissionType: commission.action || null,
      existingGhlStage: null,
      carrierCode,
    })
    const forceWithdrawnStatus = pendingAgingForcesWithdrawn(
      mappedGhlNew,
      dealCreationDate,
      policyStatusForNew,
      originalStatus,
    )
    const stmtNew =
      commission.statement_date != null && String(commission.statement_date).trim() !== ''
        ? String(commission.statement_date).trim()
        : null
    previewEntries.push({
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: ddfInfo?.lead_name ?? null,
      ghl_stage: ensureGhlStageForPreviewSave(mappedGhlNew),
      policy_status: forceWithdrawnStatus
        ? 'Withdrawn'
        : normalizePolicyStatusForMappedGhlStage(mappedGhlNew, policyStatusForNew),
      deal_creation_date: dealCreationDate,
      commission_date: stmtNew,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: commission.writingagent || policy.writingagent || null,
      commission_type: commission.action || null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: forceWithdrawnStatus ? 'Application Withdrawn' : originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: 'amam_commissions',
      source_commission_id: null,
      isNew: true,
      isUpdated: false,
    })
  }
  return previewEntries
}

/**
 * Derive policy_status from deal_value per business rules:
 * Rule-based Status helper (for `status` column, NOT `policy_status`).
 * - deal_value null or 0 -> "NOT yet payed"
 * - deal_value negative -> "Charge Back"
 * - deal_value positive -> "Payed"
 */
export function statusFromDealValue(
  dealValue: number | null | undefined,
): string | null {
  if (dealValue == null) return 'NOT yet payed'
  const num = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
  if (Number.isNaN(num)) return 'NOT yet payed'
  if (num < 0) return 'Charge Back'
  if (num === 0) return 'NOT yet payed'
  return 'Payed'
}

/** True when deal_value and charge_back are unchanged (for preserving rule-based status on policy-only uploads). */
export function financialsUnchanged(
  existing: { deal_value?: number | string | null; charge_back?: number | string | null } | null | undefined,
  newDealValue: number | null | undefined,
  newChargeBack: number | null | undefined
): boolean {
  if (!existing) return false
  const n = (v: unknown) => (v != null && (typeof v === 'number' ? Number.isFinite(v) : !Number.isNaN(parseFloat(String(v))))) ? (typeof v === 'number' ? v : parseFloat(String(v))) : null
  return n(existing.deal_value) === n(newDealValue) && n(existing.charge_back) === n(newChargeBack)
}

/**
 * Derive status from deal_value and charge_back. If there is a chargeback (negative amount),
 * status is "Charge Back" regardless of deal_value; otherwise same as statusFromDealValue(deal_value).
 */
export function statusFromDealValueAndChargeback(
  dealValue: number | null | undefined,
  chargeBack: number | null | undefined,
): string | null {
  const cb = chargeBack != null ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack))) : null
  if (cb != null && !Number.isNaN(cb) && cb < 0) return 'Charge Back'
  return statusFromDealValue(dealValue)
}

/**
 * Save deal_tracker rows for **all** carriers (single path: upload confirmation → `saveDealTrackerAfterConfirmation` → here).
 * Uses batched upserts with `onConflict (agency_carrier_id, policy_number)`.
 *
 * - When incoming `deal_value` is 0, we preserve the **existing DB `deal_value`** only (avoid wiping a prior commission with 0).
 *   We must **not** restore old `policy_status` in that branch — it would undo carrier_status_mapping from policy uploads.
 * - `policy_status` on each entry is the mapped value from preview; keep it intact.
 * - `status` (paid / not paid / charge back) is derived from deal_value/charge_back with rules below.
 * - GHL stage: see `needsGhlPreserve` — we only restore DB `ghl_stage` when incoming is empty **and**
 *   `policy_status` is unchanged vs DB, so mapping-driven upgrades are not overwritten.
 */
export async function saveDealTrackerEntries(
  entries: DealTrackerEntry[] | DealTrackerPreviewEntry[],
  options?: { onProgress?: (msg: string) => void }
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (!entries || entries.length === 0) {
    return { inserted: 0, updated: 0, failed: 0 }
  }

  const log = (msg: string) => {
    console.log('[Deal Tracker]', msg)
    options?.onProgress?.(msg)
  }

  log(`Starting batch save for ${entries.length.toLocaleString()} entries...`)

  // Clean entries: remove preview-only and auto-managed fields
  const now = new Date().toISOString()
  let cleanEntries = entries.map(entry => {
    const {
      isNew,
      isUpdated,
      changedFields,
      previousValues,
      commission_date: _commissionDatePreviewOnly,
      id,
      created_at,
      updated_at,
      ...dbEntry
    } = entry as any
    return {
      ...dbEntry,
      updated_at: now,
    }
  })

  // When incoming deal_value is 0, preserve existing deal_value only (do not overwrite with 0).
  const needsDealValuePreserve = cleanEntries.filter(
    e => e.agency_carrier_id && e.policy_number && (e.deal_value === 0 || e.deal_value === '0')
  )
  if (needsDealValuePreserve.length > 0) {
    const keySet = new Set(needsDealValuePreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsDealValuePreserve.map(e => e.agency_carrier_id))]
    const existingMap = new Map<string, { deal_value: number | null }>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, deal_value')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows) {
          const key = `${row.agency_carrier_id}\0${row.policy_number}`
          if (keySet.has(key)) {
            const dv = row.deal_value != null ? (typeof row.deal_value === 'string' ? parseFloat(row.deal_value) : row.deal_value) : null
            existingMap.set(key, { deal_value: Number.isNaN(dv as number) ? null : (dv as number) })
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if (!e.agency_carrier_id || !e.policy_number) return e
      const key = `${e.agency_carrier_id}\0${e.policy_number}`
      if (e.deal_value !== 0 && e.deal_value !== '0') return e
      const preserved = existingMap.get(key)
      if (preserved == null) return e
      return { ...e, deal_value: preserved.deal_value }
    })
  }

  // Do NOT blindly recompute `status` on every save.
  // Business rule: `status` should only change when commissions change financials (deal_value / charge_back).
  // If a policy-only upload runs (no commission source) and financials are unchanged, preserve existing DB status.
  const existingFinanceMap = new Map<
    string,
    { deal_value: number | null; cc_value: number | null; charge_back: number | null; status: string | null }
  >()
  const byAgency = new Map<string, string[]>()
  for (const e of cleanEntries) {
    if (!e.agency_carrier_id || !e.policy_number) continue
    const list = byAgency.get(e.agency_carrier_id) ?? []
    list.push(e.policy_number)
    byAgency.set(e.agency_carrier_id, list)
  }

  for (const [agencyCarrierId, policyNumbersAll] of byAgency.entries()) {
    // Dedup policy numbers
    const uniq = Array.from(new Set(policyNumbersAll)).filter(Boolean)
    const CHUNK = 500
    for (let i = 0; i < uniq.length; i += CHUNK) {
      const nums = uniq.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, deal_value, cc_value, charge_back, status')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', nums)
      if (rows) {
        for (const row of rows as any[]) {
          const key = `${row.agency_carrier_id}\0${row.policy_number}`
          const dv = row.deal_value != null ? (typeof row.deal_value === 'number' ? row.deal_value : parseFloat(String(row.deal_value))) : null
          const ccDb = row.cc_value != null ? (typeof row.cc_value === 'number' ? row.cc_value : parseFloat(String(row.cc_value))) : null
          const cb = row.charge_back != null ? (typeof row.charge_back === 'number' ? row.charge_back : parseFloat(String(row.charge_back))) : null
          existingFinanceMap.set(key, {
            deal_value: Number.isFinite(dv as number) ? (dv as number) : null,
            cc_value: Number.isFinite(ccDb as number) ? (ccDb as number) : null,
            charge_back: Number.isFinite(cb as number) ? (cb as number) : null,
            status: row.status ?? null,
          })
        }
      }
    }
  }

  const sameNum = (a: any, b: any) => {
    const an = a != null ? (typeof a === 'number' ? a : parseFloat(String(a))) : null
    const bn = b != null ? (typeof b === 'number' ? b : parseFloat(String(b))) : null
    const ax = an != null && Number.isFinite(an) ? an : null
    const bx = bn != null && Number.isFinite(bn) ? bn : null
    return ax === bx
  }

  cleanEntries = cleanEntries.map(e => {
    if (!e.agency_carrier_id || !e.policy_number) return e
    const key = `${e.agency_carrier_id}\0${e.policy_number}`
    const prev = existingFinanceMap.get(key)

    let dv = e.deal_value != null ? (typeof e.deal_value === 'number' ? e.deal_value : parseFloat(String(e.deal_value))) : null
    let ccv =
      e.cc_value != null ? (typeof e.cc_value === 'number' ? e.cc_value : parseFloat(String(e.cc_value))) : null
    const cb = e.charge_back != null ? (typeof e.charge_back === 'number' ? e.charge_back : parseFloat(String(e.charge_back))) : null
    const isCommissionFlow = !!(e.source_commission_table || e.source_commission_id)

    // Commission save: if deal_tracker already has a non-zero advance and the incoming batch suggests a different deal_value, keep DB deal_value + cc_value; carrier line amounts remain in *_commissions / commission_tracker.
    if (isCommissionFlow && prev) {
      const pDv = prev.deal_value
      const prevNonZero = pDv != null && Number.isFinite(pDv) && Math.abs(pDv) > 0
      if (prevNonZero && !sameNum(pDv, dv)) {
        dv = prev.deal_value
        if (prev.cc_value != null && Number.isFinite(prev.cc_value)) {
          ccv = prev.cc_value
        } else if (dv != null && Number.isFinite(dv)) {
          ccv = dv / 2
        }
      }
    }

    // Policy-only uploads must never overwrite financials already on deal_tracker.
    // Keep existing deal_value/cc_value/charge_back and status for non-commission saves.
    if (!isCommissionFlow && prev) {
      return {
        ...e,
        deal_value: prev.deal_value,
        cc_value: prev.cc_value,
        charge_back: prev.charge_back,
        status: prev.status,
      }
    }

    const financialsChanged =
      prev == null ? true : (!sameNum(prev.deal_value, dv) || !sameNum(prev.charge_back, cb))
    if (isCommissionFlow && !financialsChanged && prev) {
      return { ...e, deal_value: dv, cc_value: ccv, status: prev.status }
    }

    const status = statusFromDealValueAndChargeback(dv, cb)
    return { ...e, deal_value: dv, cc_value: ccv, status }
  })

  // Preserve effective_date from DB when incoming is null/empty (e.g. DDF-sourced value should not be overwritten on updates)
  const needsEffectiveDatePreserve = cleanEntries.filter(
    e => (e.effective_date == null || e.effective_date === '') && e.agency_carrier_id && e.policy_number
  )
  if (needsEffectiveDatePreserve.length > 0) {
    const keySet = new Set(needsEffectiveDatePreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsEffectiveDatePreserve.map(e => e.agency_carrier_id))]
    const existingMap = new Map<string, string>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, effective_date')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows) {
          if (row.effective_date != null && row.effective_date !== '' && keySet.has(`${row.agency_carrier_id}\0${row.policy_number}`)) {
            existingMap.set(`${row.agency_carrier_id}\0${row.policy_number}`, row.effective_date)
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if ((e.effective_date != null && e.effective_date !== '') || !e.agency_carrier_id || !e.policy_number) return e
      const preserved = existingMap.get(`${e.agency_carrier_id}\0${e.policy_number}`)
      if (preserved == null) return e
      return { ...e, effective_date: preserved }
    })
  }

  // Preserve notes when incoming is null/empty (do not overwrite existing notes with dash/empty)
  const needsNotesPreserve = cleanEntries.filter(
    e => e.agency_carrier_id && e.policy_number && (e.notes == null || String(e.notes).trim() === '')
  )
  if (needsNotesPreserve.length > 0) {
    const keySet = new Set(needsNotesPreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsNotesPreserve.map(e => e.agency_carrier_id))]
    const existingNotesMap = new Map<string, string | null>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, notes')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows) {
          const key = `${row.agency_carrier_id}\0${row.policy_number}`
          if (keySet.has(key) && row.notes != null && String(row.notes).trim() !== '') {
            existingNotesMap.set(key, row.notes)
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if (!e.agency_carrier_id || !e.policy_number) return e
      if (e.notes != null && String(e.notes).trim() !== '') return e
      const preserved = existingNotesMap.get(`${e.agency_carrier_id}\0${e.policy_number}`)
      if (preserved == null) return e
      return { ...e, notes: preserved }
    })
  }

  // Preserve GHL name when incoming is null/empty/dash (files usually don't ship GHL name).
  // For GHL stage: only restore from DB when incoming is empty AND policy_status matches DB — if carrier
  // mapping updated policy_status (e.g. Issued Not Paid → Issued Paid), restoring old ghl_stage would undo
  // the pipeline upgrade the preview intended (same class of bug as the old deal_value=0 policy_status merge).
  const isEmptyOrDash = (v: unknown) => v == null || String(v).trim() === '' || String(v).trim() === '-'
  const needsGhlPreserve = cleanEntries.filter(
    e => e.agency_carrier_id && e.policy_number && (isEmptyOrDash(e.ghl_name) || isEmptyOrDash(e.ghl_stage))
  )
  if (needsGhlPreserve.length > 0) {
    const keySet = new Set(needsGhlPreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsGhlPreserve.map(e => e.agency_carrier_id))]
    const existingGhlMap = new Map<string, { ghl_name: string | null; ghl_stage: string | null; policy_status: string | null }>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, ghl_name, ghl_stage, policy_status')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows as any[]) {
          const key = `${row.agency_carrier_id}\0${row.policy_number}`
          if (keySet.has(key)) {
            const gname = row.ghl_name != null ? String(row.ghl_name).trim() : null
            const gstage = row.ghl_stage != null ? String(row.ghl_stage).trim() : null
            existingGhlMap.set(key, {
              ghl_name: gname && gname !== '-' ? row.ghl_name : null,
              ghl_stage: gstage && gstage !== '-' ? row.ghl_stage : null,
              policy_status: row.policy_status != null ? String(row.policy_status) : null,
            })
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if (!e.agency_carrier_id || !e.policy_number) return e
      const preserved = existingGhlMap.get(`${e.agency_carrier_id}\0${e.policy_number}`)
      if (preserved == null) return e
      const policyStatusUnchanged = valueEqual(e.policy_status, preserved.policy_status)
      const restoreGhlStage =
        isEmptyOrDash(e.ghl_stage) &&
        preserved.ghl_stage != null &&
        policyStatusUnchanged
      return {
        ...e,
        ghl_name: isEmptyOrDash(e.ghl_name) && preserved.ghl_name != null ? preserved.ghl_name : e.ghl_name,
        ghl_stage: restoreGhlStage ? preserved.ghl_stage : e.ghl_stage,
      }
    })
  }

  const BATCH_SIZE = 500
  let saved = 0
  let failed = 0

  const totalBatches = Math.ceil(cleanEntries.length / BATCH_SIZE)

  for (let i = 0; i < cleanEntries.length; i += BATCH_SIZE) {
    const batchNum = i / BATCH_SIZE + 1
    const batch = cleanEntries.slice(i, i + BATCH_SIZE)
    log(`Saving batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} rows)...`)

    const { error } = await supabase
      .from('deal_tracker')
      .upsert(batch, { onConflict: 'agency_carrier_id,policy_number', ignoreDuplicates: false })

    if (error) {
      console.error('[Deal Tracker] Batch save failed:', error)
      failed += batch.length
      log(`Batch ${batchNum} failed: ${error.message || 'unknown error'}`)
    } else {
      saved += batch.length
      log(`Saved ${saved.toLocaleString()}/${cleanEntries.length.toLocaleString()} rows`)
    }
  }

  log(`Batch save complete. Saved ${saved.toLocaleString()} rows, failed ${failed.toLocaleString()}.`)

  // We no longer distinguish inserted vs updated here; both are "saved".
  return { inserted: saved, updated: 0, failed }
}

/**
 * Fallback: Save entries individually (slower but more reliable)
 */
async function saveDealTrackerEntriesIndividual(
  entries: DealTrackerEntry[] | DealTrackerPreviewEntry[]
): Promise<{ inserted: number; updated: number; failed: number }> {
  let inserted = 0
  let updated = 0
  let failed = 0

  for (const entry of entries) {
    try {
      const {
        isNew,
        isUpdated,
        changedFields,
        previousValues,
        commission_date: _commissionDatePreviewOnly,
        id,
        created_at,
        updated_at,
        ...dbEntry
      } = entry as any

      const { data: existing, error: checkError } = await supabase
        .from('deal_tracker')
        .select('id')
        .eq('agency_carrier_id', dbEntry.agency_carrier_id)
        .eq('policy_number', dbEntry.policy_number)
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') {
        console.error(`Failed to check existing entry for policy ${dbEntry.policy_number}:`, checkError)
      }

      if (existing) {
        const { error } = await supabase
          .from('deal_tracker')
          .update(dbEntry)
          .eq('id', existing.id)

        if (error) {
          console.error(`Failed to update entry for policy ${dbEntry.policy_number}:`, error)
          failed++
        } else {
          updated++
        }
      } else {
        const { error } = await supabase
          .from('deal_tracker')
          .insert(dbEntry)

        if (error) {
          console.error(`Failed to insert entry for policy ${dbEntry.policy_number}:`, error)
          failed++
        } else {
          inserted++
        }
      }
    } catch (error) {
      console.error(`Error processing entry for policy ${(entry as any).policy_number}:`, error)
      failed++
    }
  }

  return { inserted, updated, failed }
}

/** Deals created within this window (ms) are shown in the "New" tab. */
const NEW_DEAL_WINDOW_MS = 24 * 60 * 60 * 1000 // 24 hours

/**
 * Get all deal tracker entries.
 * When limit > 1000, fetches in pages (Supabase returns at most 1000 rows per request).
 * Sets isNew: true for rows whose created_at is within NEW_DEAL_WINDOW_MS so the Deal Tracker "New" tab works.
 */
export async function getDealTrackerEntries(filters?: {
  agency_carrier_id?: string
  carrier?: string
  agency_name?: string
  policy_status?: string
  ghl_stage?: string
  sales_agent?: string
  call_center?: string
  search?: string
  date_from?: string
  date_to?: string
  deal_value_min?: number
  deal_value_max?: number
  limit?: number
  offset?: number
  count?: 'exact'
}) {
  const requestedLimit = filters?.limit ?? 1000
  const offset = filters?.offset ?? 0
  const useExactCount = filters?.count === 'exact'
  const searchTerm = String(filters?.search ?? '').trim()

  const buildQuery = () => {
    let q = supabase
      .from('deal_tracker')
      .select(`
        *,
        agency_carriers (
          id,
          agencies (
            id,
            name
          ),
          carriers (
            id,
            name
          )
        )
      `, useExactCount ? { count: 'exact' } : undefined)
      .order('created_at', { ascending: false })

    if (filters?.agency_carrier_id) {
      q = q.eq('agency_carrier_id', filters.agency_carrier_id)
    }
    if (filters?.carrier) {
      q = q.eq('carrier', filters.carrier)
    }
    if (filters?.agency_name) {
      q = q.eq('agency_carriers.agencies.name', filters.agency_name)
    }
    if (filters?.policy_status) {
      q = q.eq('policy_status', filters.policy_status)
    }
    if (filters?.ghl_stage) {
      q = q.eq('ghl_stage', filters.ghl_stage)
    }
    if (filters?.sales_agent) {
      q = q.eq('sales_agent', filters.sales_agent)
    }
    if (filters?.call_center) {
      q = q.eq('call_center', filters.call_center)
    }
    if (filters?.date_from) {
      q = q.gte('deal_creation_date', filters.date_from)
    }
    if (filters?.date_to) {
      q = q.lte('deal_creation_date', filters.date_to)
    }
    if (typeof filters?.deal_value_min === 'number' && Number.isFinite(filters.deal_value_min)) {
      q = q.gte('deal_value', filters.deal_value_min)
    }
    if (typeof filters?.deal_value_max === 'number' && Number.isFinite(filters.deal_value_max)) {
      q = q.lte('deal_value', filters.deal_value_max)
    }
    if (searchTerm.length > 0) {
      const safe = searchTerm
        .replace(/[%*(),]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (safe.length > 0) {
        q = q.or(
          [
            `name.ilike.*${safe}*`,
            `ghl_name.ilike.*${safe}*`,
            `policy_number.ilike.*${safe}*`,
            `sales_agent.ilike.*${safe}*`,
            `call_center.ilike.*${safe}*`,
            `phone_number.ilike.*${safe}*`,
            `writing_number.ilike.*${safe}*`,
          ].join(',')
        )
      }
    }
    return q
  }

  const enrichStatus = (row: any) => {
    const createdMs = row?.created_at ? new Date(row.created_at).getTime() : 0
    const isNew = !!row?.created_at && Date.now() - createdMs < NEW_DEAL_WINDOW_MS
    return {
      ...row,
      status: statusFromDealValueAndChargeback(row?.deal_value, row?.charge_back) ?? row?.status,
      isNew,
    }
  }

  // Supabase caps at 1000 rows per request; paginate when we need more
  if (requestedLimit > SUPABASE_PAGE_SIZE) {
    const allRows = await fetchAllPaginated(() => buildQuery())
    const withOffset = offset > 0 ? allRows.slice(offset, offset + requestedLimit) : allRows.slice(0, requestedLimit)
    return withOffset.map(enrichStatus)
  }

  let query = buildQuery()
  if (requestedLimit) {
    query = query.limit(requestedLimit)
  }
  if (offset > 0) {
    query = query.range(offset, offset + (requestedLimit || 100) - 1)
  }

  const { data, error, count } = await query

  if (error) {
    throw new Error(`Failed to fetch deal tracker entries: ${error.message}`)
  }
  const rows = (data || []).map(enrichStatus)
  if (filters?.count === 'exact') {
    return { rows, count: count ?? 0 }
  }
  return rows
}
