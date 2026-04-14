import { supabase } from './supabaseClient'

export type InvoicingStatus =
  | 'new_sale'
  | 'New Charge Back'
  | 'repay'
  | 'rechargeback'
  | 'paid_delete'
  | 'cb_delete'
  | 'cb_never_paid'
  | 'cb_repay'

function isChargebackLikeStatus(current: InvoicingStatus | null): boolean {
  if (current == null) return false
  return current === 'New Charge Back' || current === 'rechargeback' || current === ('chargeback' as InvoicingStatus)
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

type DealTrackerCallCenterRow = {
  agency_carrier_id: string
  policy_number: string
  call_center: string | null
  ghl_stage?: string | null
  deal_value?: number | null
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
  if (current === 'new_sale' || current === 'paid_delete' || current === 'cb_repay') return 'New Charge Back'
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

function buildPolicyKey(agencyCarrierId: string, policyNumber: string): string {
  return `${agencyCarrierId}::${normalizePolicyNumber(policyNumber)}`
}

const CHARGEBACK_STAGE_LABELS = [
  'FDPF Pending Reason',
  'Pending Lapse Pending Reason',
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

export async function buildInvoiceDraft(startDate: string, endDate: string): Promise<InvoiceDraftResult> {
  const { data: txRows, error: txError } = await supabase
    .from('commission_tracker')
    .select('id, agency_carrier_id, carrier, policy_number, name, date, advance_amount, charge_back_amount')
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (txError) {
    throw new Error(txError.message)
  }

  const transactions = (txRows || []) as CommissionEventRow[]
  if (!transactions.length) {
    return {
      startDate,
      endDate,
      groups: [],
      grossGrandTotal: 0,
      ccGrandTotal: 0,
    }
  }

  const policyNumbers = Array.from(
    new Set(
      transactions
        .flatMap((row) => policyLookupCandidates(row.policy_number))
        .filter((v) => v.length > 0),
    ),
  )
  const agencyCarrierIds = Array.from(new Set(transactions.map((row) => row.agency_carrier_id).filter(Boolean)))

  const { data: historyRows, error: historyError } = await supabase
    .from('invoicing_status_history')
    .select('agency_carrier_id, policy_number, invoicing_status, effective_date, created_at')
    .in('policy_number', policyNumbers)
    .in('agency_carrier_id', agencyCarrierIds)
    .lt('effective_date', startDate)
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (historyError) {
    throw new Error(historyError.message)
  }

  const latestStatusByPolicy = new Map<string, InvoicingStatus>()
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

  const { data: dtRows, error: dtError } = await supabase
    .from('deal_tracker')
    .select('agency_carrier_id, policy_number, call_center, ghl_stage, deal_value, updated_at, created_at')
    .in('policy_number', policyNumbers)
    .in('agency_carrier_id', agencyCarrierIds)

  if (dtError) {
    throw new Error(dtError.message)
  }

  const callCenterByPolicy = new Map<string, { callCenter: string; ts: number }>()
  const dealByPolicy = new Map<string, DealTrackerCallCenterRow>()
  for (const row of (dtRows || []) as DealTrackerCallCenterRow[]) {
    const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
    const current = callCenterByPolicy.get(key)
    const nextTimestamp = parseSortableTimestamp(row)
    const nextCallCenter = row.call_center?.trim() || 'Unassigned'
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

  const policyMap = new Map<string, InvoicePolicyDraft>()
  for (const tx of transactions) {
    const policyKey = buildPolicyKey(tx.agency_carrier_id, tx.policy_number)
    const existing = policyMap.get(policyKey)
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
        callCenter: callCenterByPolicy.get(policyKey)?.callCenter || 'Unassigned',
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
  }

  // Stage-driven chargeback: when a deal is in chargeback pipeline, charge back 50% of deal_value.
  // We apply this once per policy in the draft (only if no negative event already exists in period).
  for (const policy of policyMap.values()) {
    const deal = dealByPolicy.get(policy.policyKey)
    if (!deal || !isChargebackPipelineStage(deal.ghl_stage)) continue
    const hasChargebackEvent = policy.events.some((e) => e.grossAmount < 0)
    if (hasChargebackEvent) continue
    const dealValue = toNumber(deal.deal_value)
    if (dealValue <= 0) continue
    const grossAmount = roundMoney(-Math.abs(dealValue))
    const nextStatus = deriveNextStatus(policy.latestInvoicingStatus, grossAmount)
    policy.latestInvoicingStatus = nextStatus
    if (!isBillableStatus(nextStatus)) continue
    policy.grossNet = roundMoney(policy.grossNet + grossAmount)
    policy.ccNet = roundMoney(policy.grossNet / 2)
    policy.events.push({
      eventId: `stage-cb-${policy.policyKey}`,
      date: endDate,
      carrier: policy.carrier,
      advanceAmount: 0,
      chargeBackAmount: grossAmount,
      grossAmount,
      invoicingStatus: nextStatus,
    })
  }

  // ── Stage-only chargebacks: policies in chargeback pipeline with NO commission events in this period ──
  {
    const cbStageDeals = await fetchAllChargebackStageDeals<DealTrackerCallCenterRow>(
      'agency_carrier_id, policy_number, call_center, name, policy_type, deal_value, ghl_stage, updated_at, created_at',
    )

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
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (policyMap.has(key)) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const priorStatus = unseenStatus.get(key) ?? null
        const grossAmount = roundMoney(-Math.abs(dealValue))
        const nextStatus = deriveNextStatus(priorStatus, grossAmount)
        if (!isBillableStatus(nextStatus)) continue
        const callCenter = deal.call_center?.trim() || 'Unassigned'
        policyMap.set(key, {
          policyKey: key,
          agencyCarrierId: deal.agency_carrier_id,
          policyNumber: deal.policy_number,
          carrier: '—',
          policyName: deal.name?.trim() || '-',
          callCenter,
          latestCommissionDate: endDate,
          latestInvoicingStatus: nextStatus,
          grossNet: grossAmount,
          ccNet: roundMoney(grossAmount / 2),
          events: [
            {
              eventId: `stage-cb-${key}`,
              date: endDate,
              carrier: '—',
              advanceAmount: 0,
              chargeBackAmount: grossAmount,
              grossAmount,
              invoicingStatus: nextStatus,
            },
          ],
        })
      }
    }
  }

  const grouped = new Map<string, InvoicePolicyDraft[]>()
  for (const policy of policyMap.values()) {
    if (roundMoney(policy.grossNet) === 0) continue
    const callCenter = policy.callCenter || 'Unassigned'
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
  carrier: string
  product: string
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
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })
}

type DealTrackerInvoiceRow = {
  agency_carrier_id: string
  policy_number: string
  call_center: string | null
  name: string | null
  policy_type: string | null
  sales_agent: string | null
  commission_type: string | null
  effective_date: string | null
  deal_creation_date: string | null
  deal_value: number | null
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

/**
 * Line-level BPO invoices: group by deal_tracker.call_center (BPO).
 * Sales rows = advance_amount > 0; Chargebacks = non-zero charge_back_amount.
 * Lead value on the invoice is 50% of the underlying advance/chargeback (not the full commission amount).
 */
export async function buildBpoInvoiceLines(startDate: string, endDate: string): Promise<BpoInvoiceDetailResult> {
  const { data: txRows, error: txError } = await supabase
    .from('commission_tracker')
    .select(
      'id, agency_carrier_id, carrier, policy_number, name, date, sales_agent, commission_rate, advance_amount, charge_back_amount',
    )
    .gte('date', startDate)
    .lte('date', endDate)
    .order('date', { ascending: true })

  if (txError) {
    throw new Error(txError.message)
  }

  const transactions = (txRows || []) as CommissionTxRow[]
  const rangeLabel = formatInvoiceRangeLabel(startDate, endDate)

  if (!transactions.length) {
    return { startDate, endDate, rangeLabel, groups: [] }
  }

  const policyNumbers = Array.from(
    new Set(
      transactions
        .flatMap((t) => policyLookupCandidates(t.policy_number))
        .filter((v) => v.length > 0),
    ),
  )
  const agencyCarrierIds = Array.from(new Set(transactions.map((t) => t.agency_carrier_id).filter(Boolean)))

  const { data: historyRows, error: historyError } = await supabase
    .from('invoicing_status_history')
    .select('agency_carrier_id, policy_number, invoicing_status, effective_date, created_at')
    .in('policy_number', policyNumbers)
    .in('agency_carrier_id', agencyCarrierIds)
    .lt('effective_date', startDate)
    .order('effective_date', { ascending: false })
    .order('created_at', { ascending: false })

  if (historyError) {
    throw new Error(historyError.message)
  }

  const latestStatusByPolicy = new Map<string, InvoicingStatus>()
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

  const { data: dtRows, error: dtError } = await supabase
    .from('deal_tracker')
    .select(
      'agency_carrier_id, policy_number, call_center, name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, ghl_stage, updated_at, created_at',
    )
    .in('policy_number', policyNumbers)
    .in('agency_carrier_id', agencyCarrierIds)

  if (dtError) {
    throw new Error(dtError.message)
  }

  const dealByPolicyKey = new Map<string, DealTrackerInvoiceRow>()
  for (const row of (dtRows || []) as DealTrackerInvoiceRow[]) {
    const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
    const existing = dealByPolicyKey.get(key)
    const ts = new Date(row.updated_at || row.created_at || 0).getTime()
    const exTs = existing ? new Date(existing.updated_at || existing.created_at || 0).getTime() : -1
    if (!existing || ts >= exTs) {
      dealByPolicyKey.set(key, row)
    }
  }

  const linesByCenter = new Map<string, { sales: BpoInvoiceLine[]; charge: BpoInvoiceLine[] }>()
  const chargebackLineAddedByPolicy = new Set<string>()
  const currentStatusByPolicy = new Map<string, InvoicingStatus | null>()

  const pushLine = (center: string, line: BpoInvoiceLine, kind: 'sales' | 'charge') => {
    const c = center.trim() || 'Unassigned'
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
    const deal = dealByPolicyKey.get(key)
    const callCenter = deal?.call_center?.trim() || 'Unassigned'
    const insuredName = (tx.name || deal?.name || '—').trim() || '—'
    const product = (deal?.policy_type || '—').trim() || '—'
    const agentAccount = (deal?.sales_agent || tx.sales_agent || '—').trim() || '—'
    const draftRaw = deal?.deal_creation_date || deal?.effective_date || tx.date
    const draftDate = formatDraftDate(draftRaw)
    const monthlyPremium = deal?.deal_value != null ? roundMoney(toNumber(deal.deal_value as number)) : null
    const comPctDisplay = tx.commission_rate != null ? `${Number(tx.commission_rate)}%` : '—'
    const comType = (deal?.commission_type || 'Advance').trim() || 'Advance'

    const base = {
      insuredName,
      carrier: tx.carrier || '—',
      product,
      agentAccount,
      draftDate,
      monthlyPremium,
      coverageAmount: null,
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
      pushLine(
        callCenter,
        {
          id: `${tx.id}-adv`,
          ...base,
          leadValue: roundMoney(advance * BPO_INVOICE_LEAD_VALUE_SHARE),
        },
        'sales',
      )
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
        chargebackLineAddedByPolicy.add(key)
        pushLine(
          callCenter,
          {
            id: `${tx.id}-cb`,
            ...base,
            leadValue: roundMoney(cbNorm * BPO_INVOICE_LEAD_VALUE_SHARE),
          },
          'charge',
        )
      }
    }
  }

  // If no commission chargeback line exists but policy is in chargeback pipeline,
  // add a synthetic chargeback line from deal_tracker.deal_value.
  for (const [key, deal] of dealByPolicyKey.entries()) {
    if (!isChargebackPipelineStage(deal.ghl_stage)) continue
    if (chargebackLineAddedByPolicy.has(key)) continue
    const dealValue = toNumber(deal.deal_value)
    if (dealValue <= 0) continue
    const callCenter = deal.call_center?.trim() || 'Unassigned'
    const insuredName = (deal.name || '—').trim() || '—'
    const product = (deal.policy_type || '—').trim() || '—'
    const agentAccount = (deal.sales_agent || '—').trim() || '—'
    const draftRaw = deal.deal_creation_date || deal.effective_date || endDate
    const draftDate = formatDraftDate(draftRaw)
    const monthlyPremium = roundMoney(dealValue)
    const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
    const cbNorm = -Math.abs(dealValue)
    const statusBeforeCb = currentStatusByPolicy.has(key)
      ? currentStatusByPolicy.get(key) ?? null
      : (latestStatusByPolicy.get(key) ?? null)
    const cbStatus = deriveNextStatus(statusBeforeCb, roundMoney(cbNorm))
    currentStatusByPolicy.set(key, cbStatus)
    if (!isBillableStatus(cbStatus)) continue
    pushLine(
      callCenter,
      {
        id: `stage-cb-${key}`,
        insuredName,
        carrier: '—',
        product,
        agentAccount,
        draftDate,
        monthlyPremium,
        coverageAmount: null,
        comPct: '—',
        comType,
        policyNumber: deal.policy_number,
        leadValue: roundMoney(cbNorm * BPO_INVOICE_LEAD_VALUE_SHARE),
      },
      'charge',
    )
  }

  // ── Stage-only chargebacks: policies in chargeback pipeline with NO commission events in this period ──
  {
    const cbStageDeals = await fetchAllChargebackStageDeals<DealTrackerInvoiceRow>(
      'agency_carrier_id, policy_number, call_center, name, policy_type, sales_agent, commission_type, effective_date, deal_creation_date, deal_value, ghl_stage, updated_at, created_at',
    )

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
        const key = buildPolicyKey(deal.agency_carrier_id, deal.policy_number)
        if (dealByPolicyKey.has(key)) continue
        const dealValue = toNumber(deal.deal_value)
        if (dealValue <= 0) continue
        const priorStatus = unseenStatus.get(key) ?? null
        const cbNorm = -Math.abs(dealValue)
        const cbStatus = deriveNextStatus(priorStatus, roundMoney(cbNorm))
        if (!isBillableStatus(cbStatus)) continue
        const callCenter = deal.call_center?.trim() || 'Unassigned'
        const insuredName = (deal.name || '—').trim() || '—'
        const product = (deal.policy_type || '—').trim() || '—'
        const agentAccount = (deal.sales_agent || '—').trim() || '—'
        const draftRaw = deal.deal_creation_date || deal.effective_date || endDate
        const draftDate = formatDraftDate(draftRaw)
        const monthlyPremium = roundMoney(dealValue)
        const comType = (deal.commission_type || 'Advance').trim() || 'Advance'
        pushLine(
          callCenter,
          {
            id: `stage-cb-${key}`,
            insuredName,
            carrier: '—',
            product,
            agentAccount,
            draftDate,
            monthlyPremium,
            coverageAmount: null,
            comPct: '—',
            comType,
            policyNumber: deal.policy_number,
            leadValue: roundMoney(cbNorm * BPO_INVOICE_LEAD_VALUE_SHARE),
          },
          'charge',
        )
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

export async function getPreviousChargebackByCallCenter(callCenters: string[]): Promise<Record<string, number>> {
  if (!callCenters.length) return {}
  const { data, error } = await supabase
    .from('invoicing_call_center_ledger')
    .select('call_center, ending_chargeback_amount, created_at')
    .in('call_center', callCenters)
    .order('created_at', { ascending: false })

  if (error) {
    throw new Error(error.message)
  }

  const result: Record<string, number> = {}
  for (const center of callCenters) {
    result[center] = 0
  }
  for (const row of (data || []) as Array<{ call_center: string; ending_chargeback_amount: number | null }>) {
    if (!(row.call_center in result)) continue
    if (result[row.call_center] !== 0) continue
    result[row.call_center] = toNumber(row.ending_chargeback_amount)
  }
  return result
}
