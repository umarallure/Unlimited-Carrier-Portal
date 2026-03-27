/**
 * Import historical Commission Report CSV into commission_tracker.
 *
 * Source example:
 *   /Carrier/Policies and Commission Files/Commision_report_1772580492.csv
 *
 * Columns:
 *   Name,Date,Policy Number,Carrier,Sales Agent,Commission Rate,Advance,Charge Back
 *
 * Behavior:
 *   - Resolves carriers from the Supabase `carriers` table (by code/name).
 *   - Maps Sales Agent -> Agency Name (same mapping used elsewhere).
 *   - Resolves `agency_carrier_id` via (carrier_id, agency_name).
 *   - Upserts normalized rows into `commission_tracker`.
 *
 * Usage (from admin-dashboard folder):
 *   node scripts/import-commission-report-history-csv.js "../Policies and Commission Files/Commision_report_1772580492.csv"
 */

const { createClient } = require('@supabase/supabase-js')
const { randomUUID } = require('crypto')
const fs = require('fs')
const path = require('path')
const csv = require('csv-parse/sync')

require('dotenv').config({ path: path.join(__dirname, '../.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

// Same agent -> agency mapping used in other scripts (keys normalized to lowercase)
// values MUST exactly match agencies.name in Supabase
const SALES_AGENT_AGENCY = {
  // Heritage Insurance
  'abdul ibrahim': 'Heritage Insurance',
  'isaac reed': 'Heritage Insurance',
  'noah brock': 'Heritage Insurance',
  'trinity queen': 'Heritage Insurance',
  'erica hicks': 'Heritage Insurance',
  // Safe Harbor Insurance (handle spelling variants)
  'brandon flinchum': 'Safe Harbor Insurance',
  'brandom flinchum': 'Safe Harbor Insurance',
  // Unlimited Insurance
  'benjamin wunder': 'Unlimited Insurance',
  'caleb johnson': 'Unlimited Insurance',
  'claudia tradardi': 'Unlimited Insurance',
  'lydia sutton': 'Unlimited Insurance',
}

function toNull (v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function toNumberOrNull (v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  if (!s) return null
  const num = parseFloat(s.replace(/,/g, ''))
  return Number.isNaN(num) ? null : num
}

function normalizeDate (value) {
  if (!value) return null
  const str = String(value).trim()
  if (!str) return null
  // Support values like '2025-12-07', '2025/12/07'
  const parsed = new Date(
    str
      .replace(/\./g, '-')
      .replace(/\//g, '-')
  )
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10)
}

async function buildCarrierLookup (carrierStrings) {
  const lookup = new Map()
  if (!carrierStrings || carrierStrings.size === 0) return lookup

  console.log('Resolving carriers from Supabase for:', [...carrierStrings].join(', '))

  for (const raw of carrierStrings) {
    const label = (raw || '').trim()
    if (!label) continue
    const upper = label.toUpperCase()

    let data, error

    // Special-case alias ANAM -> AMAM / American Amicable
    if (upper === 'ANAM') {
      ({ data, error } = await supabase
        .from('carriers')
        .select('id, name, code')
        .or(
          [
            'code.eq.AMAM',
            'code.ilike.%AMAM%',
            'name.ilike.%American Amicable%',
          ].join(',')
        ))
    } else if (upper.startsWith('CHUB')) {
      // Handle "Chubb", "CHUBB", etc. as CHUB
      ({ data, error } = await supabase
        .from('carriers')
        .select('id, name, code')
        .or(
          [
            'code.eq.CHUB',
            'code.ilike.%CHUB%',
            'name.ilike.%Chub%',
          ].join(',')
        ))
    } else {
      ({ data, error } = await supabase
        .from('carriers')
        .select('id, name, code')
        .or(
          [
            `code.eq.${upper}`,
            `code.ilike.%${upper}%`,
            `name.ilike.%${label}%`,
          ].join(',')
        ))
    }

    if (error) {
      console.error(`Error resolving carrier "${label}":`, error.message)
      continue
    }

    if (!data || data.length === 0) {
      console.warn(`No carrier row found for CSV carrier "${label}". Those rows will be skipped.`)
      continue
    }

    if (data.length > 1) {
      console.warn(
        `Multiple carriers matched CSV carrier "${label}". Using the first match:`,
        data.map(c => `${c.name} (${c.code})`).join(' | ')
      )
    }

    const chosen = data[0]
    lookup.set(label, {
      carrierId: chosen.id,
      carrierName: chosen.name,
      carrierCode: chosen.code,
    })
  }

  return lookup
}

/**
 * Build a lookup (carrier_id, agency_name) -> agency_carrier_id
 */
async function buildAgencyCarrierByNameLookup (carrierLookup) {
  const byName = new Map()
  const byCarrierId = new Map()

  const carrierIds = [...new Set(
    [...carrierLookup.values()]
      .map(info => info.carrierId)
      .filter(Boolean)
  )]
  if (carrierIds.length === 0) return { byName, byCarrierId }

  const { data, error } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, agencies ( id, name )')
    .in('carrier_id', carrierIds)

  if (error) {
    console.error('Failed to fetch agency_carriers for carriers:', error.message)
    return { byName, byCarrierId }
  }

  for (const row of data || []) {
    const carrierId = row.carrier_id
    const agencyName = row.agencies?.name
    if (!carrierId || !agencyName) continue
    const key = `${carrierId}::${agencyName.toLowerCase()}`
    byName.set(key, row.id)
    // Remember a fallback agency_carrier_id per carrier in case
    // we can't map by Sales Agent (missing or unknown agent).
    if (!byCarrierId.has(carrierId)) {
      byCarrierId.set(carrierId, row.id)
    }
  }

  return { byName, byCarrierId }
}

function resolveAgencyCarrierIdForRow (row, carrierInfo, agencyCarrierByName, agencyCarrierFallbackByCarrierId) {
  const salesAgent = (row['Sales Agent'] || '').trim()
  const agentKey = salesAgent.toLowerCase()
  const agencyName = SALES_AGENT_AGENCY[agentKey]

  if (!agencyName) {
    // If we don't know which agency this agent belongs to (or agent is blank),
    // fall back to "some" agency_carrier for this carrier so the row is kept
    // in commission_tracker with an empty Sales Agent.
    const fallbackId = agencyCarrierFallbackByCarrierId.get(carrierInfo.carrierId)
    if (!fallbackId) {
      console.warn(
        `No agency mapping for Sales Agent "${salesAgent}" and no fallback agency_carrier for carrier "${carrierInfo.carrierName}". Row for policy "${row['Policy Number']}" will be skipped.`
      )
      return null
    }
    return fallbackId
  }

  const acKey = `${carrierInfo.carrierId}::${agencyName.toLowerCase()}`
  const agencyCarrierId = agencyCarrierByName.get(acKey)

  if (!agencyCarrierId) {
    console.warn(
      `No agency_carrier found for carrier "${carrierInfo.carrierName}" (${carrierInfo.carrierCode}) and agency "${agencyName}". Row for policy "${row['Policy Number']}" will be skipped.`
    )
    return null
  }

  return agencyCarrierId
}

async function main () {
  const csvPath = process.argv[2]
  if (!csvPath) {
    console.error('Usage: node scripts/import-commission-report-history-csv.js <path-to-csv>')
    process.exit(1)
  }

  const resolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath)
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved)
    process.exit(1)
  }

  console.log('Reading historical Commission Report CSV:', resolved)
  const csvContent = fs.readFileSync(resolved, 'utf-8')

  // Exports often start with 1–2 title rows ("Commision report", …) before the real header.
  // If columns: true uses line 1 as headers, row["Policy Number"] is always undefined and every row is skipped.
  const lines = csvContent.split(/\r?\n/)
  const headerIdx = lines.findIndex(
    (l) => /\bPolicy Number\b/i.test(l) && /\bCarrier\b/i.test(l) && /\bDate\b/i.test(l)
  )
  const csvBody = headerIdx >= 0 ? lines.slice(headerIdx).join('\n') : csvContent
  if (headerIdx > 0) {
    console.log(`Detected header at line ${headerIdx + 1} (skipped ${headerIdx} preamble row(s)).`)
  } else if (headerIdx < 0) {
    console.warn('Could not find a row with Policy Number + Carrier + Date; parsing from line 1.')
  }

  const records = csv.parse(csvBody, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })

  if (!records || records.length === 0) {
    console.error('No data rows in CSV.')
    process.exit(1)
  }

  console.log(`Parsed ${records.length} CSV rows.`)

  // Collect distinct carrier labels from CSV
  const carrierStrings = new Set(
    records
      .map(r => (r['Carrier'] || '').trim())
      .filter(Boolean)
  )

  const carrierLookup = await buildCarrierLookup(carrierStrings)
  const { byName: agencyCarrierByName, byCarrierId: agencyCarrierFallbackByCarrierId } =
    await buildAgencyCarrierByNameLookup(carrierLookup)

  const entries = []
  let skipped = 0

  for (const row of records) {
    const policyNumber = toNull(row['Policy Number'])
    const csvCarrier = (row['Carrier'] || '').trim()
    if (!policyNumber || !csvCarrier) {
      skipped++
      continue
    }

    const carrierInfo = carrierLookup.get(csvCarrier)
    if (!carrierInfo) {
      console.warn(`Skipping row for policy "${policyNumber}" because carrier "${csvCarrier}" could not be resolved in carriers table.`)
      skipped++
      continue
    }

    const agencyCarrierId = resolveAgencyCarrierIdForRow(
      row,
      carrierInfo,
      agencyCarrierByName,
      agencyCarrierFallbackByCarrierId
    )
    if (!agencyCarrierId) {
      skipped++
      continue
    }

    const name = toNull(row['Name'])
    const salesAgent = toNull(row['Sales Agent'])
    const date = normalizeDate(row['Date'])
    if (!date) {
      console.warn(`Skipping row for policy "${policyNumber}" because Date "${row['Date']}" is invalid.`)
      skipped++
      continue
    }

    const commissionRate = toNumberOrNull(row['Commission Rate'])
    const advance = toNumberOrNull(row['Advance'])
    const chargeBack = toNumberOrNull(row['Charge Back'])

    entries.push({
      agency_carrier_id: agencyCarrierId,
      carrier_id: carrierInfo.carrierId,
      carrier: carrierInfo.carrierName || csvCarrier,
      policy_number: policyNumber,
      name,
      sales_agent: salesAgent,
      date,
      commission_rate: commissionRate,
      advance_amount: advance,
      charge_back_amount: chargeBack,
      source_table: 'historical_commission_report',
      source_row_id: null,
      source_file_id: null,
    })
  }

  console.log(`Prepared ${entries.length} raw commission_tracker entries. Skipped ${skipped} rows.`)

  if (entries.length === 0) {
    console.error('No entries to insert. Aborting.')
    process.exit(1)
  }

  console.log('Upserting into commission_tracker (one row per CSV transaction)...')
  const BATCH_SIZE = 500
  let saved = 0
  let failed = 0

  // Process in chronological order so history views are ordered by date.
  entries.sort((a, b) => {
    const da = new Date(a.date || '1970-01-01').getTime()
    const db = new Date(b.date || '1970-01-01').getTime()
    return da - db
  })

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)

    // Ensure we never send an explicit null id (so NOT NULL is satisfied),
    // and avoid touching version_history from the script.
    const cleanedBatch = batch.map(row => {
      const copy = { ...row }
      // Always assign a fresh id; onConflict uses this id so that if we ever
      // re-import the same history rows with the same ids we update instead
      // of inserting duplicates.
      if (copy.id == null) copy.id = randomUUID()
      if (copy.version_history !== undefined) delete copy.version_history
      return copy
    })
    const { error } = await supabase
      .from('commission_tracker')
      .upsert(cleanedBatch, {
        // Use the primary key so that if we ever re-import the same history
        // rows (with the same ids) we update instead of duplicating.
        onConflict: 'id',
        ignoreDuplicates: false,
      })

    if (error) {
      console.error('Batch error:', error.message)
      failed += batch.length
    } else {
      saved += batch.length
      console.log('Saved', saved, '/', entries.length)
    }
  }

  console.log('Done. Saved:', saved, 'Failed:', failed)
  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

