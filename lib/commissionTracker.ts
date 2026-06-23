import { supabase } from './supabaseClient'

export interface CommissionTrackerRow {
  agency_carrier_id: string
  carrier_id: string | null
  carrier: string
  policy_number: string
  name: string | null
  sales_agent: string | null
  date: string // YYYY-MM-DD
  commission_rate: number | null
  advance_amount: number | null
  charge_back_amount: number | null
  source_table: string | null
  source_row_id: string | null
  source_file_id: string | null
}

function normalizeDate(value: any): string | null {
  if (!value) return null
  const str = String(value).trim()
  if (!str) return null
  // Calendar-safe normalization (no timezone conversion).
  // Prefer direct YYYY-MM-DD token if present.
  const rangePart = str.split('to')[0].trim()
  const ymd = rangePart.match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymd) return ymd[1]

  // Common US format from carrier rows/dialog: MM/DD/YYYY
  const us = rangePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|[\sT].*)?$/)
  if (us) {
    const mm = String(parseInt(us[1], 10)).padStart(2, '0')
    const dd = String(parseInt(us[2], 10)).padStart(2, '0')
    return `${us[3]}-${mm}-${dd}`
  }

  // Last fallback: parse date-like strings, but keep local calendar components.
  const parsed = new Date(rangePart.includes('T') ? rangePart : `${rangePart}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  const y = parsed.getFullYear()
  const m = String(parsed.getMonth() + 1).padStart(2, '0')
  const d = String(parsed.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function toNumberOrNull(v: any): number | null {
  if (v == null || v === '') return null
  const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
  return isNaN(num) ? null : num
}

function normalizePolicyNumber(value: any): string {
  return String(value ?? '').trim()
}

function dateRawForSourceRow(sourceTable: string, row: any): unknown {
  // Canonical date field per carrier table (set from Commission dialog header date):
  // - amam_commissions       -> statement_date
  // - aetna_commissions      -> commissionpaiddate
  // - ahl_commissions        -> commissionpaiddate
  // - moh_commissions        -> activity_date
  // - corebridge_commissions -> statement_date
  //
  // We keep broad fallbacks only when canonical fields are actually missing.
  if (sourceTable === 'moh_commissions') {
    return (
      row['activity_date'] ??
      row['paid_to_date'] ??
      row['issue_date'] ??
      row['statement_date'] ??
      row['commissionpaiddate'] ??
      row['Date'] ??
      row['date'] ??
      row['PAID_TO_DATE'] ??
      row['appdate'] ??
      row['effectivedate'] ??
      null
    )
  }

  if (sourceTable === 'amam_commissions') {
    return (
      row['statement_date'] ??
      row['commission_period_end'] ??
      row['commissionpaiddate'] ??
      row['activity_date'] ??
      row['Date'] ??
      row['date'] ??
      row['PAID_TO_DATE'] ??
      row['paid_to_date'] ??
      row['issue_date'] ??
      row['appdate'] ??
      row['effectivedate'] ??
      null
    )
  }

  if (sourceTable === 'aetna_commissions' || sourceTable === 'aflac_commissions' || sourceTable === 'ahl_commissions') {
    return (
      row['commissionpaiddate'] ??
      row['statement_date'] ??
      row['activity_date'] ??
      row['Date'] ??
      row['date'] ??
      row['PAID_TO_DATE'] ??
      row['paid_to_date'] ??
      row['issue_date'] ??
      row['appdate'] ??
      row['effectivedate'] ??
      null
    )
  }

  if (sourceTable === 'corebridge_commissions' || sourceTable === 'sentinel_commissions') {
    return (
      row['statement_date'] ??
      row['Date'] ??
      row['date'] ??
      null
    )
  }

  if (sourceTable === 'transamerica_commissions') {
    return (
      row['statement_date'] ??
      row['paid_date'] ??
      row['commissionpaiddate'] ??
      row['issue_date'] ??
      row['Date'] ??
      row['date'] ??
      null
    )
  }

  return (
    row['statement_date'] ??
    row['commissionpaiddate'] ??
    row['activity_date'] ??
    row['Date'] ??
    row['date'] ??
    null
  )
}

/**
 * Build CommissionTrackerRow entries from a carrier-specific commissions table.
 * This mirrors the logic in app/commission-report/page.tsx so the report and
 * normalized table stay consistent.
 */
function buildCommissionRowsFromSource(
  sourceTable:
    | 'amam_commissions'
    | 'aetna_commissions'
    | 'aflac_commissions'
    | 'ahl_commissions'
    | 'moh_commissions'
    | 'transamerica_commissions',
  rawRows: any[],
  agencyCarrierId: string,
  carrierId: string | null,
  carrierName: string,
): CommissionTrackerRow[] {
  const rows: CommissionTrackerRow[] = []

  for (const row of rawRows) {
    const policyNumber =
      row['Policy Number'] ??
      row['policy_number'] ??
      row['POLICY_NUMBER'] ??
      row['policy'] ??
      null
    if (!policyNumber) continue

    const name =
      row['Name'] ??
      row['name'] ??
      row['INSURED_NAME'] ??
      row['insured_name'] ??
      row['client'] ??
      null

    let salesAgent =
      row['Sales Agent'] ??
      row['sales_agent'] ??
      row['AGENT'] ??
      row['writingagentname'] ??
      row['writingagent'] ??
      row['writing_agent_name'] ?? // Transamerica
      row['paid_producer'] ??
      null

    // Always prefer the carrier table's canonical saved date field first.
    // This ensures the statement date selected in Commission Report dialog is
    // what gets normalized into commission_tracker.
    const dateRaw = dateRawForSourceRow(sourceTable, row)
    const normalizedDate = normalizeDate(dateRaw)
    if (!normalizedDate) continue

    const commissionRate =
      row['Commission Rate'] ??
      row['commission_rate'] ??
      row['RATE'] ??
      row['rate'] ??
      row['com_rate'] ?? // AMAM
      row['rate_pct'] ?? // Aetna
      row['comm_pct'] ?? // MOH / Transamerica
      null

    let advance =
      row['Advance'] ??
      row['advance'] ??
      row['ADVANCE'] ??
      ((
        sourceTable === 'aetna_commissions' ||
        sourceTable === 'aflac_commissions' ||
        sourceTable === 'ahl_commissions'
      ) ? row['commissionamount'] : null) ??
      (sourceTable === 'moh_commissions' ? row['comm_amt'] : null) ??
      (sourceTable === 'transamerica_commissions' ? row['comm_amount'] : null) ??
      null

    let chargeBack: number | null = null

    const parsedAdvance =
      advance != null && advance !== ''
        ? parseFloat(String(advance).replace(/,/g, ''))
        : NaN
    if (!Number.isNaN(parsedAdvance) && parsedAdvance < 0) {
      // Negative advance is a chargeback
      chargeBack = parsedAdvance
      advance = ''
    }

    rows.push({
      agency_carrier_id: agencyCarrierId,
      carrier_id: carrierId,
      carrier: carrierName,
      policy_number: normalizePolicyNumber(policyNumber),
      name: name != null ? String(name) : null,
      sales_agent: salesAgent != null ? String(salesAgent) : null,
      date: normalizedDate,
      commission_rate: toNumberOrNull(commissionRate),
      advance_amount: toNumberOrNull(advance),
      charge_back_amount: chargeBack,
      source_table: sourceTable,
      source_row_id: row.id ?? null,
      source_file_id: (row.file_id as string | null) ?? null,
    })
  }

  return rows
}

/**
 * Re-sync commission_tracker for one uploaded file only.
 * Never deletes rows from other files — other statement dates/amounts stay intact.
 */
function buildCommissionTrackerWipeQueryForFile(
  agencyCarrierId: string,
  sourceTable: string,
  fileId: string,
) {
  return supabase
    .from('commission_tracker')
    .delete()
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('source_table', sourceTable)
    .eq('source_file_id', fileId)
}

export async function syncCommissionTrackerForAgencyCarrier(
  agencyCarrierId: string,
  carrierCode: string,
  options?: {
    /** Limit normalization to a single uploaded file. */
    fileId?: string | null
    /**
     * When syncing a specific file from Commission Report Save, replace only that file's
     * tracker rows (matched by source_file_id). Other statement files for the same policy
     * are left intact.
     */
    replacePoliciesFromFile?: boolean
  },
): Promise<void> {
  const upperCode = (carrierCode || '').toUpperCase()
  const isAetna = upperCode === 'AETNA'
  const isAmam = upperCode === 'AMAM'
  const isAflac = upperCode === 'AFLAC'
  const isCorebridge = upperCode === 'COREBRIDGE'
  const isAhl = upperCode === 'AHL'
  const isMoh = upperCode === 'MOH'
  const isSentinel = upperCode === 'SENTINEL'
  const isTransamerica = upperCode === 'TRANSAMERICA'

  if (!isAetna && !isAmam && !isAflac && !isCorebridge && !isAhl && !isMoh && !isSentinel && !isTransamerica) {
    return
  }

  // Fetch agency_carrier + carrier info
  const { data: acRow, error: acError } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, carriers ( id, name, code )')
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !acRow) {
    console.warn(
      '[CommissionTracker] Failed to load agency_carrier for',
      agencyCarrierId,
      acError?.message,
    )
    return
  }

  // Supabase returns related rows as an array; pick the first carrier if present.
  const carriers = acRow.carriers as { id: string; name: string; code: string }[] | null
  const carrier = carriers && carriers.length > 0 ? carriers[0] : null
  const carrierId = carrier?.id ?? acRow.carrier_id ?? null
  const carrierName = carrier?.name ?? carrierCode

  if (isCorebridge) {
    // Corebridge commissions currently come from PDF. Each row in
    // corebridge_commissions is a single commission/chargeback
    // transaction, so we normalize into commission_tracker with one
    // row per source row and key off (source_table, source_row_id).
    let coreQuery = supabase
      .from('corebridge_commissions')
      .select('id, policy_number, statement_date, commission_amount, comm_type, file_id')
      .eq('agency_carrier_id', agencyCarrierId)
    if (options?.fileId) {
      coreQuery = coreQuery.eq('file_id', options.fileId)
    }
    const { data: coreRows, error: coreError } = await coreQuery

    if (coreError || !coreRows || coreRows.length === 0) {
      if (coreError) {
        console.warn(
          '[CommissionTracker] Failed to fetch corebridge_commissions rows for',
          agencyCarrierId,
          coreError.message,
        )
      }
      return
    }

    const trackerRows: CommissionTrackerRow[] = []

    for (const r of coreRows as any[]) {
      if (!r.policy_number) continue

      const policyNumber = String(r.policy_number)
      const normalizedDate = normalizeDate(r.statement_date)
      if (!normalizedDate) continue

      const amtRaw =
        r.commission_amount != null
          ? (typeof r.commission_amount === 'number'
              ? r.commission_amount
              : parseFloat(String(r.commission_amount).replace(/,/g, '')))
          : 0
      if (Number.isNaN(amtRaw)) continue

      let advanceAmount: number | null = null
      let chargeBackAmount: number | null = null

      if (amtRaw < 0) {
        chargeBackAmount = amtRaw
      } else if (amtRaw > 0) {
        advanceAmount = amtRaw
      }

      trackerRows.push({
        agency_carrier_id: agencyCarrierId,
        carrier_id: carrierId,
        carrier: carrierName,
        policy_number: policyNumber,
        name: null,
        sales_agent: null,
        date: normalizedDate,
        commission_rate: null,
        advance_amount: advanceAmount,
        charge_back_amount: chargeBackAmount,
        source_table: 'corebridge_commissions',
        source_row_id: r.id ? String(r.id) : null,
        source_file_id: (r.file_id as string | null) ?? null,
      })
    }

    if (!trackerRows.length) return

    if (!options?.fileId) {
      console.warn('[CommissionTracker] Skipping Corebridge sync: fileId is required')
      return
    }

    const { error: wipeError } = await buildCommissionTrackerWipeQueryForFile(
      agencyCarrierId,
      'corebridge_commissions',
      options.fileId,
    )
    if (wipeError) {
      console.error(
        '[CommissionTracker] Failed to wipe existing Corebridge commission_tracker rows before insert:',
        wipeError.message,
      )
      return
    }

    const BATCH_SIZE = 500
    for (let i = 0; i < trackerRows.length; i += BATCH_SIZE) {
      const batch = trackerRows.slice(i, i + BATCH_SIZE)
      const { error } = await supabase.from('commission_tracker').insert(batch)
      if (error) {
        console.error(
          '[CommissionTracker] Failed to insert Corebridge commission_tracker batch:',
          error.message,
        )
        break
      }
    }

    return
  }

  if (isSentinel) {
    let sentinelQuery = supabase
      .from('sentinel_commissions')
      .select('id, policy_number, statement_date, payable_commission, commission_rate_pct, client_name, writing_agent_name, file_id')
      .eq('agency_carrier_id', agencyCarrierId)
    if (options?.fileId) {
      sentinelQuery = sentinelQuery.eq('file_id', options.fileId)
    }
    const { data: sentinelRows, error: sentinelError } = await sentinelQuery

    if (sentinelError || !sentinelRows || sentinelRows.length === 0) {
      if (sentinelError) {
        console.warn(
          '[CommissionTracker] Failed to fetch sentinel_commissions rows for',
          agencyCarrierId,
          sentinelError.message,
        )
      }
      return
    }

    const trackerRows: CommissionTrackerRow[] = []
    for (const r of sentinelRows as any[]) {
      if (!r.policy_number) continue
      const normalizedDate = normalizeDate(r.statement_date)
      if (!normalizedDate) continue

      const amtRaw =
        r.payable_commission != null
          ? (typeof r.payable_commission === 'number'
              ? r.payable_commission
              : parseFloat(String(r.payable_commission).replace(/,/g, '')))
          : 0
      if (Number.isNaN(amtRaw)) continue

      let advanceAmount: number | null = null
      let chargeBackAmount: number | null = null
      if (amtRaw < 0) chargeBackAmount = amtRaw
      else if (amtRaw > 0) advanceAmount = amtRaw

      trackerRows.push({
        agency_carrier_id: agencyCarrierId,
        carrier_id: carrierId,
        carrier: carrierName,
        policy_number: String(r.policy_number),
        name: r.client_name ? String(r.client_name) : null,
        sales_agent: r.writing_agent_name ? String(r.writing_agent_name) : null,
        date: normalizedDate,
        commission_rate: r.commission_rate_pct != null ? parseFloat(String(r.commission_rate_pct)) : null,
        advance_amount: advanceAmount,
        charge_back_amount: chargeBackAmount,
        source_table: 'sentinel_commissions',
        source_row_id: r.id ? String(r.id) : null,
        source_file_id: (r.file_id as string | null) ?? null,
      })
    }

    if (!trackerRows.length) return

    if (!options?.fileId) {
      console.warn('[CommissionTracker] Skipping Sentinel sync: fileId is required')
      return
    }

    const { error: sentinelWipeError } = await buildCommissionTrackerWipeQueryForFile(
      agencyCarrierId,
      'sentinel_commissions',
      options.fileId,
    )
    if (sentinelWipeError) {
      console.error(
        '[CommissionTracker] Failed to wipe existing Sentinel commission_tracker rows before insert:',
        sentinelWipeError.message,
      )
      return
    }

    const BATCH_SIZE = 500
    for (let i = 0; i < trackerRows.length; i += BATCH_SIZE) {
      const batch = trackerRows.slice(i, i + BATCH_SIZE)
      const { error } = await supabase.from('commission_tracker').insert(batch)
      if (error) {
        console.error(
          '[CommissionTracker] Failed to insert Sentinel commission_tracker batch:',
          error.message,
        )
        break
      }
    }

    return
  }

  const sourceTable = isAetna
    ? 'aetna_commissions'
    : isAflac
      ? 'aflac_commissions'
      : isAhl
        ? 'ahl_commissions'
        : isMoh
          ? 'moh_commissions'
          : isTransamerica
            ? 'transamerica_commissions'
            : 'amam_commissions'

  // Load commissions for this agency_carrier (optionally only the just-saved file).
  let sourceQuery = supabase
    .from(sourceTable)
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .order('created_at', { ascending: false })
    .limit(5000)
  if (options?.fileId) {
    sourceQuery = sourceQuery.eq('file_id', options.fileId)
  }
  const { data: rawRows, error: rawError } = await sourceQuery

  if (rawError || !rawRows || rawRows.length === 0) {
    if (rawError) {
      console.warn(
        '[CommissionTracker] Failed to fetch',
        sourceTable,
        'rows for',
        agencyCarrierId,
        rawError.message,
      )
    }
    return
  }

  // Build one normalized commission_tracker row per *source* commission
  // row so that every transaction is represented. We rely on
  // (source_table, source_row_id) for idempotent syncs.
  const rows = buildCommissionRowsFromSource(
    sourceTable,
    rawRows,
    agencyCarrierId,
    carrierId,
    carrierName,
  )

  if (!rows.length) return

  if (!options?.fileId) {
    console.warn('[CommissionTracker] Skipping sync for', sourceTable, ': fileId is required')
    return
  }

  const { error: wipeError } = await buildCommissionTrackerWipeQueryForFile(
    agencyCarrierId,
    sourceTable,
    options.fileId,
  )
  if (wipeError) {
    console.error(
      '[CommissionTracker] Failed to wipe existing commission_tracker rows before insert:',
      wipeError.message,
    )
    return
  }

  const BATCH_SIZE = 500
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase.from('commission_tracker').insert(batch)
    if (error) {
      console.error(
        '[CommissionTracker] Failed to insert commission_tracker batch:',
        error.message,
      )
      break
    }
  }
}
