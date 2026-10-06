/**
 * Commission Advance & Chargeback export.
 *
 * Turns the per-transaction rows in `commission_tracker` into one row per policy
 * with the advance / chargeback pairs laid out side by side, in the exact column
 * order the finance team's spreadsheet uses:
 *
 *   Date, Policy Last 3 Digits, Customer Name, Carrier, Sales Agent,
 *   Commission Rate, Product Code, Advance, Chargeback, Call Center Name,
 *   Chargeback Date, Advance 2 Date, Advance 2, Commission Rate 2,
 *   Chargeback 2, Chargeback 2 Date, Data Check
 *
 * Product Code and Call Center Name come from `deal_tracker` (policy_type /
 * call_center), matched on agency_carrier_id + policy_number.
 *
 * Deliberately free of any Supabase import so it can be unit tested without env.
 */

export type CommissionTxn = {
  id?: string | null
  agency_carrier_id: string
  policy_number: string
  carrier?: string | null
  name?: string | null
  sales_agent?: string | null
  /** YYYY-MM-DD */
  date: string
  commission_rate?: number | string | null
  advance_amount?: number | string | null
  charge_back_amount?: number | string | null
}

export type DealInfo = {
  agency_carrier_id: string
  policy_number: string
  call_center?: string | null
  policy_type?: string | null
  sales_agent?: string | null
  name?: string | null
  carrier?: string | null
  updated_at?: string | null
}

export type AdvanceChargebackRow = {
  /** Stable key for React lists / preview selection. */
  key: string
  agencyCarrierId: string
  policyNumber: string
  agency: string
  /** First advance date (falls back to the earliest transaction), MM/DD/YYYY. */
  date: string
  policyLast3: string
  customerName: string
  carrier: string
  salesAgent: string
  commissionRate: string
  productCode: string
  advance: string
  chargeback: string
  callCenter: string
  chargebackDate: string
  advance2Date: string
  advance2: string
  commissionRate2: string
  chargeback2: string
  chargeback2Date: string
  dataCheck: string
  /** Not exported; used for sorting and the preview totals. */
  sortDate: string
  advanceTotal: number
  chargebackTotal: number
}

export type DateBasis = 'any' | 'advance' | 'chargeback'
export type ActivityFilter = 'all' | 'with_chargeback' | 'advance_only' | 'chargeback_only'

export type ReportFilters = {
  /** Inclusive, YYYY-MM-DD. */
  dateFrom?: string
  dateTo?: string
  /** Which transaction date has to land inside the range. Default 'any'. */
  dateBasis?: DateBasis
  carriers?: string[]
  callCenters?: string[]
  salesAgents?: string[]
  agencies?: string[]
  productCodes?: string[]
  activity?: ActivityFilter
  /** Policy number or customer name; a comma-separated list matches policy numbers exactly. */
  search?: string
}

export type ReportContext = {
  /** agency_carrier_id -> agency name. */
  agencyByAcId?: Map<string, string>
  /** Canonical carrier names, used to fold "AETNA" / "MOH" style values back together. */
  carrierNameByCode?: Map<string, string>
  carrierNames?: string[]
}

export const ADVANCE_CHARGEBACK_HEADERS = [
  'Date',
  'Policy Last 3 Digits',
  'Customer Name',
  'Carrier',
  'Sales Agent',
  'Commission Rate',
  'Product Code',
  'Advance',
  'Chargeback',
  'Call Center Name',
  'Chargeback Date',
  'Advance 2 Date',
  'Advance 2',
  'Commission Rate 2',
  'Chargeback 2',
  'Chargeback 2 Date',
  'Data Check',
] as const

/**
 * Product descriptions that say what kind of policy it is but not which plan was
 * sold. The carrier files for these carriers never carry a plan code, so the
 * export flags them rather than pretending the column is filled in.
 */
const GENERIC_PRODUCT_CODES = new Set([
  'final exp',
  'final expense',
  'whole life',
  'whole life insurance',
  'life',
  'term life',
  'universal life',
  'non gi',
  'gi',
])

/**
 * Agent spellings the generic "Last/ First" reordering cannot repair on its own:
 * compound surnames that are sometimes truncated, middle names that are only
 * present in some carrier files, and one carrier-side typo. Keyed on the
 * lowercased, punctuation-stripped source value.
 */
const AGENT_ALIASES: Record<string, string> = {
  'flinchum brandon': 'Brandon Flinchum',
  'brandom flinchum': 'Brandon Flinchum',
  'munoz bonilla andrea': 'Andrea Munoz Bonilla',
  'cabrera neovon': 'Neovon Cabrera',
  'tradardi napoletano clau': 'Claudia Tradardi',
  'tradardi napoletano claudia': 'Claudia Tradardi',
  'clau tradardi napoletano': 'Claudia Tradardi',
  'claudia tradardi napoletano': 'Claudia Tradardi',
  'vargas daniel albert': 'Daniel Vargas',
  'daniel albert vargas': 'Daniel Vargas',
  'sanchez santiago maria': 'Maria Sanchez',
  'maria sanchez santiago': 'Maria Sanchez',
  'sutton lydia rose': 'Lydia Sutton',
  'lydia rose sutton': 'Lydia Sutton',
}

// ─────────────────────────── small value helpers ───────────────────────────

export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value).replace(/[$,]/g, ''))
  return Number.isNaN(num) ? null : num
}

/** Calendar-safe: never builds a Date, so nothing shifts across timezones. */
export function toIsoDate(value: unknown): string {
  const str = String(value ?? '').trim()
  if (!str) return ''
  const head = str.split('to')[0].trim()
  const ymd = head.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  const us = head.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (us) {
    const mm = String(Number.parseInt(us[1], 10)).padStart(2, '0')
    const dd = String(Number.parseInt(us[2], 10)).padStart(2, '0')
    return `${us[3]}-${mm}-${dd}`
  }
  return ''
}

/** YYYY-MM-DD -> MM/DD/YYYY, the format the spreadsheet uses. */
export function formatUsDate(iso: string): string {
  const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[2]}/${m[3]}/${m[1]}` : ''
}

export function formatAmount(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return ''
  return value.toFixed(2)
}

/**
 * Carrier files store the rate either as a percentage (145) or as the multiplier
 * it came from (1.45). Anything below 10 is the multiplier form — real rates in
 * this book run 70-150.
 */
export function normalizeCommissionRate(value: unknown): number | null {
  const num = toNumber(value)
  if (num == null || num === 0) return null
  const scaled = Math.abs(num) < 10 ? num * 100 : num
  return Math.round(scaled * 100) / 100
}

export function formatRate(value: number | null): string {
  if (value == null) return ''
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)))
}

export function policyLast3(policyNumber: string): string {
  const raw = String(policyNumber ?? '').trim()
  return raw.length <= 3 ? raw : raw.slice(-3)
}

function titleCaseToken(token: string): string {
  return token.replace(/[A-Za-z]+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
}

/** "CARLA JEFFERSON" -> "Carla Jefferson". Leaves already-mixed-case text alone. */
export function toTitleCase(value: unknown): string {
  const str = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!str) return ''
  return str
    .split(' ')
    .map((part) => titleCaseToken(part))
    .join(' ')
}

/**
 * Carrier and CRM files write people either way round: "Carla Jefferson",
 * "RITTENHOUSE,JOYCE", "CAMPO,DIANA MERCEDES", "FLINCHUM/ BRANDON". A '/' or ','
 * always means the surname came first, so reorder around it; without one the
 * name is already first-last.
 */
function reorderSurnameFirst(raw: string): string[] {
  const tokens = (text: string) => text.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  const slash = raw.indexOf('/')
  const comma = raw.indexOf(',')
  const sepIndex = slash >= 0 ? slash : comma
  if (sepIndex < 0) return tokens(raw)
  return [...tokens(raw.slice(sepIndex + 1)), ...tokens(raw.slice(0, sepIndex))]
}

/**
 * Customer name as the spreadsheet wants it: first name first, middle names and
 * initials kept ("Berenise C Gomez", "Diana Mercedes Campo").
 */
export function normalizePersonName(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!raw) return ''
  return toTitleCase(reorderSurnameFirst(raw).join(' '))
}

/**
 * Folds the many spellings the carrier files use ("FLINCHUM/ BRANDON",
 * "Flinchum,Brandon", "REED/ ISAAC J") into one display name. Unlike a customer
 * name, middle initials are dropped so the same agent groups together. Returns ''
 * for writing numbers, which some carriers put in the agent column.
 */
export function normalizeAgentName(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (!raw) return ''
  if (/^\d+$/.test(raw)) return ''

  const aliasKey = (text: string) => text.toLowerCase().replace(/[^a-z ]+/gi, ' ').replace(/\s+/g, ' ').trim()
  const fromRaw = AGENT_ALIASES[aliasKey(raw)]
  if (fromRaw) return fromRaw

  // Drop bare middle initials ("Isaac J Reed" -> "Isaac Reed"); never the first token.
  const parts = reorderSurnameFirst(raw).filter((part, index) => index === 0 || part.replace(/\./g, '').length > 1)

  const composed = toTitleCase(parts.join(' '))
  return AGENT_ALIASES[aliasKey(composed)] ?? composed
}

/**
 * One display name per carrier. The tracker holds the carrier name
 * ("AMAM (American Amicable)"), the carrier code ("MOH") and shouted variants
 * ("AETNA") interchangeably; the spreadsheet wants the short canonical name.
 */
export function displayCarrier(value: unknown, ctx: ReportContext = {}): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  const strip = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim()

  const byCode = ctx.carrierNameByCode?.get(raw.toUpperCase())
  if (byCode) return strip(byCode)

  const match = (ctx.carrierNames ?? []).find((name) => name.toLowerCase() === raw.toLowerCase())
  if (match) return strip(match)

  const stripped = strip(raw)
  // "AETNA" with no carriers table loaded still shouldn't shout.
  return stripped === stripped.toUpperCase() && /[a-z]/i.test(stripped) && stripped.length > 4
    ? toTitleCase(stripped)
    : stripped
}

export function dealKey(agencyCarrierId: string, policyNumber: string): string {
  return `${agencyCarrierId}::${String(policyNumber ?? '').trim()}`
}

// ───────────────────────────── row construction ─────────────────────────────

type Entry = { date: string; amount: number; rate: number | null; txn: CommissionTxn }

/**
 * Mirrors the Commission Report page's dedupe so the two screens never disagree:
 * one transaction per (policy, date, net amount), keeping the highest id.
 */
function dedupe(txns: CommissionTxn[]): CommissionTxn[] {
  const byKey = new Map<string, CommissionTxn>()
  for (const txn of txns) {
    const advance = toNumber(txn.advance_amount) ?? 0
    const chargeback = toNumber(txn.charge_back_amount) ?? 0
    const net = advance !== 0 ? advance : chargeback
    if (net === 0) continue
    const key = `${txn.agency_carrier_id}::${String(txn.policy_number ?? '').trim()}::${toIsoDate(txn.date)}::${net.toFixed(2)}`
    const existing = byKey.get(key)
    if (!existing || String(txn.id ?? '') > String(existing.id ?? '')) byKey.set(key, txn)
  }
  return Array.from(byKey.values())
}

/** Pick the fullest of several spellings — the one that kept the middle name. */
function bestName(values: Array<string | null | undefined>): string {
  let best = ''
  for (const value of values) {
    const str = String(value ?? '').trim()
    if (!str || str === '-') continue
    const normalized = normalizePersonName(str)
    if (normalized.length > best.length) best = normalized
  }
  return best
}

function buildDataCheck(opts: {
  dealFound: boolean
  productCode: string
  primaryRate: number | null
  hasAdvance: boolean
  extraAdvances: number
  extraChargebacks: number
}): string {
  const notes: string[] = []

  if (opts.hasAdvance && opts.primaryRate == null) notes.push('Missing commission rate')

  if (!opts.dealFound) {
    notes.push('No deal tracker match - product code and call center unavailable')
  } else if (!opts.productCode) {
    notes.push('No product code on file')
  } else if (GENERIC_PRODUCT_CODES.has(opts.productCode.toLowerCase().replace(/\s+/g, ' '))) {
    notes.push('Generic product - no plan code on file')
  }

  if (opts.extraAdvances > 0) {
    notes.push(`${opts.extraAdvances} more advance${opts.extraAdvances === 1 ? '' : 's'} not shown`)
  }
  if (opts.extraChargebacks > 0) {
    notes.push(`${opts.extraChargebacks} more chargeback${opts.extraChargebacks === 1 ? '' : 's'} not shown`)
  }

  return notes.join('; ')
}

/**
 * Collapse the transaction list into one row per policy. Filters are applied
 * after the row is assembled, so a policy that qualifies on one date still shows
 * its whole advance/chargeback history — that is the point of the report.
 */
export function buildAdvanceChargebackRows(
  txns: CommissionTxn[],
  deals: DealInfo[],
  filters: ReportFilters = {},
  ctx: ReportContext = {}
): AdvanceChargebackRow[] {
  const dealByKey = new Map<string, DealInfo>()
  for (const deal of deals) {
    const key = dealKey(deal.agency_carrier_id, deal.policy_number)
    const existing = dealByKey.get(key)
    if (!existing || String(deal.updated_at ?? '') > String(existing.updated_at ?? '')) {
      dealByKey.set(key, deal)
    }
  }

  const groups = new Map<string, CommissionTxn[]>()
  for (const txn of dedupe(txns)) {
    const key = dealKey(txn.agency_carrier_id, txn.policy_number)
    const bucket = groups.get(key)
    if (bucket) bucket.push(txn)
    else groups.set(key, [txn])
  }

  const rows: AdvanceChargebackRow[] = []

  for (const [key, group] of groups) {
    const advances: Entry[] = []
    const chargebacks: Entry[] = []

    for (const txn of group) {
      const date = toIsoDate(txn.date)
      const advance = toNumber(txn.advance_amount) ?? 0
      const chargeback = toNumber(txn.charge_back_amount) ?? 0
      const rate = normalizeCommissionRate(txn.commission_rate)
      if (advance !== 0) advances.push({ date, amount: advance, rate, txn })
      else if (chargeback !== 0) chargebacks.push({ date, amount: chargeback, rate, txn })
    }
    if (!advances.length && !chargebacks.length) continue

    const byDate = (a: Entry, b: Entry) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    advances.sort(byDate)
    chargebacks.sort(byDate)

    const deal = dealByKey.get(key) ?? null
    const first = group[0]
    const policyNumber = String(first.policy_number ?? '').trim()

    const customerName = bestName([...group.map((t) => t.name), deal?.name])
    const salesAgent =
      group.map((t) => normalizeAgentName(t.sales_agent)).find(Boolean) ??
      normalizeAgentName(deal?.sales_agent) ??
      ''
    const carrier = displayCarrier(
      group.map((t) => t.carrier).find((c) => String(c ?? '').trim()) ?? deal?.carrier,
      ctx
    )
    const tidy = (value: unknown) => String(value ?? '').trim().replace(/\s+/g, ' ')
    const productCode = tidy(deal?.policy_type)
    const callCenter = tidy(deal?.call_center)
    const agency = ctx.agencyByAcId?.get(first.agency_carrier_id) ?? ''

    const advance1 = advances[0] ?? null
    const advance2 = advances[1] ?? null
    const chargeback1 = chargebacks[0] ?? null
    const chargeback2 = chargebacks[1] ?? null

    // "Date" is the first advance; a chargeback-only policy anchors on its first chargeback.
    const anchorDate = advance1?.date || chargeback1?.date || ''

    rows.push({
      key,
      agencyCarrierId: first.agency_carrier_id,
      policyNumber,
      agency,
      date: formatUsDate(anchorDate),
      policyLast3: policyLast3(policyNumber),
      customerName,
      carrier,
      salesAgent,
      commissionRate: formatRate(advance1?.rate ?? null),
      productCode,
      advance: formatAmount(advance1?.amount ?? null),
      chargeback: formatAmount(chargeback1?.amount ?? null),
      callCenter,
      chargebackDate: formatUsDate(chargeback1?.date ?? ''),
      advance2Date: formatUsDate(advance2?.date ?? ''),
      advance2: formatAmount(advance2?.amount ?? null),
      commissionRate2: formatRate(advance2?.rate ?? null),
      chargeback2: formatAmount(chargeback2?.amount ?? null),
      chargeback2Date: formatUsDate(chargeback2?.date ?? ''),
      dataCheck: buildDataCheck({
        dealFound: Boolean(deal),
        productCode,
        primaryRate: advance1?.rate ?? null,
        hasAdvance: Boolean(advance1),
        extraAdvances: Math.max(0, advances.length - 2),
        extraChargebacks: Math.max(0, chargebacks.length - 2),
      }),
      sortDate: anchorDate,
      advanceTotal: advances.reduce((sum, a) => sum + a.amount, 0),
      chargebackTotal: chargebacks.reduce((sum, c) => sum + c.amount, 0),
    })
  }

  return applyFilters(rows, filters).sort((a, b) => (a.sortDate < b.sortDate ? 1 : a.sortDate > b.sortDate ? -1 : 0))
}

function inRange(iso: string, from?: string, to?: string): boolean {
  if (!iso) return false
  if (from && iso < from) return false
  if (to && iso > to) return false
  return true
}

export function applyFilters(rows: AdvanceChargebackRow[], filters: ReportFilters): AdvanceChargebackRow[] {
  const {
    dateFrom,
    dateTo,
    dateBasis = 'any',
    carriers = [],
    callCenters = [],
    salesAgents = [],
    agencies = [],
    productCodes = [],
    activity = 'all',
    search = '',
  } = filters

  const toIso = (us: string) => {
    const m = String(us ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
    return m ? `${m[3]}-${m[1]}-${m[2]}` : ''
  }

  const policyList = search.includes(',')
    ? search.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : []
  const term = search.trim().toLowerCase()

  return rows.filter((row) => {
    if (dateFrom || dateTo) {
      const advanceDates = [toIso(row.date), toIso(row.advance2Date)].filter(Boolean)
      const chargebackDates = [toIso(row.chargebackDate), toIso(row.chargeback2Date)].filter(Boolean)
      const candidates =
        dateBasis === 'advance'
          ? advanceDates
          : dateBasis === 'chargeback'
            ? chargebackDates
            : [...advanceDates, ...chargebackDates]
      if (!candidates.some((d) => inRange(d, dateFrom, dateTo))) return false
    }

    if (carriers.length && !carriers.includes(row.carrier)) return false
    if (callCenters.length && !callCenters.includes(row.callCenter)) return false
    if (salesAgents.length && !salesAgents.includes(row.salesAgent)) return false
    if (agencies.length && !agencies.includes(row.agency)) return false
    if (productCodes.length && !productCodes.includes(row.productCode)) return false

    const hasAdvance = Boolean(row.advance)
    const hasChargeback = Boolean(row.chargeback)
    if (activity === 'with_chargeback' && !hasChargeback) return false
    if (activity === 'advance_only' && (hasChargeback || !hasAdvance)) return false
    if (activity === 'chargeback_only' && (hasAdvance || !hasChargeback)) return false

    if (policyList.length) return policyList.includes(row.policyNumber.toLowerCase())
    if (term) {
      return (
        row.policyNumber.toLowerCase().includes(term) ||
        row.customerName.toLowerCase().includes(term) ||
        row.salesAgent.toLowerCase().includes(term)
      )
    }
    return true
  })
}

// ──────────────────────────────── CSV output ────────────────────────────────

export function rowToCsvValues(row: AdvanceChargebackRow): string[] {
  return [
    row.date,
    row.policyLast3,
    row.customerName,
    row.carrier,
    row.salesAgent,
    row.commissionRate,
    row.productCode,
    row.advance,
    row.chargeback,
    row.callCenter,
    row.chargebackDate,
    row.advance2Date,
    row.advance2,
    row.commissionRate2,
    row.chargeback2,
    row.chargeback2Date,
    row.dataCheck,
  ]
}

function escapeCsv(value: string): string {
  const str = String(value ?? '')
  return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

export function rowsToCsv(rows: AdvanceChargebackRow[]): string {
  const lines = [ADVANCE_CHARGEBACK_HEADERS.join(',')]
  for (const row of rows) lines.push(rowToCsvValues(row).map(escapeCsv).join(','))
  return lines.join('\r\n')
}

export function exportFileName(filters: ReportFilters, today = new Date()): string {
  const stamp = (iso?: string) => (iso ? iso.replace(/-/g, '') : '')
  const range = filters.dateFrom || filters.dateTo
    ? `_${stamp(filters.dateFrom) || 'start'}-${stamp(filters.dateTo) || 'end'}`
    : ''
  const generated = today.toISOString().slice(0, 10)
  return `commission-advance-chargeback${range}_${generated}.csv`
}
