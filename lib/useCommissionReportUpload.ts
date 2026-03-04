/**
 * Hook for commission report step in upload flow (AETNA/AMAM).
 * Loads commission rows by file_id, allows edit in dialog, then upserts on Save.
 * When a policy already exists in deal_tracker (same agency_carrier_id + policy_number),
 * we use that record to enrich commission rows (name, sales_agent) when loading and when saving.
 */

import { useState, useCallback } from 'react'
import { supabase } from './supabaseClient'

type DealTrackerRow = {
  policy_number: string
  name: string | null
  sales_agent: string | null
  [key: string]: unknown
}

/** Fetch deal_tracker rows by agency_carrier_id and list of policy numbers. Returns map by policy_number. */
async function fetchDealTrackerByPolicies(
  agencyCarrierId: string,
  policyNumbers: string[]
): Promise<Map<string, DealTrackerRow>> {
  if (policyNumbers.length === 0) return new Map()
  const normalized = policyNumbers.map((p) => (p || '').trim()).filter(Boolean)
  if (normalized.length === 0) return new Map()
  const { data, error } = await supabase
    .from('deal_tracker')
    .select('policy_number, name, sales_agent')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', normalized)
  if (error) {
    console.warn('[Commission Report] Deal tracker lookup failed:', error)
    return new Map()
  }
  const map = new Map<string, DealTrackerRow>()
  for (const row of data || []) {
    const p = row.policy_number
    if (p) map.set(p, row as DealTrackerRow)
  }
  return map
}

export type CommissionDisplayRow = {
  id?: string
  name: string
  date: string
  policy_number: string
  carrier: string
  sales_agent: string
  commission_rate: string
  advance: string
  charge_back: string
  _raw?: Record<string, unknown>
}

function toDateInputValue(val: unknown): string {
  if (val == null) return ''
  const d = new Date(String(val))
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

/** True if value looks like only a number (e.g. agent number in AMAM commission file). */
function looksLikeNumberOnly(val: unknown): boolean {
  if (val == null) return true
  const s = String(val).trim()
  if (!s) return true
  return /^\d+$/.test(s)
}

function dbRowToDisplay(
  row: Record<string, any>,
  carrierCode: string,
  dealTrackerMap?: Map<string, DealTrackerRow>
): CommissionDisplayRow {
  let name =
    row.client ?? row.insured_name ?? row.INSURED_NAME ?? row['Name'] ?? ''
  let salesAgent =
    row.writingagentname ?? row.writingagent ?? row['Sales Agent'] ?? ''
  const policyNumber = String(row.policy_number ?? '')
  const dt = dealTrackerMap?.get(policyNumber)
  if (dt) {
    if (!name?.toString().trim()) name = dt.name ?? ''
    // For AMAM, commission file often has only agent number; prefer deal_tracker name when current value is number-only
    const useDtSalesAgent =
      !salesAgent?.toString().trim() ||
      (carrierCode === 'AMAM' && looksLikeNumberOnly(salesAgent) && dt.sales_agent?.toString().trim())
    if (useDtSalesAgent && dt.sales_agent?.toString().trim()) salesAgent = dt.sales_agent
  }
  const dateRaw =
    row.commissionpaiddate ?? row.statement_date ?? row.effectivedate ?? row.appdate ?? row['Date'] ?? ''
  const rate = row.rate_pct ?? row.com_rate ?? row.adv_rate ?? row['Commission Rate'] ?? ''
  const rawAdvanceVal = row.commissionamount ?? row.advance ?? row['Advance']
  let advance = rawAdvanceVal != null && rawAdvanceVal !== '' ? String(rawAdvanceVal) : ''
  let chargeBack = ''

  // Commission tracker rule:
  // - If advance/commissionamount is negative, show it in Charge Back (with minus sign) and blank Advance.
  // - Otherwise, show it as Advance and leave Charge Back empty.
  const parsedAdvance = advance ? parseFloat(String(advance).replace(/,/g, '')) : NaN
  if (!Number.isNaN(parsedAdvance) && parsedAdvance < 0) {
    advance = ''
    chargeBack = String(parsedAdvance.toFixed(2))
  }
  const carrierLabel = carrierCode === 'AMAM' ? 'AMAM' : 'Aetna'
  return {
    id: row.id,
    name: String(name ?? ''),
    date: toDateInputValue(dateRaw),
    policy_number: policyNumber,
    carrier: row.__carrier ?? carrierLabel,
    sales_agent: String(salesAgent ?? ''),
    commission_rate: rate != null && rate !== '' ? String(rate) : '',
    advance,
    charge_back: String(chargeBack ?? ''),
    _raw: row,
  }
}

function displayToDbRow(
  display: CommissionDisplayRow,
  carrierCode: string,
  agencyCarrierId: string,
  fileId: string,
  dealTrackerRow?: DealTrackerRow | null
): Record<string, unknown> {
  const raw = (display._raw || {}) as Record<string, unknown>
  let name = display.name || (raw.client as string) || (raw.insured_name as string)
  let salesAgent = display.sales_agent || (raw.writingagentname as string) || (raw.writingagent as string)
  if (dealTrackerRow) {
    if (!name?.toString().trim() && dealTrackerRow.name?.toString().trim()) name = dealTrackerRow.name
    // Prefer deal_tracker name when empty or (for AMAM) when current value is only a number
    const useDtSalesAgent =
      !salesAgent?.toString().trim() ||
      (carrierCode === 'AMAM' && looksLikeNumberOnly(salesAgent) && dealTrackerRow.sales_agent?.toString().trim())
    if (useDtSalesAgent && dealTrackerRow.sales_agent?.toString().trim()) salesAgent = dealTrackerRow.sales_agent
  }
  const base = {
    ...raw,
    agency_carrier_id: agencyCarrierId,
    file_id: fileId,
    policy_number: display.policy_number || (raw.policy_number as string),
  } as Record<string, unknown>

  if (carrierCode === 'AETNA') {
    base.client = name
    base.writingagentname = salesAgent
    base.rate_pct = display.commission_rate || (raw.rate_pct as string)
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    // Only update commissionamount when advance is positive; otherwise preserve existing value
    if (!Number.isNaN(advNum) && advNum > 0) {
      base.commissionamount = advNum
    } else {
      base.commissionamount = raw.commissionamount as number
    }
    // Charge Back is a derived/display-only field from negative commissionamount; we don't persist a separate column.
    if (display.date) base.commissionpaiddate = display.date
  } else {
    base.insured_name = name
    base.writingagent = salesAgent
    base.com_rate = display.commission_rate ? parseFloat(String(display.commission_rate).replace(/,/g, '')) : (raw.com_rate as number)
    base.advance = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : (raw.advance as number)
    if (display.date) base.statement_date = display.date
  }
  return base
}

export function useCommissionReportUpload(options?: { onAfterSave?: () => void | Promise<void> }) {
  const [showCommissionReport, setShowCommissionReport] = useState(false)
  const [commissionRows, setCommissionRows] = useState<CommissionDisplayRow[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [context, setContext] = useState<{
    agencyCarrierId: string
    fileId: string
    carrierCode: string
  } | null>(null)

  const openCommissionReport = useCallback(
    async (agencyCarrierId: string, fileId: string, carrierCode: string) => {
      if (carrierCode !== 'AETNA' && carrierCode !== 'AMAM') return
      setContext({ agencyCarrierId, fileId, carrierCode })
      setLoading(true)
      setShowCommissionReport(true)
      setCommissionRows([])
      try {
        const table =
          carrierCode === 'AMAM' ? 'amam_commissions' : 'aetna_commissions'
        const { data, error } = await supabase
          .from(table)
          .select('*')
          .eq('agency_carrier_id', agencyCarrierId)
          .eq('file_id', fileId)
          .order('row_number', { ascending: true })

        if (error) {
          console.error('[Commission Report] Fetch error:', error)
          setCommissionRows([])
          return
        }
        const commissionData = data || []
        const policyNumbers = commissionData.map((r: Record<string, any>) => r.policy_number).filter(Boolean)
        const dealTrackerMap = await fetchDealTrackerByPolicies(agencyCarrierId, policyNumbers)
        const rows = commissionData.map((r: Record<string, any>) =>
          dbRowToDisplay(r, carrierCode, dealTrackerMap)
        )
        setCommissionRows(rows)
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const saveCommissionReport = useCallback(
    async (editedRows: CommissionDisplayRow[]) => {
      if (!context || editedRows.length === 0) return
      const { agencyCarrierId, fileId, carrierCode } = context
      const table =
        carrierCode === 'AMAM' ? 'amam_commissions' : 'aetna_commissions'
      setSaving(true)
      try {
        const policyNumbers = editedRows.map((r) => r.policy_number).filter(Boolean)
        const dealTrackerMap = await fetchDealTrackerByPolicies(agencyCarrierId, policyNumbers)
        const dbRows = editedRows.map((r) =>
          displayToDbRow(
            r,
            carrierCode,
            agencyCarrierId,
            fileId,
            r.policy_number ? dealTrackerMap.get(r.policy_number) : undefined
          )
        )
        const now = new Date().toISOString()
        const chunk = dbRows.map((row) => {
          const r = { ...row, updated_at: now }
          delete (r as any).id
          delete (r as any).created_at
          return r
        })
        const { error } = await supabase
          .from(table)
          .upsert(chunk, {
            onConflict: 'agency_carrier_id,policy_number',
            ignoreDuplicates: false,
          })
        if (error) throw error
        setShowCommissionReport(false)
        setCommissionRows([])
        setContext(null)
        await options?.onAfterSave?.()
      } catch (e) {
        console.error('[Commission Report] Save error:', e)
        throw e
      } finally {
        setSaving(false)
      }
    },
    [context, options]
  )

  const cancelCommissionReport = useCallback(() => {
    setShowCommissionReport(false)
    setCommissionRows([])
    setContext(null)
  }, [])

  return {
    showCommissionReport,
    setShowCommissionReport,
    commissionRows,
    setCommissionRows,
    loading,
    saving,
    openCommissionReport,
    saveCommissionReport,
    cancelCommissionReport,
  }
}
