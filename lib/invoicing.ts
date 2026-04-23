import { supabase } from './supabaseClient'
import { createClient } from '@supabase/supabase-js'
import { normalizeNameForSearch } from './dealTracker'

export type InvoicingStatus =
  | 'new_sale'
  | 'New Charge Back'
  | 'repay'
  | 'rechargeback'
  | 'paid_delete'
  | 'cb_delete'
  | 'cb_never_paid'
  | 'cb_repay'

/** Short label for BPO invoice rows and summaries. */
export function formatInvoicingStatusLabel(status: InvoicingStatus): string {
  switch (status) {
    case 'new_sale':
      return 'New sale'
    case 'New Charge Back':
      return 'New chargeback'
    case 'repay':
      return 'Repay'
    case 'rechargeback':
      return 'Rechargeback'
    case 'paid_delete':
      return 'Paid delete'
    case 'cb_delete':
      return 'CB delete'
    case 'cb_never_paid':
      return 'CB never paid'
    case 'cb_repay':
      return 'CB repay'
    default:
      return String(status)
  }
}

function isChargebackLikeStatus(current: InvoicingStatus | null): boolean {
  if (current == null) return false
  return current === 'New Charge Back' || current === 'rechargeback' || current === ('chargeback' as InvoicingStatus)
}

const CUSTOMER_PIPELINE_STAGE_LABELS = [
  'Issued - Pending First Draft',
  'Premium Paid - Commission Pending',
  'ACTIVE PLACED - Paid as Earned',
  'ACTIVE PLACED - Paid as Advanced',
  // GHL / exports often use title case on "Active Placed"; DB equality is case-sensitive for `.in()`.
  'Active Placed - Paid as Earned',
  'Active Placed - Paid as Advanced',
  'ACTIVE - 3 Months +',
  'ACTIVE - 6 months +',
  'ACTIVE - 9 months',
  'ACTIVE - Past Charge-Back Period',
]

/** Exact strings for Supabase `.in('ghl_stage', …)` — must match DB values (case-sensitive). */
const CUSTOMER_PIPELINE_STAGE_LABELS_FOR_QUERY = Array.from(
  new Set([...CUSTOMER_PIPELINE_STAGE_LABELS, ...CUSTOMER_PIPELINE_STAGE_LABELS.map((s) => s.toLowerCase())]),
)

const CUSTOMER_PIPELINE_STAGES = new Set(
  CUSTOMER_PIPELINE_STAGE_LABELS.map((s) => s.toLowerCase()),
)

const INVOICE_EXCLUDED_CARRIER_CODES = new Set(['CICA', 'GTL'])
const TECHVATED_DRAFT_CUTOFF_YMD = '2025-07-01'

export function normalizeCallCenterName(callCenter: string | null | undefined): string {
  const raw = String(callCenter ?? '').trim()
  if (!raw) return 'Unassigned'
  const compact = raw.replace(/\s+/g, ' ').toLowerCase()
  if (
    compact === 'seller' ||
    compact === 'sellerz' ||
    compact === 'sellerzbpo' ||
    compact === 'sellerz bpo' ||
    compact === 'seller z bpo'
  ) return 'Jason BPO'
  if (compact === 'jasonbpo' || compact === 'jason bpo') return 'Jason BPO'
  if (compact === 'argon comm') return 'Argon Comm BPO'
  if (compact === 'argon comm bpo') return 'Argon Comm BPO'
  if (compact === 'ark tech') return 'ArkTech BPO'
  if (compact === 'arktech bpo') return 'ArkTech BPO'
  if (compact === 'corebiz' || compact === 'corebiz bpo') return 'CoreBiz BPO'
  if (compact === 'crossnotch') return 'CrossNotch BPO'
  if (compact === 'crossnotch bpo') return 'CrossNotch BPO'
  if (compact === 'downtown') return 'DownTown BPO'
  if (compact === 'downtown bpo') return 'DownTown BPO'
  if (compact === 'plexi') return 'Plexi BPO'
  if (compact === 'plexi bpo') return 'Plexi BPO'
  if (compact === 'pro soliutions bpo') return 'Pro Solutions BPO'
  if (compact === 'internal') return 'Internal BPO'
  if (compact === 'inrernal bpo') return 'Internal BPO'
  if (compact === 'zupax marketing') return 'Zupax Marketing'
  if (compact === 'the zupax marketing') return 'Zupax Marketing'
  if (compact === 'zupax bpo') return 'Zupax Marketing'
  if (compact === 'the zupax bpo') return 'Zupax Marketing'
  return raw
}

function callCenterFilterCandidates(filterCallCenter: string | null | undefined): string[] {
  const normalized = normalizeCallCenterName(filterCallCenter)
  if (!normalized) return []
  const out = new Set<string>([normalized, String(filterCallCenter ?? '').trim()])
  if (normalized === 'Jason BPO') {
    out.add('Seller')
    out.add('SellerZ')
    out.add('SELLERZ')
    out.add('SellerzBpo')
    out.add('Sellerz BPO')
    out.add('SellerZ BPO')
    out.add('SellerZBPO')
    out.add('sellerzbpo')
    out.add('sellerz bpo')
    out.add('sellerz')
    out.add('Jason BPO')
    out.add('jasonbpo')
    out.add('jason bpo')
  }
  if (normalized === 'DownTown BPO') {
    out.add('DownTown BPO')
    out.add('Downtown BPO')
    out.add('downtown bpo')
    out.add('Downtown')
    out.add('downtown')
  }
  if (normalized === 'ArkTech BPO') {
    out.add('Ark Tech')
    out.add('ArkTech BPO')
    out.add('ark tech')
    out.add('arktech bpo')
  }
  if (normalized === 'CoreBiz BPO') {
    out.add('Corebiz')
    out.add('Corebiz BPO')
    out.add('CoreBiz BPO')
    out.add('corebiz')
    out.add('corebiz bpo')
  }
  if (normalized === 'Plexi BPO') {
    out.add('Plexi')
    out.add('Plexi BPO')
    out.add('plexi')
    out.add('plexi bpo')
  }
  if (normalized === 'Pro Solutions BPO') {
    out.add('Pro Solutions BPO')
    out.add('Pro Soliutions BPO')
    out.add('pro solutions bpo')
    out.add('pro soliutions bpo')
  }
  if (normalized === 'Internal BPO') {
    out.add('Internal')
    out.add('Internal BPO')
    out.add('Inrernal BPO')
    out.add('internal')
    out.add('internal bpo')
    out.add('inrernal bpo')
  }
  if (normalized === 'Zupax Marketing') {
    out.add('Zupax Marketing')
    out.add('The Zupax Marketing')
    out.add('Zupax BPO')
    out.add('The Zupax BPO')
    out.add('zupax marketing')
    out.add('the zupax marketing')
    out.add('zupax bpo')
    out.add('the zupax bpo')
  }
  return Array.from(out).map((v) => v.trim()).filter(Boolean)
}

function matchesCallCenterFilter(callCenter: string | null | undefined, filterCallCenter: string | null | undefined): boolean {
  if (!filterCallCenter) return true
  return normalizeCallCenterName(callCenter) === normalizeCallCenterName(filterCallCenter)
}

function isCustomerPipelineStage(stage: string | null | undefined): boolean {
  if (!stage) return false
  const s = stage.trim().toLowerCase()
  if (!s) return false
  return CUSTOMER_PIPELINE_STAGES.has(s)
}

function isExcludedCarrierForInvoice(carrier: string | null | undefined): boolean {
  const c = String(carrier ?? '').toUpperCase()
  for (const code of INVOICE_EXCLUDED_CARRIER_CODES) {
    if (new RegExp(`\\b${code}\\b`, 'i').test(c)) return true
  }
  return false
}

function isTechvatedBeforeCutoff(callCenter: string | null | undefined, draftLikeDate: string | null | undefined): boolean {
  const cc = String(callCenter ?? '').trim().toLowerCase()
  if (!cc.includes('techvated')) return false
  if (!draftLikeDate) return false
  const iso = String(draftLikeDate).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const ymd = `${iso[1]}-${iso[2]}-${iso[3]}`
    return ymd < TECHVATED_DRAFT_CUTOFF_YMD
  }
  const d = new Date(String(draftLikeDate))
  if (Number.isNaN(d.getTime())) return false
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}` < TECHVATED_DRAFT_CUTOFF_YMD
}

function shouldExcludeInvoiceEntry(
  carrier: string | null | undefined,
  callCenter: string | null | undefined,
  draftLikeDate: string | null | undefined,
): boolean {
  if (isExcludedCarrierForInvoice(carrier)) return true
  if (isTechvatedBeforeCutoff(callCenter, draftLikeDate)) return true
  return false
}

function isBillableStatus(status: InvoicingStatus): boolean {
  return status !== 'paid_delete' && status !== 'cb_delete' && status !== 'cb_never_paid'
}

type CommissionEventRow = {
  id: string
  agency_carrier_id: string
  carrier: string
  policy_number: string
  name: string | null
  date: string
  advance_amount: number | null
  charge_back_amount: number | null
}

type CommissionAggregateRow = {
  id: string
  agency_carrier_id: string
  carrier: string
  policy_number: string
  name: string | null
  date: string
  sales_agent?: string | null
  commission_rate?: number | null
  advance_amount: number | null
  charge_back_amount: number | null
}

type DealTrackerCallCenterRow = {
  agency_carrier_id: string
  policy_number: string
  call_center: string | null
  carrier?: string | null
  ghl_stage?: string | null
  deal_value?: number | null
  cc_value?: number | null
  name?: string | null
  policy_type?: string | null
  sales_agent?: string | null
  commission_type?: string | null
  effective_date?: string | null
  deal_creation_date?: string | null
  updated_at?: string | null
  created_at?: string | null
}

export type InvoiceEvent = {
  eventId: string
  date: string
  carrier: string
  advanceAmount: number
  chargeBackAmount: number
  grossAmount: number
  invoicingStatus: InvoicingStatus
}

export type InvoicePolicyDraft = {
  policyKey: string
  agencyCarrierId: string
  policyNumber: string
  carrier: string
  policyName: string
  callCenter: string
  latestCommissionDate: string
  latestInvoicingStatus: InvoicingStatus
  grossNet: number
  ccNet: number
  events: InvoiceEvent[]
}

export type InvoiceCallCenterGroup = {
  callCenter: string
  grossTotal: number
  ccInvoiceTotal: number
  policyCount: number
  policies: InvoicePolicyDraft[]
}

export type InvoiceDraftResult = {
  startDate: string
  endDate: string
  groups: InvoiceCallCenterGroup[]
  grossGrandTotal: number
  ccGrandTotal: number
}

function toNumber(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return 0
  return value
}

function normalizeChargeBack(value: number): number {
  if (value === 0) return 0
  return value > 0 ? -value : value
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

function deriveNextStatus(current: InvoicingStatus | null, grossAmount: number): InvoicingStatus {
  if (grossAmount === 0) return current ?? 'new_sale'

  // Sale event
  if (grossAmount > 0) {
    // Already paid previously: do not pay again.
    if (current === 'new_sale' || current === 'repay' || current === 'cb_repay') return 'paid_delete'
    // Recovering from prior chargeback.
    if (isChargebackLikeStatus(current)) return 'repay'
    return 'new_sale'
  }

  // Chargeback event
  if (current === 'repay') return 'rechargeback'
  // Already chargebacked previously: do not charge back again.
  if (isChargebackLikeStatus(current)) return 'cb_delete'
  // We can only charge back if this lead was paid before.
  if (current === 'cb_repay') return 'cb_delete'
  if (current === 'new_sale' || current === 'paid_delete') return 'New Charge Back'
  return 'cb_never_paid'
}

function parseSortableTimestamp(row: DealTrackerCallCenterRow): number {
  const raw = row.updated_at || row.created_at || ''
  const parsed = raw ? new Date(raw).getTime() : 0
  return Number.isNaN(parsed) ? 0 : parsed
}

function normalizePolicyNumber(policyNumber: string | null | undefined): string {
  const raw = String(policyNumber ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+/, '') || '0'
}

function policyLookupCandidates(policyNumber: string | null | undefined): string[] {
  const raw = String(policyNumber ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return []
  if (!/^\d+$/.test(raw)) return [raw]
  const stripped = raw.replace(/^0+/, '') || '0'
  const out = new Set<string>([raw, stripped])
  for (let len = Math.max(raw.length, stripped.length); len <= 12; len++) {
    if (stripped.length > len) continue
    out.add(stripped.padStart(len, '0'))
  }
  return Array.from(out)
}

/** Collapse duplicate commission rows for the same agency/policy/day into one summed transaction. */
function aggregateCommissionRows<T extends CommissionAggregateRow>(rows: T[]): T[] {
  const grouped = new Map<string, T>()
  for (const row of rows) {
    const key = `${row.agency_carrier_id}::${normalizePolicyNumber(row.policy_number)}::${row.date}`
    const existing = grouped.get(key)
    if (!existing) {
      grouped.set(key, {
        ...row,
        advance_amount: roundMoney(toNumber(row.advance_amount)),
        charge_back_amount: roundMoney(toNumber(row.charge_back_amount)),
      })
      continue
    }
    const nextAdvance = roundMoney(toNumber(existing.advance_amount) + toNumber(row.advance_amount))
    const nextChargeback = roundMoney(toNumber(existing.charge_back_amount) + toNumber(row.charge_back_amount))
    const carrier = existing.carrier?.trim() ? existing.carrier : row.carrier
    const name = existing.name?.trim() ? existing.name : row.name
    const salesAgent = (existing.sales_agent && String(existing.sales_agent).trim())
      ? existing.sales_agent
      : row.sales_agent
    const commissionRate = existing.commission_rate != null ? existing.commission_rate : row.commission_rate
    grouped.set(key, {
      ...existing,
      id: `${existing.id}+${row.id}`,
      carrier,
      name,
      sales_agent: salesAgent ?? null,
      commission_rate: commissionRate ?? null,
      advance_amount: nextAdvance,
      charge_back_amount: nextChargeback,
    })
  }
  return Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date))
}

function buildPolicyKey(agencyCarrierId: string, policyNumber: string): string {
  return `${agencyCarrierId}::${normalizePolicyNumber(policyNumber)}`
}

function dealRowTimestamp(row: { updated_at?: string | null; created_at?: string | null }): number {
  return new Date(row.updated_at || row.created_at || 0).getTime()
}

/** Group deal rows by normalized policy number when commission `agency_carrier_id` may not match deal's. */
function indexDealsByNormalizedPolicy<T extends { policy_number: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const row of rows) {
    const n = normalizePolicyNumber(row.policy_number)
    if (!n) continue
    const list = m.get(n) || []
    list.push(row)
    m.set(n, list)
  }
  return m
}

type DealLookupTx = { agency_carrier_id: string; carrier: string; policy_number: string }

/**
 * Prefer exact `agency_carrier_id` + policy key; else pick a deal for the same normalized policy:
 * same agency as commission if unique, else same carrier name as commission, else most recently updated.
 */
function resolveDealForCommission<T extends DealTrackerCallCenterRow>(
  tx: DealLookupTx,
  dealByPolicyKey: Map<string, T>,
  byNormPolicy: Map<string, T[]>,
): T | undefined {
  const key = buildPolicyKey(tx.agency_carrier_id, tx.policy_number)
  const exact = dealByPolicyKey.get(key)
  if (exact) return exact
  const candidates = byNormPolicy.get(normalizePolicyNumber(tx.policy_number))
  if (!candidates?.length) return undefined
  if (candidates.length === 1) return candidates[0]

  const aid = tx.agency_carrier_id
  const matchAgency = candidates.filter((d) => d.agency_carrier_id === aid)
  if (matchAgency.length === 1) return matchAgency[0]
  if (matchAgency.length > 1) {
    return [...matchAgency].sort((a, b) => dealRowTimestamp(b) - dealRowTimestamp(a))[0]
  }

  const carrier = (tx.carrier || '').trim().toLowerCase()
  const matchCarrier = candidates.filter((d) => (d.carrier || '').trim().toLowerCase() === carrier)
  const pool = matchCarrier.length > 0 ? matchCarrier : candidates
  return [...pool].sort((a, b) => dealRowTimestamp(b) - dealRowTimestamp(a))[0]
}

const CHARGEBACK_STAGE_LABELS = [
  'FDPF Pending Reason',
  'Pending Lapse Pending Reason',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Insufficient Funds',
  'Pending Lapse Unauthorized Draft',
  'FDPF Insufficient Funds',
  'FDPF Incorrect Banking Info',
  'FDPF Unauthorized Draft',
  'Pending Failed Payment Fix',
  'Pending Lapse',
  'Chargeback Failed Payment',
  'Chargeback Cancellation',
  'Pending Chargeback Fix',
  'Chargeback Fixed',
  'Chargeback DQ',
]

const CHARGEBACK_PIPELINE_STAGES = new Set(
  CHARGEBACK_STAGE_LABELS.map((s) => s.toLowerCase()),
)

function isChargebackPipelineStage(stage: string | null | undefined): boolean {
  if (!stage) return false
  return CHARGEBACK_PIPELINE_STAGES.has(stage.trim().toLowerCase())
}

/** Split an array into chunks of `size` to keep Supabase URL lengths manageable. */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Standard policy term in months used for pro-rating stage-only chargebacks. */
const POLICY_TERM_MONTHS = 9

/**
 * Calculate months elapsed between a policy effective date and a reference date.
 * Returns 0 when the effective date is missing or in the future.
 */
function monthsActive(effectiveDate: string | null | undefined, referenceDate: string): number {
  if (!effectiveDate) return 0
  const eff = new Date(effectiveDate)
  const ref = new Date(referenceDate)
  if (Number.isNaN(eff.getTime()) || Number.isNaN(ref.getTime())) return 0
  if (ref.getTime() < eff.getTime()) return 0
  let months = (ref.getFullYear() - eff.getFullYear()) * 12 + (ref.getMonth() - eff.getMonth())
  // Count only completed months. Example: Apr 3 -> Apr 26 is 0 months;
  // Apr 3 -> May 4 is 1 month because the monthly anniversary has passed.
  if (ref.getDate() < eff.getDate()) {
    months -= 1
  }
  return Math.max(0, months)
}

/**
 * Pro-rate a chargeback amount for stage-only chargebacks.
 * full cc value = dealValue / 2, split into POLICY_TERM_MONTHS parts,
 * chargeback only the remaining (unpaid) months.
 * Returns the pro-rated *lead value* (cc share, i.e. 50% side) as a negative number.
 */
function proRatedChargebackLeadValue(dealValue: number, effectiveDate: string | null | undefined, referenceDate: string): number {
  const active = monthsActive(effectiveDate, referenceDate)
  const remaining = Math.max(0, POLICY_TERM_MONTHS - active)
  if (remaining === 0) return 0
  const ccValue = dealValue / 2
  const monthlyCC = ccValue / POLICY_TERM_MONTHS
  return roundMoney(-(monthlyCC * remaining))
}

async function batchFetchPoliciesWithAnyChargebackCommission(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<Set<string>> {
  const matches = new Set<string>()
  if (!policyNumbers.length || !agencyCarrierIds.length) return matches
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, charge_back_amount')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .not('charge_back_amount', 'is', null)
      .neq('charge_back_amount', 0)
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{ agency_carrier_id: string; policy_number: string }>) {
      matches.add(buildPolicyKey(row.agency_carrier_id, row.policy_number))
    }
  }
  return matches
}

/** Latest chargeback statement amount (gross) per policy key, across all dates. */
async function batchFetchLatestChargebackGrossByPolicy(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!policyNumbers.length || !agencyCarrierIds.length) return out
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, charge_back_amount, date, created_at')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .not('charge_back_amount', 'is', null)
      .neq('charge_back_amount', 0)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{
      agency_carrier_id: string
      policy_number: string
      charge_back_amount: number | null
    }>) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      if (out.has(key)) continue
      const gross = roundMoney(normalizeChargeBack(toNumber(row.charge_back_amount)))
      if (gross === 0) continue
      out.set(key, gross)
    }
  }
  return out
}

type LatestCommissionSignal = {
  latestKind: 'sale' | 'chargeback' | null
  latestSaleGross: number | null
  latestChargebackGross: number | null
}

type CommissionFacts = {
  latestSignalsByPolicy: Map<string, LatestCommissionSignal>
  latestChargebackGrossByPolicy: Map<string, number>
  policiesWithAnyChargebackCommission: Set<string>
  policiesWithAnyPositiveCommission: Set<string>
}

/** Fetch all commission facts in one pass to avoid duplicate large REST calls. */
async function batchFetchCommissionFacts(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<CommissionFacts> {
  const latestSignalsByPolicy = new Map<string, LatestCommissionSignal>()
  const latestChargebackGrossByPolicy = new Map<string, number>()
  const policiesWithAnyChargebackCommission = new Set<string>()
  const policiesWithAnyPositiveCommission = new Set<string>()
  if (!policyNumbers.length || !agencyCarrierIds.length) {
    return {
      latestSignalsByPolicy,
      latestChargebackGrossByPolicy,
      policiesWithAnyChargebackCommission,
      policiesWithAnyPositiveCommission,
    }
  }
  const BATCH_SIZE = 300
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, advance_amount, charge_back_amount, date, created_at')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{
      agency_carrier_id: string
      policy_number: string
      advance_amount: number | null
      charge_back_amount: number | null
    }>) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      const advance = roundMoney(toNumber(row.advance_amount))
      const cbGross = roundMoney(normalizeChargeBack(toNumber(row.charge_back_amount)))
      if (advance > 0) policiesWithAnyPositiveCommission.add(key)
      if (cbGross < 0) policiesWithAnyChargebackCommission.add(key)
      const cur =
        latestSignalsByPolicy.get(key) || {
          latestKind: null,
          latestSaleGross: null,
          latestChargebackGross: null,
        }
      if (cur.latestKind == null) {
        if (cbGross < 0) cur.latestKind = 'chargeback'
        else if (advance > 0) cur.latestKind = 'sale'
      }
      if (cur.latestSaleGross == null && advance > 0) cur.latestSaleGross = advance
      if (cur.latestChargebackGross == null && cbGross < 0) cur.latestChargebackGross = cbGross
      latestSignalsByPolicy.set(key, cur)
      if (!latestChargebackGrossByPolicy.has(key) && cbGross < 0) latestChargebackGrossByPolicy.set(key, cbGross)
    }
  }
  return {
    latestSignalsByPolicy,
    latestChargebackGrossByPolicy,
    policiesWithAnyChargebackCommission,
    policiesWithAnyPositiveCommission,
  }
}

/** Latest commission signal per policy key across all dates (sale/chargeback + amounts). */
async function batchFetchLatestCommissionSignalByPolicy(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<Map<string, LatestCommissionSignal>> {
  const out = new Map<string, LatestCommissionSignal>()
  if (!policyNumbers.length || !agencyCarrierIds.length) return out
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, advance_amount, charge_back_amount, date, created_at')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{
      agency_carrier_id: string
      policy_number: string
      advance_amount: number | null
      charge_back_amount: number | null
    }>) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      const cur =
        out.get(key) || {
          latestKind: null,
          latestSaleGross: null,
          latestChargebackGross: null,
        }
      const advance = roundMoney(toNumber(row.advance_amount))
      const cbGross = roundMoney(normalizeChargeBack(toNumber(row.charge_back_amount)))
      if (cur.latestKind == null) {
        if (cbGross < 0) cur.latestKind = 'chargeback'
        else if (advance > 0) cur.latestKind = 'sale'
      }
      if (cur.latestSaleGross == null && advance > 0) cur.latestSaleGross = advance
      if (cur.latestChargebackGross == null && cbGross < 0) cur.latestChargebackGross = cbGross
      out.set(key, cur)
    }
  }
  return out
}

async function batchFetchPoliciesWithAnyPositiveCommission(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<Set<string>> {
  const matches = new Set<string>()
  if (!policyNumbers.length || !agencyCarrierIds.length) return matches
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, advance_amount')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .not('advance_amount', 'is', null)
      .gt('advance_amount', 0)
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{ agency_carrier_id: string; policy_number: string }>) {
      matches.add(buildPolicyKey(row.agency_carrier_id, row.policy_number))
    }
  }
  return matches
}

/** Paginated fetch for deal_tracker rows in chargeback pipeline stages (can exceed Supabase default 1000-row limit). */
async function fetchAllChargebackStageDeals<T extends Record<string, unknown>>(selectCols: string): Promise<T[]> {
  const PAGE_SIZE = 1000
  const allRows: T[] = []
  let offset = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select(selectCols)
      .in('ghl_stage', CHARGEBACK_STAGE_LABELS)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = (data || []) as unknown as T[]
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

async function fetchAllChargebackStageDealsByCallCenter<T extends Record<string, unknown>>(
  selectCols: string,
  callCenter: string,
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const allRows: T[] = []
  let offset = 0
  const centerCandidates = callCenterFilterCandidates(callCenter)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select(selectCols)
      .in('ghl_stage', CHARGEBACK_STAGE_LABELS)
      .in('call_center', centerCandidates)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = (data || []) as unknown as T[]
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

/** Paginated fetch for deal_tracker rows in customer pipeline stages. */
async function fetchAllCustomerPipelineDeals<T extends Record<string, unknown>>(selectCols: string): Promise<T[]> {
  const PAGE_SIZE = 1000
  const allRows: T[] = []
  let offset = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select(selectCols)
      .in('ghl_stage', CUSTOMER_PIPELINE_STAGE_LABELS_FOR_QUERY)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = (data || []) as unknown as T[]
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

async function fetchAllCustomerPipelineDealsByCallCenter<T extends Record<string, unknown>>(
  selectCols: string,
  callCenter: string,
): Promise<T[]> {
  const PAGE_SIZE = 1000
  const allRows: T[] = []
  let offset = 0
  const centerCandidates = callCenterFilterCandidates(callCenter)
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select(selectCols)
      .in('ghl_stage', CUSTOMER_PIPELINE_STAGE_LABELS_FOR_QUERY)
      .in('call_center', centerCandidates)
      .range(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const rows = (data || []) as unknown as T[]
    allRows.push(...rows)
    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }
  return allRows
}

/** Batched query for invoicing_status_history across many policy numbers. */
async function batchFetchStatusHistory(
  policyNumbers: string[],
  agencyCarrierIds: string[],
): Promise<Array<{ agency_carrier_id: string; policy_number: string; invoicing_status: InvoicingStatus }>> {
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  const allRows: Array<{ agency_carrier_id: string; policy_number: string; invoicing_status: InvoicingStatus }> = []
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('invoicing_status_history')
      .select('agency_carrier_id, policy_number, invoicing_status, effective_date, created_at')
      .in('policy_number', batch)
      .in('agency_carrier_id', agencyCarrierIds)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) throw new Error(error.message)
    if (data) allRows.push(...(data as typeof allRows))
  }
  return allRows
}

export async function buildInvoiceDraft(
  startDate: string,
  endDate: string,
  filterCallCenter?: string | null,
): Promise<InvoiceDraftResult> {
  const scopedCenter = filterCallCenter ? normalizeCallCenterName(filterCallCenter) : null
  let scopedPolicyNumbersForCenter: string[] | null = null
  if (scopedCenter) {
    const centerCandidates = callCenterFilterCandidates(filterCallCenter)
    const { data: centerDeals, error: centerDealsError } = await supabase
      .from('deal_tracker')
      .select('policy_number')
      .in('call_center', centerCandidates)
      .not('policy_number', 'is', null)
    if (centerDealsError) throw new Error(centerDealsError.message)
    scopedPolicyNumbersForCenter = Array.from(
      new Set((centerDeals || []).map((r: { policy_number?: string | null }) => String(r.policy_number ?? '').trim()).filter(Boolean)),
    )
    if (scopedPolicyNumbersForCenter.length === 0) {
      return { startDate, endDate, groups: [], grossGrandTotal: 0, ccGrandTotal: 0 }
    }
  }

  const txQuery = supabase
    .from('commission_tracker')
    .select('id, agency_carrier_id, carrier, policy_number, name, date, advance_amount, charge_back_amount')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })
  const { data: txRows, error: txError } = scopedPolicyNumbersForCenter
    ? await txQuery.in('policy_number', scopedPolicyNumbersForCenter)
    : await txQuery

  if (txError) {
    throw new Error(txError.message)
  }

  const transactions = aggregateCommissionRows((txRows || []) as CommissionEventRow[])

  const policyNumbers = Array.from(
    new Set(
      transactions
        .flatMap((row) => policyLookupCandidates(row.policy_number))
        .filter((v) => v.length > 0),
    ),
  )
  const agencyCarrierIds = Array.from(new Set(transactions.map((row) => row.agency_carrier_id).filter(Boolean)))

  const latestStatusByPolicy = new Map<string, InvoicingStatus>()
  const callCenterByPolicy = new Map<string, { callCenter: string; ts: number }>()
  const dealByPolicy = new Map<string, DealTrackerCallCenterRow>()
  let dealsByNormPolicy = new Map<string, DealTrackerCallCenterRow[]>()

  if (policyNumbers.length > 0 && agencyCarrierIds.length > 0) {
    const { data: historyRows, error: historyError } = await supabase
      .from('invoicing_status_history')
      .select('agency_carrier_id, policy_number, invoicing_status, effective_date, created_at')
      .in('policy_number', policyNumbers)
      .in('agency_carrier_id', agencyCarrierIds)
      .lte('effective_date', startDate)
      .order('effective_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (historyError) {
      throw new Error(historyError.message)
    }

    for (const row of (historyRows || []) as Array<{
      agency_carrier_id: string
      policy_number: string
      invoicing_status: InvoicingStatus
    }>) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      if (!latestStatusByPolicy.has(key)) {
        latestStatusByPolicy.set(key, row.invoicing_status)
      }
    }
  }

  // Load deals by policy # only: commission rows may reference a different `agency_carrier_id` than deal_tracker.
  if (policyNumbers.length > 0) {
    const { data: dtRows, error: dtError } = await supabase
      .from('deal_tracker')
      .select('agency_carrier_id, policy_number, call_center, ghl_stage, deal_value, cc_value, updated_at, created_at')
      .in('policy_number', policyNumbers)

    if (dtError) {
      throw new Error(dtError.message)
    }

    const rows = (dtRows || []) as DealTrackerCallCenterRow[]
    dealsByNormPolicy = indexDealsByNormalizedPolicy(rows)

    for (const row of rows) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      const current = callCenterByPolicy.get(key)
      const nextTimestamp = parseSortableTimestamp(row)
      const nextCallCenter = normalizeCallCenterName(row.call_center)
      if (!current) {
        callCenterByPolicy.set(key, { callCenter: nextCallCenter, ts: nextTimestamp })
        dealByPolicy.set(key, row)
        continue
      }
      if (nextTimestamp >= current.ts && row.call_center?.trim()) {
        callCenterByPolicy.set(key, { callCenter: row.call_center.trim(), ts: nextTimestamp })
        dealByPolicy.set(key, row)
      }
    }
  }

  const policyMap = new Map<string, InvoicePolicyDraft>()
  const salesPolicyNumbersInDraft = new Set<string>()
  for (const tx of transactions) {
    const policyKey = buildPolicyKey(tx.agency_carrier_id, tx.policy_number)
    const existing = policyMap.get(policyKey)
    const deal = resolveDealForCommission(tx, dealByPolicy, dealsByNormPolicy)
    const entryCallCenter = deal?.call_center ?? callCenterByPolicy.get(policyKey)?.callCenter ?? null
    if (!matchesCallCenterFilter(entryCallCenter, filterCallCenter)) continue
    const entryDraftRaw = deal?.effective_date || deal?.deal_creation_date || tx.date
    const entryCarrier = tx.carrier || deal?.carrier || null
    if (shouldExcludeInvoiceEntry(entryCarrier, entryCallCenter, entryDraftRaw)) continue
    const advanceAmount = toNumber(tx.advance_amount)
    const chargeBackAmount = normalizeChargeBack(toNumber(tx.charge_back_amount))
    const grossAmount = roundMoney(advanceAmount + chargeBackAmount)

    if (!existing) {
      const priorStatus = latestStatusByPolicy.get(policyKey) ?? null
      const firstStatus = deriveNextStatus(priorStatus, grossAmount)
      const appliedGross = isBillableStatus(firstStatus) ? grossAmount : 0
      policyMap.set(policyKey, {
        policyKey,
        agencyCarrierId: tx.agency_carrier_id,
        policyNumber: tx.policy_number,
        carrier: tx.carrier,
        policyName: tx.name?.trim() || '-',
        callCenter: normalizeCallCenterName(deal?.call_center),
        latestCommissionDate: tx.date,
        latestInvoicingStatus: firstStatus,
        grossNet: appliedGross,
        ccNet: roundMoney(appliedGross / 2),
        events: [
          {
            eventId: tx.id,
            date: tx.date,
            carrier: tx.carrier,
            advanceAmount,
            chargeBackAmount,
            grossAmount: appliedGross,
            invoicingStatus: firstStatus,
          },
        ],
      })
      if (appliedGross > 0) salesPolicyNumbersInDraft.add(normalizePolicyNumber(tx.policy_number))
      continue
    }

    const nextStatus = deriveNextStatus(existing.latestInvoicingStatus, grossAmount)
    const appliedGross = isBillableStatus(nextStatus) ? grossAmount : 0
    existing.latestInvoicingStatus = nextStatus
    if ((!existing.policyName || existing.policyName === '-') && tx.name?.trim()) {
      existing.policyName = tx.name.trim()
    }
    existing.grossNet = roundMoney(existing.grossNet + appliedGross)
    existing.ccNet = roundMoney(existing.grossNet / 2)
    if (new Date(tx.date).getTime() >= new Date(existing.latestCommissionDate).getTime()) {
      existing.latestCommissionDate = tx.date
    }
    existing.events.push({
      eventId: tx.id,
      date: tx.date,
      carrier: tx.carrier,
      advanceAmount,
      chargeBackAmount,
      grossAmount: appliedGross,
      invoicingStatus: nextStatus,
    })
    if (appliedGross > 0) salesPolicyNumbersInDraft.add(normalizePolicyNumber(tx.policy_number))
  }

  const customerPipelineDealsDraft = scopedCenter
    ? await fetchAllCustomerPipelineDealsByCallCenter<DealTrackerCallCenterRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, cc_value, ghl_stage, updated_at, created_at',
        filterCallCenter as string,
      )
    : await fetchAllCustomerPipelineDeals<DealTrackerCallCenterRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, cc_value, ghl_stage, updated_at, created_at',
      )

  // ── Customer pipeline: sale from deal_tracker when there is no billable commission in this period
  // but deal_value and cc_value are populated (e.g. carrier paid / deal updated before commission_tracker sync).
  {
    const customerFinDeals = customerPipelineDealsDraft
    if (customerFinDeals.length > 0) {
      const finPolicyNums = Array.from(
        new Set(customerFinDeals.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const finAgencyIds = Array.from(new Set(customerFinDeals.map((d) => d.agency_carrier_id).filter(Boolean)))
      const finHistory = await batchFetchStatusHistory(finPolicyNums, finAgencyIds)
      const finFacts = await batchFetchCommissionFacts(finPolicyNums, finAgencyIds)
      const finSignals = finFacts.latestSignalsByPolicy
      const finStatusByKey = new Map<string, InvoicingStatus>()
      for (const row of finHistory) {
        const k = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!finStatusByKey.has(k)) finStatusByKey.set(k, row.invoicing_status)
      }
      for (const deal of customerFinDeals) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        const normalizedPolicy = normalizePolicyNumber(deal.policy_number)
        if (salesPolicyNumbersInDraft.has(normalizedPolicy)) continue
        const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
        const existingPm = policyMap.get(key)
        if (existingPm && roundMoney(existingPm.grossNet) !== 0) continue
        const dv = toNumber(deal.deal_value)
        if (dv <= 0) continue
        const signal = finSignals.get(key)
        const statementSaleGross = signal?.latestSaleGross ?? null
        const gross = statementSaleGross != null && statementSaleGross > 0
          ? roundMoney(statementSaleGross)
          : roundMoney(Math.abs(proRatedChargebackLeadValue(dv, deal.effective_date, endDate) * 2))
        if (gross <= 0) continue
        const priorStatus = finStatusByKey.get(key) ?? latestStatusByPolicy.get(key) ?? null
        const nextStatus = deriveNextStatus(priorStatus, gross)
        if (!isBillableStatus(nextStatus)) continue
        const callCenter = normalizeCallCenterName(deal.call_center)
        const dealCarrier = deal.carrier?.trim() || '—'
        const policyLabel = (deal.name?.trim() || '-')
        policyMap.set(key, {
          policyKey: key,
          agencyCarrierId: deal.agency_carrier_id,
          policyNumber: deal.policy_number,
          carrier: dealCarrier,
          policyName: policyLabel,
          callCenter,
          latestCommissionDate: endDate,
          latestInvoicingStatus: nextStatus,
          grossNet: gross,
          ccNet: roundMoney(gross / 2),
          events: [
            {
              eventId: `cp-deal-${key}`,
              date: endDate,
              carrier: dealCarrier,
              advanceAmount: gross,
              chargeBackAmount: 0,
              grossAmount: gross,
              invoicingStatus: nextStatus,
            },
          ],
        })
        if (gross > 0) salesPolicyNumbersInDraft.add(normalizedPolicy)
      }
    }
  }

  const cbStageDeals = scopedCenter
    ? await fetchAllChargebackStageDealsByCallCenter<DealTrackerCallCenterRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, policy_type, deal_value, ghl_stage, effective_date, updated_at, created_at',
        filterCallCenter as string,
      )
    : await fetchAllChargebackStageDeals<DealTrackerCallCenterRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, policy_type, deal_value, ghl_stage, effective_date, updated_at, created_at',
      )
  const cbStagePolicyNumbers = Array.from(
    new Set(cbStageDeals.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
  )
  const cbStageAgencyIds = Array.from(new Set(cbStageDeals.map((d) => d.agency_carrier_id).filter(Boolean)))
  const cbFacts = await batchFetchCommissionFacts(cbStagePolicyNumbers, cbStageAgencyIds)
  const policiesWithAnyChargebackCommission = cbFacts.policiesWithAnyChargebackCommission
  const latestSignalsByPolicy = cbFacts.latestSignalsByPolicy
  const latestChargebackGrossByPolicy = cbFacts.latestChargebackGrossByPolicy
  const referenceDate = endDate

  // Stage-driven chargeback: when a deal is in chargeback pipeline, add synthetic chargeback
  // if no chargeback event exists in the period.
  for (const policy of policyMap.values()) {
    const deal = resolveDealForCommission(
      {
        agency_carrier_id: policy.agencyCarrierId,
        carrier: policy.carrier,
        policy_number: policy.policyNumber,
      },
      dealByPolicy,
      dealsByNormPolicy,
    )
    if (!deal || !isChargebackPipelineStage(deal.ghl_stage)) continue
    if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
    const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
    if (shouldExcludeInvoiceEntry(policy.carrier || deal.carrier, deal.call_center, draftRaw)) continue
    const hasChargebackEvent = policy.events.some((e) => e.grossAmount < 0)
    if (hasChargebackEvent) continue
    const dealValue = toNumber(deal.deal_value)
    if (dealValue <= 0) continue
    const fullGross = roundMoney(-Math.abs(dealValue))
    const statusBeforeCb = policy.latestInvoicingStatus
    const nextStatus = deriveNextStatus(statusBeforeCb, fullGross)
    policy.latestInvoicingStatus = nextStatus
    if (!isBillableStatus(nextStatus)) continue
    const hasAnyCbCommission = policiesWithAnyChargebackCommission.has(policy.policyKey)
    const signal = latestSignalsByPolicy.get(policy.policyKey)
    const statementGross = latestChargebackGrossByPolicy.get(policy.policyKey)
    const useStatementChargeback =
      hasAnyCbCommission &&
      signal?.latestKind === 'chargeback' &&
      statementGross != null
    const stageGross = useStatementChargeback
      ? roundMoney(statementGross)
      : roundMoney(proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate) * 2)
    if (stageGross === 0) continue
    policy.grossNet = roundMoney(policy.grossNet + stageGross)
    policy.ccNet = roundMoney(policy.grossNet / 2)
    policy.events.push({
      eventId: `stage-cb-${policy.policyKey}`,
      date: endDate,
      carrier: policy.carrier,
      advanceAmount: 0,
      chargeBackAmount: stageGross,
      grossAmount: stageGross,
      invoicingStatus: nextStatus,
    })
  }

  // ── Stage-only chargebacks: policies in chargeback pipeline with NO commission events in this period ──
  {
    const unseen = cbStageDeals.filter((d) => {
      const key = buildPolicyKey(d.agency_carrier_id, d.policy_number)
      return !policyMap.has(key)
    })

    if (unseen.length > 0) {
      const unseenPolicyNumbers = Array.from(
        new Set(unseen.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const unseenAgencyIds = Array.from(new Set(unseen.map((d) => d.agency_carrier_id).filter(Boolean)))

      const hRows = await batchFetchStatusHistory(unseenPolicyNumbers, unseenAgencyIds)

      const unseenStatus = new Map<string, InvoicingStatus>()
      for (const row of hRows) {
        const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!unseenStatus.has(key)) unseenStatus.set(key, row.invoicing_status)
      }

      for (const deal of unseen) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (policyMap.has(key)) continue
        const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const priorStatus = unseenStatus.get(key) ?? null
        const fullGross = roundMoney(-Math.abs(dealValue))
        const nextStatus = deriveNextStatus(priorStatus, fullGross)
        if (!isBillableStatus(nextStatus)) continue
        const hasAnyCbCommission = policiesWithAnyChargebackCommission.has(key)
        const signal = latestSignalsByPolicy.get(key)
        const statementGross = latestChargebackGrossByPolicy.get(key)
        const useStatementChargeback =
          hasAnyCbCommission &&
          signal?.latestKind === 'chargeback' &&
          statementGross != null
        const stageGross = useStatementChargeback
          ? roundMoney(statementGross)
          : roundMoney(proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate) * 2)
        if (stageGross === 0) continue
        const callCenter = deal.call_center?.trim() || 'Unassigned'
        const dealCarrier = deal.carrier?.trim() || '—'
        policyMap.set(key, {
          policyKey: key,
          agencyCarrierId: deal.agency_carrier_id,
          policyNumber: deal.policy_number,
          carrier: dealCarrier,
          policyName: deal.name?.trim() || '-',
          callCenter,
          latestCommissionDate: endDate,
          latestInvoicingStatus: nextStatus,
          grossNet: stageGross,
          ccNet: roundMoney(stageGross / 2),
          events: [
            {
              eventId: `stage-cb-${key}`,
              date: endDate,
              carrier: dealCarrier,
              advanceAmount: 0,
              chargeBackAmount: stageGross,
              grossAmount: stageGross,
              invoicingStatus: nextStatus,
            },
          ],
        })
      }
    }
  }

  // ── Stage-only repays: customer pipeline policies can be repaid without in-range commission events ──
  {
    const customerDeals = customerPipelineDealsDraft
    const unseen = customerDeals.filter((d) => {
      const key = buildPolicyKey(d.agency_carrier_id, d.policy_number)
      return !policyMap.has(key)
    })
    if (unseen.length > 0) {
      const unseenPolicyNumbers = Array.from(
        new Set(unseen.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const unseenAgencyIds = Array.from(new Set(unseen.map((d) => d.agency_carrier_id).filter(Boolean)))
      const hRows = await batchFetchStatusHistory(unseenPolicyNumbers, unseenAgencyIds)
      const unseenFacts = await batchFetchCommissionFacts(unseenPolicyNumbers, unseenAgencyIds)
      const policiesWithAnyPositiveCommission = unseenFacts.policiesWithAnyPositiveCommission
      const unseenSignals = unseenFacts.latestSignalsByPolicy
      const unseenStatus = new Map<string, InvoicingStatus>()
      for (const row of hRows) {
        const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!unseenStatus.has(key)) unseenStatus.set(key, row.invoicing_status)
      }
      for (const deal of unseen) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (policyMap.has(key)) continue
        const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, draftRaw)) continue
        if (!policiesWithAnyPositiveCommission.has(key)) continue
        const priorStatus = unseenStatus.get(key) ?? null
        if (!(priorStatus == null || isChargebackLikeStatus(priorStatus))) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const callCenter = deal.call_center?.trim() || 'Unassigned'
        const dealCarrier = deal.carrier?.trim() || '—'
        const lastCbGross = unseenSignals.get(key)?.latestChargebackGross ?? null
        const repayGross = lastCbGross != null
          ? roundMoney(Math.abs(lastCbGross))
          : roundMoney(Math.abs(proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate) * 2))
        if (repayGross <= 0) continue
        policyMap.set(key, {
          policyKey: key,
          agencyCarrierId: deal.agency_carrier_id,
          policyNumber: deal.policy_number,
          carrier: dealCarrier,
          policyName: deal.name?.trim() || '-',
          callCenter,
          latestCommissionDate: endDate,
          latestInvoicingStatus: 'repay',
          grossNet: repayGross,
          ccNet: roundMoney(repayGross / 2),
          events: [
            {
              eventId: `stage-repay-${key}`,
              date: endDate,
              carrier: dealCarrier,
              advanceAmount: repayGross,
              chargeBackAmount: 0,
              grossAmount: repayGross,
              invoicingStatus: 'repay',
            },
          ],
        })
      }
    }
  }

  const grouped = new Map<string, InvoicePolicyDraft[]>()
  for (const policy of policyMap.values()) {
    if (roundMoney(policy.grossNet) === 0) continue
    const callCenter = normalizeCallCenterName(policy.callCenter)
    const list = grouped.get(callCenter) || []
    list.push(policy)
    grouped.set(callCenter, list)
  }

  const groups: InvoiceCallCenterGroup[] = Array.from(grouped.entries())
    .map(([callCenter, policies]) => {
      const grossTotal = roundMoney(policies.reduce((sum, p) => sum + p.grossNet, 0))
      const ccInvoiceTotal = roundMoney(policies.reduce((sum, p) => sum + p.ccNet, 0))
      return {
        callCenter,
        grossTotal,
        ccInvoiceTotal,
        policyCount: policies.length,
        policies: policies.sort((a, b) => a.policyNumber.localeCompare(b.policyNumber)),
      }
    })
    .sort((a, b) => a.callCenter.localeCompare(b.callCenter))

  const grossGrandTotal = roundMoney(groups.reduce((sum, g) => sum + g.grossTotal, 0))
  const ccGrandTotal = roundMoney(groups.reduce((sum, g) => sum + g.ccInvoiceTotal, 0))

  return {
    startDate,
    endDate,
    groups,
    grossGrandTotal,
    ccGrandTotal,
  }
}

/** Invoice shows 50% of gross commission advance / chargeback as “Lead value” (not full amounts). */
export const BPO_INVOICE_LEAD_VALUE_SHARE = 0.5

/** One visual row on the BPO invoice (sales or chargeback section). */
export type BpoInvoiceLine = {
  id: string
  insuredName: string
  /** Display amount: 50% of advance or chargeback (same basis as CC invoice). */
  leadValue: number
  /** Status applied to this line (same rules as invoicing ledger). */
  invoicingStatus: InvoicingStatus
  carrier: string
  product: string | null
  agentAccount: string
  draftDate: string
  monthlyPremium: number | null
  coverageAmount: number | null
  comPct: string | null
  comType: string
  policyNumber: string
}

/** Per call-center (BPO) invoice: sales block on top, chargebacks below. */
export type BpoInvoiceGroupDetail = {
  callCenter: string
  salesLines: BpoInvoiceLine[]
  chargebackLines: BpoInvoiceLine[]
  /** Sum of displayed Lead values (50% of advances) */
  newBusinessTotal: number
  /** Sum of displayed Lead values for chargebacks (50% of chargeback amounts; typically negative) */
  chargebacksTotal: number
  /** newBusinessTotal + chargebacksTotal (before last-week adjustment) */
  subtotal: number
}

export type BpoInvoiceDetailResult = {
  startDate: string
  endDate: string
  rangeLabel: string
  groups: BpoInvoiceGroupDetail[]
}

export type InvoiceDraftSnapshot = {
  dateFrom: string
  dateTo: string
  selectedCallCenter: string
  draft: InvoiceDraftResult
  bpoDetail: BpoInvoiceDetailResult
  previousChargebackByCallCenter: Record<string, string>
  excludedPolicyKeys: Record<string, true>
  excludedLineIds: Record<string, true>
  lineEdits: Record<string, Partial<BpoInvoiceLine>>
  pdfExportedByCenter: Record<string, true>
  savedAt: string
}

export type InvoiceDraftRecord = {
  id: string
  start_date: string
  end_date: string
  call_center_filter: string | null
  payload: InvoiceDraftSnapshot
  updated_at: string
}

export type LegacyInvoiceStatusSeedRow = {
  policyNumber: string
  carrier: string
  businessType: string | null
  weekDate: string | null
}

export function mapLegacyBusinessTypeToInvoicingStatus(value: string | null | undefined): InvoicingStatus | null {
  const v = (value || '').trim().toLowerCase()
  if (!v) return null
  if (v === 'new sales' || v === 'new sale') return 'new_sale'
  if (v === 'new charge back' || v === 'new chargeback') return 'New Charge Back'
  if (v === 'chargeback' || v === 'charge back') return 'New Charge Back'
  if (v === 're-charge back' || v === 're-chargeback') return 'rechargeback'
  if (v === 'repay') return 'repay'
  if (v === 'paid delete') return 'paid_delete'
  if (v === 'cb delete') return 'cb_delete'
  if (v === 'cb never paid') return 'cb_never_paid'
  if (v === 'cb repay') return 'cb_repay'
  return null
}

function parseUsDateToYmd(value: string | null | undefined): string | null {
  const s = (value || '').trim()
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return s
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!us) return null
  const mm = String(parseInt(us[1], 10)).padStart(2, '0')
  const dd = String(parseInt(us[2], 10)).padStart(2, '0')
  return `${us[3]}-${mm}-${dd}`
}

/**
 * One-time migration helper:
 * Seeds `invoicing_status_history` from old spreadsheet-style rows using `Business Type`.
 */
export async function seedInvoicingStatusHistoryFromLegacyRows(
  rows: LegacyInvoiceStatusSeedRow[],
): Promise<{ inserted: number }> {
  if (!rows.length) return { inserted: 0 }

  const normalized = rows
    .map((r) => ({
      policy_number: (r.policyNumber || '').trim(),
      carrier: (r.carrier || '').trim(),
      invoicing_status: mapLegacyBusinessTypeToInvoicingStatus(r.businessType),
      effective_date: parseUsDateToYmd(r.weekDate),
    }))
    .filter((r) => r.policy_number && r.carrier && r.invoicing_status && r.effective_date) as Array<{
    policy_number: string
    carrier: string
    invoicing_status: InvoicingStatus
    effective_date: string
  }>

  if (!normalized.length) return { inserted: 0 }

  const policyNumbers = Array.from(new Set(normalized.map((r) => r.policy_number)))
  const carriers = Array.from(new Set(normalized.map((r) => r.carrier)))

  const { data: dtRows, error: dtError } = await supabase
    .from('deal_tracker')
    .select('agency_carrier_id, policy_number, carrier')
    .in('policy_number', policyNumbers)
    .in('carrier', carriers)

  if (dtError) throw new Error(dtError.message)

  const agencyByCarrierPolicy = new Map<string, string>()
  for (const row of (dtRows || []) as Array<{ agency_carrier_id: string; policy_number: string; carrier: string }>) {
    agencyByCarrierPolicy.set(`${row.carrier}::${row.policy_number}`, row.agency_carrier_id)
  }

  const dedup = new Map<string, { agency_carrier_id: string; policy_number: string; carrier: string; invoicing_status: InvoicingStatus; effective_date: string }>()
  for (const row of normalized) {
    const agencyCarrierId = agencyByCarrierPolicy.get(`${row.carrier}::${row.policy_number}`)
    if (!agencyCarrierId) continue
    const k = `${agencyCarrierId}::${row.policy_number}::${row.effective_date}`
    dedup.set(k, {
      agency_carrier_id: agencyCarrierId,
      policy_number: row.policy_number,
      carrier: row.carrier,
      invoicing_status: row.invoicing_status,
      effective_date: row.effective_date,
    })
  }

  const payload = Array.from(dedup.values())
  if (!payload.length) return { inserted: 0 }

  const { error: insertError } = await supabase.from('invoicing_status_history').insert(payload)
  if (insertError) throw new Error(insertError.message)
  return { inserted: payload.length }
}

function ordinalDay(day: number): string {
  const j = day % 10
  const k = day % 100
  if (k >= 11 && k <= 13) return `${day}th`
  if (j === 1) return `${day}st`
  if (j === 2) return `${day}nd`
  if (j === 3) return `${day}rd`
  return `${day}th`
}

/** e.g. "March 23rd, 2026 – April 5th, 2026" */
export function formatInvoiceRangeLabel(startDate: string, endDate: string): string {
  const parseYmd = (s: string) => {
    const [y, m, d] = s.split('-').map((x) => parseInt(x, 10))
    if (!y || !m || !d) return null
    return new Date(y, m - 1, d)
  }
  const a = parseYmd(startDate)
  const b = parseYmd(endDate)
  if (!a || !b) return `${startDate} – ${endDate}`
  const fmt = (d: Date) => {
    const month = d.toLocaleString('en-US', { month: 'long' })
    return `${month} ${ordinalDay(d.getDate())}, ${d.getFullYear()}`
  }
  return `${fmt(a)} – ${fmt(b)}`
}

function formatDraftDate(value: string | null | undefined): string {
  if (!value) return '—'
  // Parse YYYY-MM-DD directly to avoid timezone shift from new Date()
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (iso) {
    const m = parseInt(iso[2], 10)
    const d = parseInt(iso[3], 10)
    return `${m}/${d}/${iso[1]}`
  }
  return String(value)
}

type DealTrackerInvoiceRow = {
  agency_carrier_id: string
  policy_number: string
  call_center: string | null
  carrier: string | null
  name: string | null
  ghl_name: string | null
  policy_type: string | null
  sales_agent: string | null
  commission_type: string | null
  effective_date: string | null
  deal_creation_date: string | null
  deal_value: number | null
  cc_value?: number | null
  ghl_stage?: string | null
  updated_at?: string | null
  created_at?: string | null
}

type CommissionTxRow = {
  id: string
  agency_carrier_id: string
  carrier: string
  policy_number: string
  name: string | null
  date: string
  sales_agent: string | null
  commission_rate: number | null
  advance_amount: number | null
  charge_back_amount: number | null
}

type DailyDealFlowFinancialRow = {
  insured_name: string | null
  carrier: string | null
  product_type?: string | null
  monthly_premium?: number | null
  face_amount?: number | null
}

let externalSupabaseClient: ReturnType<typeof createClient> | null = null

function getExternalSupabaseClient() {
  if (!externalSupabaseClient) {
    const url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY
    if (!url || !key) {
      throw new Error('Missing external Supabase credentials for daily_deal_flow lookup')
    }
    externalSupabaseClient = createClient(url, key)
  }
  return externalSupabaseClient
}

function normalizeCarrierForMatch(carrier: string | null | undefined): string {
  return String(carrier ?? '').trim().toLowerCase()
}

function carrierMatchCandidates(carrier: string | null | undefined): string[] {
  const raw = String(carrier ?? '').trim().toLowerCase()
  if (!raw) return []
  const compact = raw.replace(/[^a-z0-9]/g, '')
  const out = new Set<string>()
  out.add(raw)
  out.add(compact)
  if (raw.includes('(')) out.add(raw.replace(/\(.*?\)/g, '').trim())
  if (compact.includes('amam') || compact.includes('anam')) {
    out.add('amam')
    out.add('anam')
    out.add('american amicable')
  }
  if (compact === 'ahl' || compact.includes('americanhomelife')) {
    out.add('ahl')
    out.add('american home life')
    out.add('americanhomelife')
  }
  if (compact === 'moh' || compact.includes('mutualofomaha')) {
    out.add('moh')
    out.add('mutual of omaha')
    out.add('mutualofomaha')
  }
  if (compact === 'rna' || compact.includes('royalneighborsofamerica')) {
    out.add('rna')
    out.add('royal neighbors of america')
    out.add('royalneighborsofamerica')
  }
  return Array.from(out).filter(Boolean)
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(n)) return null
  return n
}

function extractNamePartsForMatch(name: string): { first: string; last: string } {
  const normalized = normalizeNameForSearch(name)
  const parts = normalized.split(' ').filter(Boolean)
  return {
    first: parts[0] ?? '',
    last: parts.length > 1 ? parts[parts.length - 1] : '',
  }
}

async function fetchDailyDealFlowFinancialByNameCarrier(
  insuredName: string,
  carrier: string,
): Promise<{ productType: string | null; monthlyPremium: number | null; faceAmount: number | null }> {
  const normalizedName = normalizeNameForSearch(insuredName || '')
  const normalizedCarrier = normalizeCarrierForMatch(carrier)
  if (!normalizedName || !normalizedCarrier) {
    return { productType: null, monthlyPremium: null, faceAmount: null }
  }
  const externalSupabase = getExternalSupabaseClient()
  const { first, last } = extractNamePartsForMatch(normalizedName)
  const attempts = [normalizedName]
  if (first && last && first !== last) attempts.push(`${first}%${last}`)
  if (first && first.length > 2) attempts.push(`${first}%`)
  if (last && last.length > 2) attempts.push(`%${last}`)
  const carrierCandidates = carrierMatchCandidates(carrier)
  for (const carrierCandidate of carrierCandidates) {
    for (const pattern of attempts) {
      const { data, error } = await externalSupabase
        .from('daily_deal_flow')
        .select('insured_name, carrier, product_type, monthly_premium, face_amount, created_at')
        .ilike('insured_name', pattern)
        .ilike('carrier', `%${carrierCandidate}%`)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      const rows = (data || []) as DailyDealFlowFinancialRow[]
      if (!rows.length) continue
      const exact = rows.find((r) => normalizeNameForSearch(r.insured_name || '') === normalizedName)
      const best = exact ?? rows[0]
      return {
        productType: (best.product_type || '').trim() || null,
        monthlyPremium: toNullableNumber(best.monthly_premium),
        faceAmount: toNullableNumber(best.face_amount),
      }
    }
  }
  return { productType: null, monthlyPremium: null, faceAmount: null }
}

/** Latest known commission rate by normalized policy number. */
async function batchFetchLatestCommissionRateByNormalizedPolicy(policyNumbers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (!policyNumbers.length) return out
  const BATCH_SIZE = 200
  const batches = chunk(policyNumbers, BATCH_SIZE)
  for (const batch of batches) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('policy_number, commission_rate, date')
      .in('policy_number', batch)
      .not('commission_rate', 'is', null)
      .order('date', { ascending: false })
    if (error) throw new Error(error.message)
    for (const row of (data || []) as Array<{ policy_number: string; commission_rate: number | null }>) {
      const n = normalizePolicyNumber(row.policy_number)
      if (!n || out.has(n) || row.commission_rate == null) continue
      out.set(n, row.commission_rate)
    }
  }
  return out
}

/**
 * Line-level BPO invoices: group by deal_tracker.call_center (BPO).
 * Sales rows = advance_amount > 0; Chargebacks = non-zero charge_back_amount.
 * Lead value on the invoice is 50% of the underlying advance/chargeback (not the full commission amount).
 */
export async function buildBpoInvoiceLines(
  startDate: string,
  endDate: string,
  filterCallCenter?: string | null,
): Promise<BpoInvoiceDetailResult> {
  const scopedCenter = filterCallCenter ? normalizeCallCenterName(filterCallCenter) : null
  let scopedPolicyNumbersForCenter: string[] | null = null
  if (scopedCenter) {
    const centerCandidates = callCenterFilterCandidates(filterCallCenter)
    const { data: centerDeals, error: centerDealsError } = await supabase
      .from('deal_tracker')
      .select('policy_number')
      .in('call_center', centerCandidates)
      .not('policy_number', 'is', null)
    if (centerDealsError) throw new Error(centerDealsError.message)
    scopedPolicyNumbersForCenter = Array.from(
      new Set((centerDeals || []).map((r: { policy_number?: string | null }) => String(r.policy_number ?? '').trim()).filter(Boolean)),
    )
    if (scopedPolicyNumbersForCenter.length === 0) {
      return { startDate, endDate, rangeLabel: formatInvoiceRangeLabel(startDate, endDate), groups: [] }
    }
  }

  const txQuery = supabase
    .from('commission_tracker')
    .select(
      'id, agency_carrier_id, carrier, policy_number, name, date, sales_agent, commission_rate, advance_amount, charge_back_amount',
    )
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })
  const { data: txRows, error: txError } = scopedPolicyNumbersForCenter
    ? await txQuery.in('policy_number', scopedPolicyNumbersForCenter)
    : await txQuery

  if (txError) {
    throw new Error(txError.message)
  }

  const transactions = aggregateCommissionRows((txRows || []) as CommissionTxRow[])
  const rangeLabel = formatInvoiceRangeLabel(startDate, endDate)
  const commissionRateByNormPolicyFromTx = new Map<string, number>()
  for (const tx of transactions) {
    const n = normalizePolicyNumber(tx.policy_number)
    if (!n || tx.commission_rate == null) continue
    commissionRateByNormPolicyFromTx.set(n, tx.commission_rate)
  }

  const policyNumbers = Array.from(
    new Set(
      transactions
        .flatMap((t) => policyLookupCandidates(t.policy_number))
        .filter((v) => v.length > 0),
    ),
  )
  const agencyCarrierIds = Array.from(new Set(transactions.map((t) => t.agency_carrier_id).filter(Boolean)))

  const latestStatusByPolicy = new Map<string, InvoicingStatus>()
  const dealByPolicyKey = new Map<string, DealTrackerInvoiceRow>()
  let dealsByNormPolicy = new Map<string, DealTrackerInvoiceRow[]>()

  if (policyNumbers.length > 0) {
    const [historyRes, dtRes] = await Promise.all([
      policyNumbers.length > 0 && agencyCarrierIds.length > 0
        ? supabase
            .from('invoicing_status_history')
            .select('agency_carrier_id, policy_number, invoicing_status, effective_date, created_at')
            .in('policy_number', policyNumbers)
            .in('agency_carrier_id', agencyCarrierIds)
            .lte('effective_date', startDate)
            .order('effective_date', { ascending: false })
            .order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from('deal_tracker')
        .select(
          'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, cc_value, ghl_stage, updated_at, created_at',
        )
        .in('policy_number', policyNumbers),
    ])

    if (historyRes.error) throw new Error(historyRes.error.message)
    if (dtRes.error) throw new Error(dtRes.error.message)

    for (const row of (historyRes.data || []) as Array<{
      agency_carrier_id: string
      policy_number: string
      invoicing_status: InvoicingStatus
    }>) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      if (!latestStatusByPolicy.has(key)) latestStatusByPolicy.set(key, row.invoicing_status)
    }

    const rows = (dtRes.data || []) as DealTrackerInvoiceRow[]
    dealsByNormPolicy = indexDealsByNormalizedPolicy(rows)
    for (const row of rows) {
      const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
      const existing = dealByPolicyKey.get(key)
      const ts = new Date(row.updated_at || row.created_at || 0).getTime()
      const exTs = existing ? new Date(existing.updated_at || existing.created_at || 0).getTime() : -1
      if (!existing || ts >= exTs) dealByPolicyKey.set(key, row)
    }
  }

  const linesByCenter = new Map<string, { sales: BpoInvoiceLine[]; charge: BpoInvoiceLine[] }>()
  const chargebackLineAddedByPolicy = new Set<string>()
  const salesLineAddedByPolicy = new Set<string>()
  const salesLineAddedByPolicyNumber = new Set<string>()
  const currentStatusByPolicy = new Map<string, InvoicingStatus | null>()
  const ddfFinancialByNameCarrier = new Map<string, { productType: string | null; monthlyPremium: number | null; faceAmount: number | null }>()
  const commissionRateByNormPolicyCache = new Map<string, number>()
  const getDdfFinancial = async (insuredName: string, carrier: string) => {
    const key = `${normalizeNameForSearch(insuredName)}::${normalizeCarrierForMatch(carrier)}`
    const cached = ddfFinancialByNameCarrier.get(key)
    if (cached) return cached
    const fetched = await fetchDailyDealFlowFinancialByNameCarrier(insuredName, carrier)
    ddfFinancialByNameCarrier.set(key, fetched)
    return fetched
  }

  const getCommissionRatesForPolicies = async (policyNums: string[]): Promise<Map<string, number>> => {
    const missing = Array.from(
      new Set(policyNums.map((p) => normalizePolicyNumber(p)).filter((p) => p && !commissionRateByNormPolicyCache.has(p))),
    )
    if (missing.length > 0) {
      const fetched = await batchFetchLatestCommissionRateByNormalizedPolicy(missing)
      for (const [k, v] of fetched.entries()) commissionRateByNormPolicyCache.set(k, v)
    }
    return commissionRateByNormPolicyCache
  }

  const pushLine = (center: string, line: BpoInvoiceLine, kind: 'sales' | 'charge') => {
    const c = normalizeCallCenterName(center)
    if (!linesByCenter.has(c)) {
      linesByCenter.set(c, { sales: [], charge: [] })
    }
    const bucket = linesByCenter.get(c)!
    if (kind === 'sales') bucket.sales.push(line)
    else bucket.charge.push(line)
  }

  for (const tx of transactions) {
    const key = buildPolicyKey(tx.agency_carrier_id, tx.policy_number)
    const currentStatus = currentStatusByPolicy.has(key)
      ? currentStatusByPolicy.get(key) ?? null
      : (latestStatusByPolicy.get(key) ?? null)
    const deal = resolveDealForCommission(tx, dealByPolicyKey, dealsByNormPolicy)
    const callCenter = normalizeCallCenterName(deal?.call_center)
    if (!matchesCallCenterFilter(callCenter, filterCallCenter)) continue
    const insuredName = (deal?.ghl_name || tx.name || deal?.name || '—').trim() || '—'
    const agentAccount = (deal?.sales_agent || tx.sales_agent || '—').trim() || '—'
    const draftRaw = deal?.effective_date || deal?.deal_creation_date || tx.date
    if (shouldExcludeInvoiceEntry(tx.carrier || deal?.carrier, callCenter, draftRaw)) continue
    const draftDate = formatDraftDate(draftRaw)
    const normalizedPolicy = normalizePolicyNumber(tx.policy_number)
    const resolvedCommissionRate = tx.commission_rate ?? commissionRateByNormPolicyFromTx.get(normalizedPolicy) ?? null
    const comPctDisplay = resolvedCommissionRate != null ? `${Number(resolvedCommissionRate)}%` : '—'
    const comType = (deal?.commission_type || 'Advance').trim() || 'Advance'

    let ddfFinancial: { productType: string | null; monthlyPremium: number | null; faceAmount: number | null } | null = null
    const ensureDdfFinancial = async () => {
      if (ddfFinancial) return ddfFinancial
      ddfFinancial = await getDdfFinancial(deal?.ghl_name || insuredName, tx.carrier || deal?.carrier || '')
      return ddfFinancial
    }

    const base = {
      insuredName,
      carrier: tx.carrier || deal?.carrier || '—',
      agentAccount,
      draftDate,
      comPct: comPctDisplay,
      comType,
      policyNumber: tx.policy_number,
    }

    const advance = toNumber(tx.advance_amount)
    if (advance > 0) {
      const salesStatus = deriveNextStatus(currentStatus, roundMoney(advance))
      currentStatusByPolicy.set(key, salesStatus)
      if (!isBillableStatus(salesStatus)) {
        // Keep status progression, but skip non-billable lines like paid_delete.
      } else {
        const ddf = await ensureDdfFinancial()
        pushLine(
          callCenter,
          {
            id: `${tx.id}-adv`,
            ...base,
            product: ddf.productType,
            monthlyPremium: ddf.monthlyPremium,
            coverageAmount: ddf.faceAmount,
            leadValue: roundMoney(advance * BPO_INVOICE_LEAD_VALUE_SHARE),
            invoicingStatus: salesStatus,
          },
          'sales',
        )
        salesLineAddedByPolicy.add(key)
        salesLineAddedByPolicyNumber.add(normalizePolicyNumber(tx.policy_number))
      }
    }

    const cbRaw = toNumber(tx.charge_back_amount)
    if (cbRaw !== 0) {
      const cbNorm = cbRaw > 0 ? -Math.abs(cbRaw) : cbRaw
      const statusBeforeCb = currentStatusByPolicy.has(key)
        ? currentStatusByPolicy.get(key) ?? null
        : (latestStatusByPolicy.get(key) ?? null)
      const cbStatus = deriveNextStatus(statusBeforeCb, roundMoney(cbNorm))
      currentStatusByPolicy.set(key, cbStatus)
      if (isBillableStatus(cbStatus)) {
        const ddf = await ensureDdfFinancial()
        chargebackLineAddedByPolicy.add(key)
        pushLine(
          callCenter,
          {
            id: `${tx.id}-cb`,
            ...base,
            product: ddf.productType,
            monthlyPremium: ddf.monthlyPremium,
            coverageAmount: ddf.faceAmount,
            leadValue: roundMoney(cbNorm * BPO_INVOICE_LEAD_VALUE_SHARE),
            invoicingStatus: cbStatus,
          },
          'charge',
        )
      }
    }
  }

  const customerPipelineDeals = scopedCenter
    ? await fetchAllCustomerPipelineDealsByCallCenter<DealTrackerInvoiceRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, cc_value, ghl_stage, updated_at, created_at',
        filterCallCenter as string,
      )
    : await fetchAllCustomerPipelineDeals<DealTrackerInvoiceRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, cc_value, ghl_stage, updated_at, created_at',
      )

  // ── Customer pipeline: synthetic sale from deal_tracker when commission_tracker has no row in this period
  // (or no billable sales line) but deal_value and cc_value are set on the deal.
  {
    const customerFinDeals = customerPipelineDeals
    if (customerFinDeals.length > 0) {
      const finNums = Array.from(
        new Set(customerFinDeals.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const finAids = Array.from(new Set(customerFinDeals.map((d) => d.agency_carrier_id).filter(Boolean)))
      const finHist = await batchFetchStatusHistory(finNums, finAids)
      const finFacts = await batchFetchCommissionFacts(finNums, finAids)
      const finSignals = finFacts.latestSignalsByPolicy
      const finCommissionRates = await getCommissionRatesForPolicies(finNums)
      const finPrior = new Map<string, InvoicingStatus>()
      for (const row of finHist) {
        const k = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!finPrior.has(k)) finPrior.set(k, row.invoicing_status)
      }
      for (const deal of customerFinDeals) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        const normalizedPolicy = normalizePolicyNumber(deal.policy_number)
        if (salesLineAddedByPolicy.has(key)) continue
        if (salesLineAddedByPolicyNumber.has(normalizedPolicy)) continue
        const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
        const dv = toNumber(deal.deal_value)
        if (dv <= 0) continue
        const signal = finSignals.get(key)
        const statementSaleGross = signal?.latestSaleGross ?? null
        const gross = statementSaleGross != null && statementSaleGross > 0
          ? roundMoney(statementSaleGross)
          : roundMoney(Math.abs(proRatedChargebackLeadValue(dv, deal.effective_date, endDate) * 2))
        if (gross <= 0) continue
        const prior = finPrior.get(key) ?? latestStatusByPolicy.get(key) ?? null
        const salesStatus = deriveNextStatus(prior, gross)
        currentStatusByPolicy.set(key, salesStatus)
        if (!isBillableStatus(salesStatus)) continue
        const leadValue = roundMoney(gross * BPO_INVOICE_LEAD_VALUE_SHARE)
        if (leadValue === 0) continue
        const callCenter = normalizeCallCenterName(deal.call_center)
        const insuredName = (deal.ghl_name || deal.name || '—').trim() || '—'
        const ddfFinancial = await getDdfFinancial(deal.ghl_name || insuredName, deal.carrier || '')
        const product = ddfFinancial.productType
        const agentAccount = (deal.sales_agent || '—').trim() || '—'
        const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
        const draftDate = formatDraftDate(draftRaw)
        const monthlyPremium = ddfFinancial.monthlyPremium
        const coverageAmount = ddfFinancial.faceAmount
        const resolvedCommissionRate = finCommissionRates.get(normalizedPolicy) ?? commissionRateByNormPolicyFromTx.get(normalizedPolicy) ?? null
        const comPctDisplay = resolvedCommissionRate != null ? `${Number(resolvedCommissionRate)}%` : '—'
        const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
        pushLine(
          callCenter,
          {
            id: `cp-deal-${key}`,
            insuredName,
            carrier: deal.carrier?.trim() || '—',
            product,
            agentAccount,
            draftDate,
            monthlyPremium,
            coverageAmount,
            comPct: comPctDisplay,
            comType,
            policyNumber: deal.policy_number,
            leadValue,
            invoicingStatus: salesStatus,
          },
          'sales',
        )
        salesLineAddedByPolicy.add(key)
        salesLineAddedByPolicyNumber.add(normalizedPolicy)
      }
    }
  }

  const cbStageDeals = scopedCenter
    ? await fetchAllChargebackStageDealsByCallCenter<DealTrackerInvoiceRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, ghl_stage, updated_at, created_at',
        filterCallCenter as string,
      )
    : await fetchAllChargebackStageDeals<DealTrackerInvoiceRow>(
        'agency_carrier_id, policy_number, call_center, carrier, name, ghl_name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, ghl_stage, updated_at, created_at',
      )
  const cbStagePolicyNumbers = Array.from(
    new Set(cbStageDeals.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
  )
  const cbStageAgencyIds = Array.from(new Set(cbStageDeals.map((d) => d.agency_carrier_id).filter(Boolean)))
  const cbFacts = await batchFetchCommissionFacts(cbStagePolicyNumbers, cbStageAgencyIds)
  const policiesWithAnyChargebackCommission = cbFacts.policiesWithAnyChargebackCommission
  const latestSignalsByPolicy = cbFacts.latestSignalsByPolicy
  const latestChargebackGrossByPolicy = cbFacts.latestChargebackGrossByPolicy
  const cbStageCommissionRates = await getCommissionRatesForPolicies(cbStagePolicyNumbers)
  const referenceDate = endDate

  // If no commission chargeback line exists but policy is in chargeback pipeline,
  // add a synthetic chargeback from deal_tracker.deal_value (full or 9-month pro-rated by rule).
  for (const [key, deal] of dealByPolicyKey.entries()) {
    if (!isChargebackPipelineStage(deal.ghl_stage)) continue
    if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
    if (chargebackLineAddedByPolicy.has(key)) continue
    const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
    if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
    const dealValue = toNumber(deal.deal_value)
    if (dealValue <= 0) continue
    const callCenter = normalizeCallCenterName(deal.call_center)
    const insuredName = (deal.ghl_name || deal.name || '—').trim() || '—'
    const ddfFinancial = await getDdfFinancial(deal.ghl_name || insuredName, deal.carrier || '')
    const product = ddfFinancial.productType
    const agentAccount = (deal.sales_agent || '—').trim() || '—'
    const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
    const draftDate = formatDraftDate(draftRaw)
    const monthlyPremium = ddfFinancial.monthlyPremium
    const coverageAmount = ddfFinancial.faceAmount
    const normalizedPolicy = normalizePolicyNumber(deal.policy_number)
    const resolvedCommissionRate = cbStageCommissionRates.get(normalizedPolicy) ?? commissionRateByNormPolicyFromTx.get(normalizedPolicy) ?? null
    const comPctDisplay = resolvedCommissionRate != null ? `${Number(resolvedCommissionRate)}%` : '—'
    const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
    const fullGross = roundMoney(-Math.abs(dealValue))
    const statusBeforeCb = currentStatusByPolicy.has(key)
      ? currentStatusByPolicy.get(key) ?? null
      : (latestStatusByPolicy.get(key) ?? null)
    const cbStatus = deriveNextStatus(statusBeforeCb, fullGross)
    currentStatusByPolicy.set(key, cbStatus)
    if (!isBillableStatus(cbStatus)) continue
    const hasAnyCbCommission = policiesWithAnyChargebackCommission.has(key)
    const signal = latestSignalsByPolicy.get(key)
    const statementGross = latestChargebackGrossByPolicy.get(key)
    const useStatementChargeback =
      hasAnyCbCommission &&
      signal?.latestKind === 'chargeback' &&
      statementGross != null
    const leadValue = useStatementChargeback
      ? roundMoney(statementGross * BPO_INVOICE_LEAD_VALUE_SHARE)
      : proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate)
    if (leadValue === 0) continue
    pushLine(
      callCenter,
      {
        id: `stage-cb-${key}`,
        insuredName,
        carrier: deal.carrier?.trim() || '—',
        product,
        agentAccount,
        draftDate,
        monthlyPremium,
        coverageAmount,
        comPct: comPctDisplay,
        comType,
        policyNumber: deal.policy_number,
        leadValue,
        invoicingStatus: cbStatus,
      },
      'charge',
    )
  }

  // ── Stage-only chargebacks: policies in chargeback pipeline with NO commission events in this period ──
  {
    const unseen = cbStageDeals.filter((d) => {
      const key = buildPolicyKey(d.agency_carrier_id, d.policy_number)
      return !dealByPolicyKey.has(key)
    })

    if (unseen.length > 0) {
      const unseenPolicyNumbers = Array.from(
        new Set(unseen.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const unseenAgencyIds = Array.from(new Set(unseen.map((d) => d.agency_carrier_id).filter(Boolean)))

      const hRows = await batchFetchStatusHistory(unseenPolicyNumbers, unseenAgencyIds)

      const unseenStatus = new Map<string, InvoicingStatus>()
      for (const row of hRows) {
        const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!unseenStatus.has(key)) unseenStatus.set(key, row.invoicing_status)
      }

      for (const deal of unseen) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (dealByPolicyKey.has(key)) continue
        const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const priorStatus = unseenStatus.get(key) ?? null
        const fullGross = roundMoney(-Math.abs(dealValue))
        const cbStatus = deriveNextStatus(priorStatus, fullGross)
        if (!isBillableStatus(cbStatus)) continue
        const hasAnyCbCommission = policiesWithAnyChargebackCommission.has(key)
        const signal = latestSignalsByPolicy.get(key)
        const statementGross = latestChargebackGrossByPolicy.get(key)
        const useStatementChargeback =
          hasAnyCbCommission &&
          signal?.latestKind === 'chargeback' &&
          statementGross != null
        const leadValue = useStatementChargeback
          ? roundMoney(statementGross * BPO_INVOICE_LEAD_VALUE_SHARE)
          : proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate)
        if (leadValue === 0) continue
        const callCenter = normalizeCallCenterName(deal.call_center)
        const insuredName = (deal.name || '—').trim() || '—'
        const insuredDisplayName = (deal.ghl_name || insuredName || '—').trim() || '—'
        const ddfFinancial = await getDdfFinancial(deal.ghl_name || insuredDisplayName, deal.carrier || '')
        const product = ddfFinancial.productType
        const agentAccount = (deal.sales_agent || '—').trim() || '—'
        const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
        const draftDate = formatDraftDate(draftRaw)
        const monthlyPremium = ddfFinancial.monthlyPremium
        const coverageAmount = ddfFinancial.faceAmount
        const normalizedPolicy = normalizePolicyNumber(deal.policy_number)
        const resolvedCommissionRate = cbStageCommissionRates.get(normalizedPolicy) ?? commissionRateByNormPolicyFromTx.get(normalizedPolicy) ?? null
        const comPctDisplay = resolvedCommissionRate != null ? `${Number(resolvedCommissionRate)}%` : '—'
        const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
        pushLine(
          callCenter,
          {
            id: `stage-cb-${key}`,
            insuredName: insuredDisplayName,
            carrier: deal.carrier?.trim() || '—',
            product,
            agentAccount,
            draftDate,
            monthlyPremium,
            coverageAmount,
            comPct: comPctDisplay,
            comType,
            policyNumber: deal.policy_number,
            leadValue,
            invoicingStatus: cbStatus,
          },
          'charge',
        )
      }
    }
  }

  // ── Stage-only repays: customer pipeline policies can be repaid without in-range commission events ──
  {
    const customerDeals = customerPipelineDeals
    const unseen = customerDeals.filter((d) => {
      const key = buildPolicyKey(d.agency_carrier_id, d.policy_number)
      return !dealByPolicyKey.has(key)
    })
    if (unseen.length > 0) {
      const unseenPolicyNumbers = Array.from(
        new Set(unseen.flatMap((d) => policyLookupCandidates(d.policy_number)).filter(Boolean)),
      )
      const unseenAgencyIds = Array.from(new Set(unseen.map((d) => d.agency_carrier_id).filter(Boolean)))
      const hRows = await batchFetchStatusHistory(unseenPolicyNumbers, unseenAgencyIds)
      const unseenFacts = await batchFetchCommissionFacts(unseenPolicyNumbers, unseenAgencyIds)
      const policiesWithAnyPositiveCommission = unseenFacts.policiesWithAnyPositiveCommission
      const unseenSignals = unseenFacts.latestSignalsByPolicy
      const unseenCommissionRates = await getCommissionRatesForPolicies(unseenPolicyNumbers)
      const unseenStatus = new Map<string, InvoicingStatus>()
      for (const row of hRows) {
        const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
        if (!unseenStatus.has(key)) unseenStatus.set(key, row.invoicing_status)
      }
      for (const deal of unseen) {
        if (!matchesCallCenterFilter(deal.call_center, filterCallCenter)) continue
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (dealByPolicyKey.has(key)) continue
        if (salesLineAddedByPolicy.has(key)) continue
        const filterDraftRaw = deal.effective_date || deal.deal_creation_date || endDate
        if (shouldExcludeInvoiceEntry(deal.carrier, deal.call_center, filterDraftRaw)) continue
        if (!policiesWithAnyPositiveCommission.has(key)) continue
        const priorStatus = unseenStatus.get(key) ?? null
        if (!(priorStatus == null || isChargebackLikeStatus(priorStatus))) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const lastCbGross = unseenSignals.get(key)?.latestChargebackGross ?? null
        const repayGross = lastCbGross != null
          ? roundMoney(Math.abs(lastCbGross))
          : roundMoney(Math.abs(proRatedChargebackLeadValue(dealValue, deal.effective_date, referenceDate) * 2))
        if (repayGross <= 0) continue
        const callCenter = normalizeCallCenterName(deal.call_center)
        const insuredName = (deal.ghl_name || deal.name || '—').trim() || '—'
        const ddfFinancial = await getDdfFinancial(deal.ghl_name || insuredName, deal.carrier || '')
        const product = ddfFinancial.productType
        const agentAccount = (deal.sales_agent || '—').trim() || '—'
        const draftRaw = deal.effective_date || deal.deal_creation_date || endDate
        const draftDate = formatDraftDate(draftRaw)
        const monthlyPremium = ddfFinancial.monthlyPremium
        const coverageAmount = ddfFinancial.faceAmount
        const normalizedPolicy = normalizePolicyNumber(deal.policy_number)
        const resolvedCommissionRate = unseenCommissionRates.get(normalizedPolicy) ?? commissionRateByNormPolicyFromTx.get(normalizedPolicy) ?? null
        const comPctDisplay = resolvedCommissionRate != null ? `${Number(resolvedCommissionRate)}%` : '—'
        const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
        pushLine(
          callCenter,
          {
            id: `stage-repay-${key}`,
            insuredName,
            carrier: deal.carrier?.trim() || '—',
            product,
            agentAccount,
            draftDate,
            monthlyPremium,
            coverageAmount,
            comPct: comPctDisplay,
            comType,
            policyNumber: deal.policy_number,
            leadValue: roundMoney(repayGross * BPO_INVOICE_LEAD_VALUE_SHARE),
            invoicingStatus: 'repay',
          },
          'sales',
        )
        salesLineAddedByPolicy.add(key)
      }
    }
  }

  const groups: BpoInvoiceGroupDetail[] = Array.from(linesByCenter.entries())
    .map(([callCenter, { sales, charge }]) => {
      const sortFn = (a: BpoInvoiceLine, b: BpoInvoiceLine) =>
        a.insuredName.localeCompare(b.insuredName) || a.policyNumber.localeCompare(b.policyNumber)
      const salesLines = [...sales].sort(sortFn)
      const chargebackLines = [...charge].sort(sortFn)
      const newBusinessTotal = roundMoney(salesLines.reduce((s, l) => s + l.leadValue, 0))
      const chargebacksTotal = roundMoney(chargebackLines.reduce((s, l) => s + l.leadValue, 0))
      const subtotal = roundMoney(newBusinessTotal + chargebacksTotal)
      return {
        callCenter,
        salesLines,
        chargebackLines,
        newBusinessTotal,
        chargebacksTotal,
        subtotal,
      }
    })
    .sort((a, b) => a.callCenter.localeCompare(b.callCenter))

  return { startDate, endDate, rangeLabel, groups }
}

export async function markInvoiceBatchPaid(input: {
  startDate: string
  endDate: string
  groups: InvoiceCallCenterGroup[]
  overridesByPolicyKey: Record<string, number>
  previousChargebackByCallCenter: Record<string, number>
  paidByEmail?: string | null
}): Promise<{ batchId: string }> {
  const weekOfRangeLabel = formatInvoiceRangeLabel(input.startDate, input.endDate)
  const allPolicies = input.groups.flatMap((group) => group.policies)
  const grossTotal = roundMoney(allPolicies.reduce((sum, p) => sum + p.grossNet, 0))
  const ccTotalsByCallCenter = new Map<string, number>()
  for (const group of input.groups) {
    const groupBase = roundMoney(
      group.policies.reduce((sum, p) => {
        const override = input.overridesByPolicyKey[p.policyKey]
        return sum + (Number.isFinite(override) ? override : p.ccNet)
      }, 0),
    )
    ccTotalsByCallCenter.set(group.callCenter, groupBase)
  }
  const ccTotal = roundMoney(
    input.groups.reduce((sum, group) => {
      const base = ccTotalsByCallCenter.get(group.callCenter) || 0
      const previousChargeback = input.previousChargebackByCallCenter[group.callCenter] || 0
      const net = roundMoney(base - previousChargeback)
      return sum + (net > 0 ? net : 0)
    }, 0),
  )

  const { data: batchInsert, error: batchError } = await supabase
    .from('invoicing_batches')
    .insert({
      start_date: input.startDate,
      end_date: input.endDate,
      gross_total: grossTotal,
      cc_total: ccTotal,
      paid_at: new Date().toISOString(),
      paid_by_email: input.paidByEmail || null,
    })
    .select('id')
    .single()

  if (batchError || !batchInsert?.id) {
    throw new Error(batchError?.message || 'Failed to create invoice batch')
  }

  const batchId = String(batchInsert.id)
  const lines: Record<string, unknown>[] = []
  const statuses: Record<string, unknown>[] = []
  const ledgers: Record<string, unknown>[] = []

  for (const group of input.groups) {
    const baseByCenter = ccTotalsByCallCenter.get(group.callCenter) || 0
    const previousChargeback = roundMoney(input.previousChargebackByCallCenter[group.callCenter] || 0)
    const netAfterPrevious = roundMoney(baseByCenter - previousChargeback)
    const payableAmount = netAfterPrevious > 0 ? netAfterPrevious : 0
    const endingChargebackAmount = netAfterPrevious < 0 ? Math.abs(netAfterPrevious) : 0

    ledgers.push({
      batch_id: batchId,
      call_center: group.callCenter,
      previous_chargeback_amount: previousChargeback,
      current_cycle_base_amount: baseByCenter,
      payable_amount: payableAmount,
      ending_chargeback_amount: endingChargebackAmount,
    })

    for (const policy of group.policies) {
      const override = input.overridesByPolicyKey[policy.policyKey]
      const finalCcAmount = Number.isFinite(override) ? roundMoney(override) : policy.ccNet
      lines.push({
        batch_id: batchId,
        agency_carrier_id: policy.agencyCarrierId,
        carrier: policy.carrier,
        policy_number: policy.policyNumber,
        call_center: group.callCenter,
        gross_amount: policy.grossNet,
        base_cc_amount: policy.ccNet,
        final_cc_amount: finalCcAmount,
        latest_invoicing_status: policy.latestInvoicingStatus,
      })
      statuses.push({
        batch_id: batchId,
        agency_carrier_id: policy.agencyCarrierId,
        carrier: policy.carrier,
        policy_number: policy.policyNumber,
        invoicing_status: policy.latestInvoicingStatus,
        effective_date: input.endDate,
        week_of: weekOfRangeLabel,
      })
    }
  }

  if (lines.length) {
    const { error: lineError } = await supabase.from('invoicing_policy_lines').insert(lines)
    if (lineError) {
      throw new Error(lineError.message)
    }
  }

  if (statuses.length) {
    const { error: statusError } = await supabase.from('invoicing_status_history').insert(statuses)
    if (statusError) {
      throw new Error(statusError.message)
    }
  }
  if (ledgers.length) {
    const { error: ledgerError } = await supabase.from('invoicing_call_center_ledger').insert(ledgers)
    if (ledgerError) {
      throw new Error(ledgerError.message)
    }
  }

  return { batchId }
}

export async function saveInvoiceDraftSnapshot(input: {
  startDate: string
  endDate: string
  callCenterFilter: string | null
  payload: InvoiceDraftSnapshot
  savedByEmail?: string | null
}): Promise<{ id: string }> {
  const normalizedFilter = input.callCenterFilter ? normalizeCallCenterName(input.callCenterFilter) : null
  let existingQuery = supabase
    .from('invoicing_drafts')
    .select('id')
    .eq('start_date', input.startDate)
    .eq('end_date', input.endDate)
    .is('locked_at', null)
    .is('paid_batch_id', null)
    .order('updated_at', { ascending: false })
    .limit(1)
  existingQuery = normalizedFilter == null
    ? existingQuery.is('call_center_filter', null)
    : existingQuery.eq('call_center_filter', normalizedFilter)
  const { data: existing, error: existingError } = await existingQuery.maybeSingle()
  if (existingError) throw new Error(existingError.message)

  if (existing?.id) {
    const { error: updateError } = await supabase
      .from('invoicing_drafts')
      .update({
        payload: input.payload as unknown as Record<string, unknown>,
        saved_by_email: input.savedByEmail || null,
      })
      .eq('id', existing.id)
    if (updateError) throw new Error(updateError.message)
    return { id: String(existing.id) }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('invoicing_drafts')
    .insert({
      start_date: input.startDate,
      end_date: input.endDate,
      call_center_filter: normalizedFilter,
      payload: input.payload as unknown as Record<string, unknown>,
      saved_by_email: input.savedByEmail || null,
    })
    .select('id')
    .single()
  if (insertError || !inserted?.id) throw new Error(insertError?.message || 'Failed to save invoice draft.')
  return { id: String(inserted.id) }
}

export async function loadInvoiceDraftSnapshot(input: {
  startDate: string
  endDate: string
  callCenterFilter: string | null
}): Promise<InvoiceDraftRecord | null> {
  const normalizedFilter = input.callCenterFilter ? normalizeCallCenterName(input.callCenterFilter) : null
  let query = supabase
    .from('invoicing_drafts')
    .select('id, start_date, end_date, call_center_filter, payload, updated_at')
    .eq('start_date', input.startDate)
    .eq('end_date', input.endDate)
    .is('locked_at', null)
    .is('paid_batch_id', null)
    .order('updated_at', { ascending: false })
    .limit(1)
  query = normalizedFilter == null
    ? query.is('call_center_filter', null)
    : query.eq('call_center_filter', normalizedFilter)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return data as unknown as InvoiceDraftRecord
}

export async function clearInvoiceDraftSnapshot(input: {
  startDate: string
  endDate: string
  callCenterFilter: string | null
}): Promise<void> {
  const normalizedFilter = input.callCenterFilter ? normalizeCallCenterName(input.callCenterFilter) : null
  let query = supabase
    .from('invoicing_drafts')
    .delete()
    .eq('start_date', input.startDate)
    .eq('end_date', input.endDate)
    .is('locked_at', null)
    .is('paid_batch_id', null)
  query = normalizedFilter == null
    ? query.is('call_center_filter', null)
    : query.eq('call_center_filter', normalizedFilter)
  const { error } = await query
  if (error) throw new Error(error.message)
}

export async function getPreviousChargebackByCallCenter(callCenters: string[]): Promise<Record<string, number>> {
  if (!callCenters.length) return {}
  const normalizedCallCenters = Array.from(new Set(callCenters.map((c) => normalizeCallCenterName(c))))
  const { data, error } = await supabase
    .from('invoicing_call_center_ledger')
    .select('call_center, ending_chargeback_amount, created_at')
    .in('call_center', normalizedCallCenters)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  const result: Record<string, number> = {}
  for (const center of normalizedCallCenters) {
    result[center] = 0
  }
  for (const row of (data || []) as Array<{ call_center: string; ending_chargeback_amount: number | null }>) {
    const normalized = normalizeCallCenterName(row.call_center)
    if (!(normalized in result)) continue
    if (result[normalized] !== 0) continue
    result[normalized] = toNumber(row.ending_chargeback_amount)
  }
  return result
}
