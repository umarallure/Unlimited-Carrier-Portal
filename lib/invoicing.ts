import { supabase } from './supabaseClient'

export type InvoicingStatus = 'new_sale' | 'chargeback' | 'repay' | 'rechargeback'

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
  if (grossAmount < 0) {
    return current === 'repay' ? 'rechargeback' : 'chargeback'
  }
  if (current === 'chargeback' || current === 'rechargeback') {
    return 'repay'
  }
  return 'new_sale'
}

function parseSortableTimestamp(row: DealTrackerCallCenterRow): number {
  const raw = row.updated_at || row.created_at || ''
  const parsed = raw ? new Date(raw).getTime() : 0
  return Number.isNaN(parsed) ? 0 : parsed
}

function buildPolicyKey(agencyCarrierId: string, policyNumber: string): string {
  return `${agencyCarrierId}::${policyNumber}`
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

  const policyNumbers = Array.from(new Set(transactions.map((row) => row.policy_number).filter(Boolean)))
  const agencyCarrierIds = Array.from(new Set(transactions.map((row) => row.agency_carrier_id).filter(Boolean)))

  const { data: dtRows, error: dtError } = await supabase
    .from('deal_tracker')
    .select('agency_carrier_id, policy_number, call_center, updated_at, created_at')
    .in('policy_number', policyNumbers)
    .in('agency_carrier_id', agencyCarrierIds)

  if (dtError) {
    throw new Error(dtError.message)
  }

  const callCenterByPolicy = new Map<string, { callCenter: string; ts: number }>()
  for (const row of (dtRows || []) as DealTrackerCallCenterRow[]) {
    const key = buildPolicyKey(row.agency_carrier_id, row.policy_number)
    const current = callCenterByPolicy.get(key)
    const nextTimestamp = parseSortableTimestamp(row)
    const nextCallCenter = row.call_center?.trim() || 'Unassigned'
    if (!current) {
      callCenterByPolicy.set(key, { callCenter: nextCallCenter, ts: nextTimestamp })
      continue
    }
    if (nextTimestamp >= current.ts && row.call_center?.trim()) {
      callCenterByPolicy.set(key, { callCenter: row.call_center.trim(), ts: nextTimestamp })
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
      const firstStatus = deriveNextStatus(null, grossAmount)
      policyMap.set(policyKey, {
        policyKey,
        agencyCarrierId: tx.agency_carrier_id,
        policyNumber: tx.policy_number,
        carrier: tx.carrier,
        policyName: tx.name?.trim() || '-',
        callCenter: callCenterByPolicy.get(policyKey)?.callCenter || 'Unassigned',
        latestCommissionDate: tx.date,
        latestInvoicingStatus: firstStatus,
        grossNet: grossAmount,
        ccNet: roundMoney(grossAmount / 2),
        events: [
          {
            eventId: tx.id,
            date: tx.date,
            carrier: tx.carrier,
            advanceAmount,
            chargeBackAmount,
            grossAmount,
            invoicingStatus: firstStatus,
          },
        ],
      })
      continue
    }

    const nextStatus = deriveNextStatus(existing.latestInvoicingStatus, grossAmount)
    existing.latestInvoicingStatus = nextStatus
    if ((!existing.policyName || existing.policyName === '-') && tx.name?.trim()) {
      existing.policyName = tx.name.trim()
    }
    existing.grossNet = roundMoney(existing.grossNet + grossAmount)
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
      grossAmount,
      invoicingStatus: nextStatus,
    })
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
