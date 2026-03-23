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
  // Support values like '2025-12-07', '2025/12/07', or '2025-12-07 to 2026-01-20'
  const rangePart = str.split('to')[0].trim()
  const parsed = new Date(
    rangePart
      .replace(/\./g, '-')
      .replace(/\//g, '-')
  )
  if (isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

function toNumberOrNull(v: any): number | null {
  if (v == null || v === '') return null
  const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
  return isNaN(num) ? null : num
}

/**
 * Build CommissionTrackerRow entries from a carrier-specific commissions table.
 * This mirrors the logic in app/commission-report/page.tsx so the report and
 * normalized table stay consistent.
 */
function buildCommissionRowsFromSource(
  sourceTable: 'amam_commissions' | 'aetna_commissions' | 'ahl_commissions',
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
      null

    const dateRaw =
      row['Date'] ??
      row['date'] ??
      row['PAID_TO_DATE'] ??
      row['paid_to_date'] ??
      row['commissionpaiddate'] ??
      row['statement_date'] ??
      row['appdate'] ??
      row['effectivedate'] ??
      null
    const normalizedDate = normalizeDate(dateRaw)
    if (!normalizedDate) continue

    const commissionRate =
      row['Commission Rate'] ??
      row['commission_rate'] ??
      row['RATE'] ??
      row['rate'] ??
      row['com_rate'] ?? // AMAM
      row['rate_pct'] ?? // Aetna
      null

    let advance =
      row['Advance'] ??
      row['advance'] ??
      row['ADVANCE'] ??
      ((sourceTable === 'aetna_commissions' || sourceTable === 'ahl_commissions') ? row['commissionamount'] : null) ??
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
      policy_number: String(policyNumber),
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

export async function syncCommissionTrackerForAgencyCarrier(
  agencyCarrierId: string,
  carrierCode: string,
): Promise<void> {
  const upperCode = (carrierCode || '').toUpperCase()
  const isAetna = upperCode === 'AETNA'
  const isAmam = upperCode === 'AMAM'
  const isCorebridge = upperCode === 'COREBRIDGE'
  const isAhl = upperCode === 'AHL'

  if (!isAetna && !isAmam && !isCorebridge && !isAhl) {
    // For now we only normalize AMAM + AETNA + AHL + COREBRIDGE into commission_tracker
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
    const { data: coreRows, error: coreError } = await supabase
      .from('corebridge_commissions')
      .select('id, policy_number, statement_date, commission_amount, comm_type, file_id')
      .eq('agency_carrier_id', agencyCarrierId)

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

    const BATCH_SIZE = 500
    for (let i = 0; i < trackerRows.length; i += BATCH_SIZE) {
      const batch = trackerRows.slice(i, i + BATCH_SIZE)
      const sourceRowIds = batch
        .map((r) => r.source_row_id)
        .filter((id): id is string => !!id)

      if (sourceRowIds.length) {
        const { error: deleteError } = await supabase
          .from('commission_tracker')
          .delete()
          .eq('source_table', 'corebridge_commissions')
          .in('source_row_id', sourceRowIds)

        if (deleteError) {
          console.error(
            '[CommissionTracker] Failed to delete existing Corebridge commission_tracker rows before insert:',
            deleteError.message,
          )
          break
        }
      }

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

  const sourceTable = isAetna ? 'aetna_commissions' : isAhl ? 'ahl_commissions' : 'amam_commissions'

  // Load all commissions for this agency_carrier (bounded)
  const { data: rawRows, error: rawError } = await supabase
    .from(sourceTable)
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .order('created_at', { ascending: false })
    .limit(5000)

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

  // Idempotent batches: delete existing rows for these source ids, then re-insert.
  const BATCH_SIZE = 500
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const sourceRowIds = batch
      .map((r) => r.source_row_id)
      .filter((id): id is string => !!id)

    if (sourceRowIds.length) {
      const { error: deleteError } = await supabase
        .from('commission_tracker')
        .delete()
        .eq('source_table', sourceTable)
        .in('source_row_id', sourceRowIds)

      if (deleteError) {
        console.error(
          '[CommissionTracker] Failed to delete existing commission_tracker rows before insert:',
          deleteError.message,
        )
        break
      }
    }

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
