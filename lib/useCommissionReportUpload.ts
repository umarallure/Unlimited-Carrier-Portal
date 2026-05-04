/**
 * Hook for commission report step in upload flow (AETNA/AMAM).
 * Loads commission rows by file_id, allows edit in dialog, then upserts on Save.
 * When a policy already exists in deal_tracker (same agency_carrier_id + policy_number),
 * we use that record to enrich commission rows (name, sales_agent) when loading and when saving.
 */

import { useState, useCallback, useRef } from 'react'
import { supabase } from './supabaseClient'
import { toYmdForDateInput } from './calendarDate'
import { syncCommissionTrackerForAgencyCarrier } from './commissionTracker'

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

export type CommissionDuplicateIssue = {
  kind: 'within_file' | 'existing_record'
  summary: string
  policy_number: string
  date: string
  amountDisplay: string
}

/** Name, policy #, or carrier cannot be empty or a lone "-" when saving commission rows. */
export function isCommissionRowIncomplete(row: CommissionDisplayRow): boolean {
  const bad = (v: string) => {
    const t = (v || '').trim()
    return t === '' || t === '-'
  }
  return bad(row.name) || bad(row.policy_number) || bad(row.carrier)
}

/** Returns an error message if any row is invalid; otherwise null. */
export function validateCommissionRowsForSave(rows: CommissionDisplayRow[]): string | null {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const n = (row.name || '').trim()
    const p = (row.policy_number || '').trim()
    const c = (row.carrier || '').trim()
    if (n === '' || n === '-') {
      return `Row ${i + 1}: Name cannot be empty or "-" before saving.`
    }
    if (p === '' || p === '-') {
      return `Row ${i + 1}: Policy number cannot be empty or "-" before saving.`
    }
    if (c === '' || c === '-') {
      return `Row ${i + 1}: Carrier cannot be empty or "-" before saving.`
    }
  }
  return null
}

function normalizePolicyNumber(p: string | undefined): string {
  return (p || '').trim()
}

/** Signed commission for duplicate checks: positive advance or negative charge back; null if no amount. */
function netCommissionAmountForDupes(row: CommissionDisplayRow): number | null {
  const adv = row.advance?.trim() ? parseFloat(String(row.advance).replace(/,/g, '')) : NaN
  const cb = row.charge_back?.trim() ? parseFloat(String(row.charge_back).replace(/,/g, '')) : NaN
  if (!Number.isNaN(adv) && adv !== 0) return Math.round(adv * 100) / 100
  if (!Number.isNaN(cb) && cb !== 0) return Math.round(cb * 100) / 100
  return null
}

function resolveRowDateYmdForDupes(
  row: CommissionDisplayRow,
  carrierCode: string,
  fileStatementDate: string
): string {
  const raw = (fileStatementDate.trim() ? fileStatementDate : row.date) ?? ''
  const str = String(raw).trim()
  if (!str) return ''
  const ymd = str.match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymd) return ymd[1]
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (us) {
    return `${us[3]}-${String(parseInt(us[1], 10)).padStart(2, '0')}-${String(parseInt(us[2], 10)).padStart(2, '0')}`
  }
  return str.slice(0, 10)
}

/** Business key: policy + statement/paid date + signed commission amount. */
export function buildCommissionDuplicateKey(
  row: CommissionDisplayRow,
  carrierCode: string,
  fileStatementDate: string
): string | null {
  const policy = normalizePolicyNumber(row.policy_number)
  if (!policy) return null
  const dateYmd = resolveRowDateYmdForDupes(row, carrierCode, fileStatementDate)
  if (!dateYmd) return null
  const amt = netCommissionAmountForDupes(row)
  if (amt == null) return null
  return `${policy}|${dateYmd}|${amt.toFixed(2)}`
}

export function findWithinFileCommissionDuplicates(
  rows: CommissionDisplayRow[],
  carrierCode: string,
  fileStatementDate: string
): CommissionDuplicateIssue[] {
  const byKey = new Map<string, { indices: number[]; policy: string; dateYmd: string; amt: number }>()
  rows.forEach((row, idx) => {
    const policy = normalizePolicyNumber(row.policy_number)
    if (!policy) return
    const dateYmd = resolveRowDateYmdForDupes(row, carrierCode, fileStatementDate)
    if (!dateYmd) return
    const amt = netCommissionAmountForDupes(row)
    if (amt == null) return
    const key = `${policy}|${dateYmd}|${amt.toFixed(2)}`
    const g = byKey.get(key) || { indices: [] as number[], policy, dateYmd, amt }
    g.indices.push(idx)
    byKey.set(key, g)
  })

  const issues: CommissionDuplicateIssue[] = []
  for (const { indices, policy, dateYmd, amt } of byKey.values()) {
    if (indices.length < 2) continue
    issues.push({
      kind: 'within_file',
      summary: `Rows ${indices.map((i) => i + 1).join(', ')} repeat the same policy, date, and commission amount in this upload.`,
      policy_number: policy,
      date: dateYmd,
      amountDisplay: amt < 0 ? `Charge back ${amt.toFixed(2)}` : `Advance ${amt.toFixed(2)}`,
    })
  }
  return issues
}

function normalizeTrackerDate(value: unknown): string {
  if (value == null || value === '') return ''
  const str = String(value).trim().split('to')[0].trim()
  if (!str) return ''
  const ymd = str.match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymd) return ymd[1]
  const us = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (us) {
    return `${us[3]}-${String(parseInt(us[1], 10)).padStart(2, '0')}-${String(parseInt(us[2], 10)).padStart(2, '0')}`
  }
  const normalized = str.replace(/\./g, '-').replace(/\//g, '-')
  const d = new Date(normalized.includes('T') ? normalized : `${normalized}T12:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function netAmountFromTrackerRow(t: {
  advance_amount: unknown
  charge_back_amount: unknown
}): number | null {
  const adv = t.advance_amount != null && t.advance_amount !== '' ? Number(t.advance_amount) : NaN
  const cb = t.charge_back_amount != null && t.charge_back_amount !== '' ? Number(t.charge_back_amount) : NaN
  if (!Number.isNaN(adv) && adv !== 0) return Math.round(adv * 100) / 100
  if (!Number.isNaN(cb) && cb !== 0) return Math.round(cb * 100) / 100
  return null
}

/** Compare payload to commission_tracker (historical imports + other uploads). Skips rows from the same file (source_file_id) and same source row. */
export async function findTrackerCommissionDuplicates(
  agencyCarrierId: string,
  rows: CommissionDisplayRow[],
  carrierCode: string,
  fileStatementDate: string,
  currentFileId?: string | null
): Promise<CommissionDuplicateIssue[]> {
  const policies = [
    ...new Set(rows.map((r) => normalizePolicyNumber(r.policy_number)).filter(Boolean)),
  ]
  if (!policies.length) return []

  const { data, error } = await supabase
    .from('commission_tracker')
    .select('policy_number, date, advance_amount, charge_back_amount, source_table, source_row_id, source_file_id')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policies)

  if (error || !data?.length) return []

  type TRow = (typeof data)[number]
  const trackerByKey: { key: string; t: TRow }[] = []
  for (const t of data as TRow[]) {
    if (currentFileId && String(t.source_file_id ?? '') === String(currentFileId)) continue
    const policy = normalizePolicyNumber(t.policy_number as string)
    const dateYmd = normalizeTrackerDate(t.date)
    if (!policy || !dateYmd) continue
    const amt = netAmountFromTrackerRow(t)
    if (amt == null) continue
    trackerByKey.push({ key: `${policy}|${dateYmd}|${amt.toFixed(2)}`, t })
  }

  const issues: CommissionDuplicateIssue[] = []
  const seen = new Set<string>()

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const key = buildCommissionDuplicateKey(row, carrierCode, fileStatementDate)
    if (!key) continue
    const rowId = row.id

    for (const { key: tk, t } of trackerByKey) {
      if (tk !== key) continue
      if (rowId && String(t.source_row_id ?? '') === String(rowId)) {
        continue
      }
      const dedupe = `${key}|${t.source_table ?? ''}|${t.source_row_id ?? ''}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const amt = netCommissionAmountForDupes(row)!
      const src = (t.source_table || 'commission_tracker').replace(/_/g, ' ')
      issues.push({
        kind: 'existing_record',
        summary: `Row ${i + 1} matches an existing commission in the tracker (${src}). You can remove or edit duplicates, or save anyway if intentional.`,
        policy_number: normalizePolicyNumber(row.policy_number),
        date: resolveRowDateYmdForDupes(row, carrierCode, fileStatementDate),
        amountDisplay: amt < 0 ? `Charge back ${amt.toFixed(2)}` : `Advance ${amt.toFixed(2)}`,
      })
    }
  }

  return issues
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
  // For Corebridge, we intentionally do NOT take the name from the
  // commission file. We always prefer the policy/deal_tracker name so
  // commissions only influence deal value, cc value and status.
  let name =
    carrierCode === 'COREBRIDGE'
      ? ''
      : row.client ??
        row.client_name ??
        row.insured_name ??
        row.insureds_name ??
        row.INSURED_NAME ??
        row['Name'] ??
        ''
  let salesAgent =
    row.writingagentname ??
    row.writingagent ??
    row.writing_agent_name ??
    row.paid_producer ??
    row['Sales Agent'] ??
    ''
  const policyNumber = String(row.policy_number ?? '')
  const dt = dealTrackerMap?.get(policyNumber)
  if (dt) {
    if (!name?.toString().trim()) name = dt.name ?? ''
    const useDtSalesAgent =
      !salesAgent?.toString().trim() ||
      (carrierCode === 'AMAM' && looksLikeNumberOnly(salesAgent) && dt.sales_agent?.toString().trim()) ||
      (carrierCode === 'MOH' && looksLikeNumberOnly(salesAgent) && dt.sales_agent?.toString().trim())
    if (useDtSalesAgent && dt.sales_agent?.toString().trim()) salesAgent = dt.sales_agent
  }
  const dateRaw =
    row.commissionpaiddate ??
    row.statement_date ??
    row.commission_period_end ??
    row.activity_date ??
    row.issue_date ??
    row.effectivedate ??
    row.appdate ??
    row['Date'] ??
    ''
  const rate =
    row.rate_pct ??
    row.commission_rate_pct ??
    row.com_rate ??
    row.adv_rate ??
    row.comm_pct ??
    row['Commission Rate'] ??
    ''
  const rawAdvanceVal =
    carrierCode === 'SENTINEL'
      ? (row.payable_commission ?? row.applied_to_advance ?? row['Advance'])
      : carrierCode === 'COREBRIDGE'
        ? (row.commission_amount ?? row.commissionamount ?? row.advance ?? row['Advance'])
        : carrierCode === 'TRANSAMERICA'
          ? (row.comm_amount ?? row.commissionamount ?? row.advance ?? row['Advance'])
          : (row.commissionamount ?? row.advance ?? row.comm_amt ?? row.adv_comm ?? row['Advance'])
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
  const carrierLabel =
    carrierCode === 'AMAM'
      ? 'AMAM'
      : carrierCode === 'MOH'
        ? 'MOH'
        : carrierCode === 'AHL'
          ? 'AHL'
          : carrierCode === 'SENTINEL'
            ? 'Sentinel'
            : carrierCode === 'AFLAC'
              ? 'Aflac'
              : carrierCode === 'COREBRIDGE'
                ? 'Corebridge'
                : carrierCode === 'TRANSAMERICA'
                  ? 'Transamerica'
                  : 'Aetna'
  const effectiveCarrierLabel = carrierLabel
  return {
    id: row.id,
    name: String(name ?? ''),
    date: toYmdForDateInput(dateRaw),
    policy_number: policyNumber,
    carrier: row.__carrier ?? effectiveCarrierLabel,
    sales_agent: String(salesAgent ?? ''),
    commission_rate: rate != null && rate !== '' ? String(rate) : '',
    advance,
    charge_back: String(chargeBack ?? ''),
    _raw: row,
  }
}

/**
 * Group commission rows by (policy_number, date) and collapse each group into a single row
 * whose advance / charge_back are the sum of all source lines that share that policy AND
 * statement/paid date. Other fields take the first non-empty value across the group.
 *
 * Why per (policy, date) and not per policy alone: a policy can receive several commission
 * payments over time (initial advance, renewal, adjustment) on different statement dates.
 * Each date is its own transaction in commission_tracker — collapsing across dates would
 * lose the period information. Multiple lines on the SAME date for the same policy (split
 * across products / commission categories in one statement run) still merge into one row.
 *
 * Source-row ids are dropped on merged rows so the deferred-write save path
 * (delete-then-insert by file_id) handles them as fresh.
 */
export function mergeCommissionRowsByPolicy(rows: CommissionDisplayRow[]): CommissionDisplayRow[] {
  const normalizeDateKey = (raw: string | undefined | null): string => {
    if (!raw) return ''
    const s = String(raw).trim()
    if (!s) return ''
    const ymd = s.match(/^(\d{4}-\d{2}-\d{2})/)
    if (ymd) return ymd[1]
    const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})/)
    if (us) {
      const yyyy = us[3].length === 2 ? '20' + us[3] : us[3]
      const mm = String(parseInt(us[1], 10)).padStart(2, '0')
      const dd = String(parseInt(us[2], 10)).padStart(2, '0')
      return `${yyyy}-${mm}-${dd}`
    }
    return s.slice(0, 10)
  }

  const groups = new Map<string, CommissionDisplayRow[]>()
  const order: string[] = []
  for (const row of rows) {
    const policy = String(row.policy_number ?? '').trim()
    const dateKey = normalizeDateKey(row.date)
    // Rows with no policy or no date stay un-merged (give each one a unique key) so we
    // never silently fold them into another policy's group.
    const groupable = !!policy && !!dateKey
    const key = groupable
      ? `${policy}__${dateKey}`
      : `__solo_${order.length}`
    if (!groups.has(key)) {
      groups.set(key, [])
      order.push(key)
    }
    groups.get(key)!.push(row)
  }

  const sumStr = (values: string[]): string => {
    let total = 0
    let any = false
    for (const v of values) {
      if (v == null || String(v).trim() === '') continue
      const n = parseFloat(String(v).replace(/,/g, ''))
      if (Number.isNaN(n)) continue
      total += n
      any = true
    }
    if (!any) return ''
    return Number.isInteger(total) ? String(total) : total.toFixed(2)
  }

  const firstNonEmpty = (values: (string | undefined | null)[]): string => {
    for (const v of values) {
      if (v != null && String(v).trim() !== '') return String(v)
    }
    return ''
  }

  return order.map((key) => {
    const group = groups.get(key)!
    if (group.length === 1) return group[0]
    const advances: string[] = []
    const chargebacks: string[] = []
    for (const r of group) {
      if (r.advance && r.advance.trim()) advances.push(r.advance)
      if (r.charge_back && r.charge_back.trim()) chargebacks.push(r.charge_back)
    }
    let mergedAdvance = sumStr(advances)
    let mergedChargeBack = sumStr(chargebacks)
    // If the net advance turns negative (e.g. one row is +100 and another is -150 entered as
    // positive in the advance column), flip it to charge_back to match the file-import convention.
    const advNum = mergedAdvance ? parseFloat(mergedAdvance) : NaN
    if (!Number.isNaN(advNum) && advNum < 0) {
      mergedChargeBack = sumStr([mergedChargeBack, String(advNum)])
      mergedAdvance = ''
    }
    const base = group[0]
    return {
      // Drop id on merged rows so save uses the deferred path (delete + insert) and keeps
      // the carrier-specific table in sync with the merged view.
      id: undefined,
      name: firstNonEmpty(group.map(r => r.name)),
      date: firstNonEmpty(group.map(r => r.date)),
      policy_number: base.policy_number,
      carrier: base.carrier,
      sales_agent: firstNonEmpty(group.map(r => r.sales_agent)),
      commission_rate: firstNonEmpty(group.map(r => r.commission_rate)),
      advance: mergedAdvance,
      charge_back: mergedChargeBack,
      _raw: base._raw,
    }
  })
}

function displayToDbRow(
  display: CommissionDisplayRow,
  carrierCode: string,
  agencyCarrierId: string,
  fileId: string,
  dealTrackerRow?: DealTrackerRow | null
): Record<string, unknown> {
  const raw = (display._raw || {}) as Record<string, unknown>
  let name = display.name || (raw.client as string) || (raw.insured_name as string) || (raw.insureds_name as string)
  let salesAgent = display.sales_agent || (raw.writingagentname as string) || (raw.writingagent as string) || (raw.paid_producer as string)
  if (dealTrackerRow) {
    if (!name?.toString().trim() && dealTrackerRow.name?.toString().trim()) name = dealTrackerRow.name
    const useDtSalesAgent =
      !salesAgent?.toString().trim() ||
      (carrierCode === 'AMAM' && looksLikeNumberOnly(salesAgent) && dealTrackerRow.sales_agent?.toString().trim()) ||
      (carrierCode === 'MOH' && looksLikeNumberOnly(salesAgent) && dealTrackerRow.sales_agent?.toString().trim())
    if (useDtSalesAgent && dealTrackerRow.sales_agent?.toString().trim()) salesAgent = dealTrackerRow.sales_agent
  }
  const base = {
    ...raw,
    agency_carrier_id: agencyCarrierId,
    file_id: fileId,
    policy_number: display.policy_number || (raw.policy_number as string),
  } as Record<string, unknown>

  if (carrierCode === 'AETNA' || carrierCode === 'AFLAC' || carrierCode === 'AHL') {
    base.client = name
    base.writingagentname = salesAgent
    base.rate_pct = display.commission_rate || (raw.rate_pct as string)
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    if (!Number.isNaN(advNum) && advNum > 0) {
      base.commissionamount = advNum
    } else {
      base.commissionamount = raw.commissionamount as number
    }
    if (display.date) base.commissionpaiddate = display.date
  } else if (carrierCode === 'SENTINEL') {
    base.client_name = name
    base.writing_agent_name = salesAgent
    if (display.commission_rate != null && display.commission_rate !== '') {
      const rateNum = parseFloat(String(display.commission_rate).replace(/,/g, ''))
      if (!Number.isNaN(rateNum)) base.commission_rate_pct = rateNum
    }
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    const cbNum = display.charge_back ? parseFloat(String(display.charge_back).replace(/,/g, '')) : NaN
    if (!Number.isNaN(advNum) && advNum > 0) {
      base.payable_commission = advNum
    } else if (!Number.isNaN(cbNum) && cbNum < 0) {
      base.payable_commission = cbNum
    } else {
      base.payable_commission = raw.payable_commission as number
    }
    if (display.date) base.statement_date = display.date
  } else if (carrierCode === 'MOH') {
    base.insureds_name = name
    // Do not overwrite MOH sales agent here; it is already maintained from the policy upload.
    if (display.commission_rate != null && display.commission_rate !== '') {
      const rateNum = parseFloat(String(display.commission_rate).replace(/,/g, ''))
      if (!Number.isNaN(rateNum)) base.comm_pct = rateNum
    }
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    const cbNum = display.charge_back ? parseFloat(String(display.charge_back).replace(/,/g, '')) : NaN
    if (!Number.isNaN(advNum) && advNum > 0) {
      base.comm_amt = advNum
    } else if (!Number.isNaN(cbNum) && cbNum < 0) {
      base.comm_amt = cbNum
    } else {
      base.comm_amt = (raw.comm_amt as number) ?? (raw.adv_comm as number)
    }
    if (display.date) base.activity_date = display.date
  } else if (carrierCode === 'COREBRIDGE') {
    base.insured_name = name
    base.agent_code = salesAgent
    if (display.commission_rate != null && display.commission_rate !== '') {
      const rateNum = parseFloat(String(display.commission_rate).replace(/,/g, ''))
      if (!Number.isNaN(rateNum)) base.commission_rate = rateNum
    }
    // For Corebridge: "Advance" field in dialog maps to commission_amount (COMM ACTIVITY).
    // Keep advance_balance as parsed OUTSTANDING ADV BALANCE from the PDF unless user edits raw.
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    const cbNum = display.charge_back ? parseFloat(String(display.charge_back).replace(/,/g, '')) : NaN
    if (!Number.isNaN(advNum) && advNum > 0) base.commission_amount = advNum
    else if (!Number.isNaN(cbNum) && cbNum < 0) base.commission_amount = cbNum
    if (display.date) base.statement_date = display.date
  } else if (carrierCode === 'TRANSAMERICA') {
    base.insured_name = name
    base.writing_agent_name = salesAgent
    if (display.commission_rate != null && display.commission_rate !== '') {
      const rateNum = parseFloat(String(display.commission_rate).replace(/,/g, ''))
      if (!Number.isNaN(rateNum)) base.comm_pct = rateNum
    }
    const advNum = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : NaN
    const cbNum = display.charge_back ? parseFloat(String(display.charge_back).replace(/,/g, '')) : NaN
    if (!Number.isNaN(advNum) && advNum > 0) base.comm_amount = advNum
    else if (!Number.isNaN(cbNum) && cbNum < 0) base.comm_amount = cbNum
    if (display.date) {
      base.statement_date = display.date
      base.paid_date = display.date
      base.commissionpaiddate = display.date
    }
  } else {
    base.insured_name = name
    base.writingagent = salesAgent
    base.com_rate = display.commission_rate ? parseFloat(String(display.commission_rate).replace(/,/g, '')) : (raw.com_rate as number)
    base.advance = display.advance ? parseFloat(String(display.advance).replace(/,/g, '')) : (raw.advance as number)
    if (display.date) base.statement_date = display.date
  }
  return base
}

export type OpenCommissionReportOptions = {
  /**
   * When true (default), closing the dialog without a successful Save removes
   * all commission rows for this file from the carrier table and commission_tracker.
   * For deferred uploads (e.g. AMAM commission), nothing is in the DB until Save, so abandon is a no-op.
   */
  deleteOnAbandon?: boolean
  /**
   * Parsed commission rows not yet written to the carrier table (deferred upload).
   * When set, the dialog loads from this payload instead of querying the database.
   */
  pendingRows?: Record<string, unknown>[]
}

function commissionTableForCarrier(carrierCode: string): string | null {
  const c = (carrierCode || '').toUpperCase()
  if (c === 'AMAM') return 'amam_commissions'
  if (c === 'MOH') return 'moh_commissions'
  if (c === 'COREBRIDGE') return 'corebridge_commissions'
  if (c === 'AFLAC') return 'aflac_commissions'
  if (c === 'AETNA') return 'aetna_commissions'
  if (c === 'SENTINEL') return 'sentinel_commissions'
  if (c === 'AHL') return 'ahl_commissions'
  if (c === 'TRANSAMERICA') return 'transamerica_commissions'
  return null
}

/** Remove parsed commission rows + tracker mirror for this upload when user abandons the review dialog. */
export async function rollbackCommissionFileSession(ctx: {
  agencyCarrierId: string
  fileId: string
  carrierCode: string
}): Promise<void> {
  const table = commissionTableForCarrier(ctx.carrierCode)
  if (!table) return

  const { data: rowList, error: selErr } = await supabase
    .from(table)
    .select('id')
    .eq('agency_carrier_id', ctx.agencyCarrierId)
    .eq('file_id', ctx.fileId)

  if (selErr) {
    console.error('[Commission Report] Rollback: failed to list rows:', selErr)
    return
  }

  const ids = (rowList || []).map((r: { id: string }) => r.id).filter(Boolean)
  if (ids.length) {
    const { error: trErr } = await supabase
      .from('commission_tracker')
      .delete()
      .eq('source_table', table)
      .in('source_row_id', ids)
    if (trErr) {
      console.error('[Commission Report] Rollback: commission_tracker delete failed:', trErr)
    }
  }

  const { error: delErr } = await supabase
    .from(table)
    .delete()
    .eq('agency_carrier_id', ctx.agencyCarrierId)
    .eq('file_id', ctx.fileId)

  if (delErr) {
    console.error('[Commission Report] Rollback: commission table delete failed:', delErr)
  }
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

  const contextRef = useRef(context)
  contextRef.current = context

  const closedAfterSaveRef = useRef(false)
  const deleteCommissionRowsOnAbandonRef = useRef(true)

  const handleCommissionReportOpenChange = useCallback((open: boolean) => {
    if (open) {
      setShowCommissionReport(true)
      return
    }
    setShowCommissionReport(false)
    if (closedAfterSaveRef.current) {
      closedAfterSaveRef.current = false
      deleteCommissionRowsOnAbandonRef.current = true
      setCommissionRows([])
      setContext(null)
      return
    }
    const ctxSnapshot = contextRef.current
    const shouldDelete = deleteCommissionRowsOnAbandonRef.current
    setCommissionRows([])
    setContext(null)
    deleteCommissionRowsOnAbandonRef.current = true
    if (shouldDelete && ctxSnapshot) {
      void rollbackCommissionFileSession(ctxSnapshot).catch((err) =>
        console.error('[Commission Report] Abandon rollback failed:', err)
      )
    }
  }, [])

  const openCommissionReport = useCallback(
    async (
      agencyCarrierId: string,
      fileId: string,
      carrierCode: string,
      openOpts?: OpenCommissionReportOptions
    ) => {
      if (
        carrierCode !== 'AETNA' &&
        carrierCode !== 'AMAM' &&
        carrierCode !== 'MOH' &&
        carrierCode !== 'COREBRIDGE' &&
        carrierCode !== 'AFLAC' &&
        carrierCode !== 'SENTINEL' &&
        carrierCode !== 'AHL' &&
        carrierCode !== 'TRANSAMERICA'
      )
        return
      deleteCommissionRowsOnAbandonRef.current = openOpts?.deleteOnAbandon !== false
      closedAfterSaveRef.current = false
      setContext({ agencyCarrierId, fileId, carrierCode })
      setLoading(true)
      setShowCommissionReport(true)
      setCommissionRows([])
      try {
        const table = commissionTableForCarrier(carrierCode)
        if (!table) {
          setCommissionRows([])
          return
        }
        const pending = openOpts?.pendingRows
        if (pending && pending.length > 0) {
          const policyNumbers = pending
            .map((r) => String((r as Record<string, unknown>).policy_number ?? '').trim())
            .filter(Boolean)
          const dealTrackerMap = await fetchDealTrackerByPolicies(agencyCarrierId, policyNumbers)
          const rows = pending.map((r) =>
            dbRowToDisplay(r as Record<string, any>, carrierCode, dealTrackerMap)
          )
          setCommissionRows(mergeCommissionRowsByPolicy(rows))
          return
        }

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
        setCommissionRows(mergeCommissionRowsByPolicy(rows))
      } finally {
        setLoading(false)
      }
    },
    []
  )

  const saveCommissionReport = useCallback(
    async (editedRows: CommissionDisplayRow[]) => {
      if (!context || editedRows.length === 0) return
      const validationError = validateCommissionRowsForSave(editedRows)
      if (validationError) {
        throw new Error(validationError)
      }
      const { agencyCarrierId, fileId, carrierCode } = context
      const table = commissionTableForCarrier(carrierCode)
      if (!table) return
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
          delete (r as any).created_at
          return r
        })
        const hasStableIds = editedRows.some((r) => !!r.id)
        if (!hasStableIds) {
          // Deferred flow (rows came from pendingRows): make save idempotent by replacing
          // this file's commission rows before insert so double-clicks/retries do not duplicate.
          const { error: delErr } = await supabase
            .from(table)
            .delete()
            .eq('agency_carrier_id', agencyCarrierId)
            .eq('file_id', fileId)
          if (delErr) throw delErr

          const { error: insErr } = await supabase
            .from(table)
            .insert(chunk)
          if (insErr) throw insErr
        } else {
          const upsertOptions = { onConflict: 'id', ignoreDuplicates: false }
          const { error } = await supabase
            .from(table)
            .upsert(chunk, upsertOptions)
          if (error) throw error
        }
        await syncCommissionTrackerForAgencyCarrier(agencyCarrierId, carrierCode, {
          fileId,
          replacePoliciesFromFile: true,
        })
        closedAfterSaveRef.current = true
        deleteCommissionRowsOnAbandonRef.current = false
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
    handleCommissionReportOpenChange(false)
  }, [handleCommissionReportOpenChange])

  /**
   * After saving deal tracker only (and rolling back this file's commission rows externally),
   * close the dialog without running abandon rollback again.
   */
  const closeAfterDealTrackerOnly = useCallback(() => {
    deleteCommissionRowsOnAbandonRef.current = false
    closedAfterSaveRef.current = false
    setShowCommissionReport(false)
    setCommissionRows([])
    setContext(null)
  }, [])

  return {
    showCommissionReport,
    /** Use this for Dialog onOpenChange so closing (X / overlay / Cancel) rolls back unpersisted upload data when appropriate. */
    handleCommissionReportOpenChange,
    commissionRows,
    setCommissionRows,
    loading,
    saving,
    /** Alias for upload flows that attach agency + file to the commission tracker dialog. */
    reportContext: context,
    openCommissionReport,
    saveCommissionReport,
    cancelCommissionReport,
    closeAfterDealTrackerOnly,
  }
}
