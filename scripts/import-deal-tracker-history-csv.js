/**
 * Import historical Deal Tracker CSV (multi-carrier) into the deal_tracker table.
 *
 * This is meant for files like:
 *   /Carrier/Policies and Commission Files/Deal_Tracker_New_1772479020.csv
 *
 * Differences vs import-aetna-deals-csv.js:
 *   - Handles multiple carriers (CICA, Aetna, GTL, MOH, etc.).
 *   - Resolves carrier_id and agency_carrier_id by querying Supabase directly
 *     (no need to hard-code IDs in env).
 *   - Skips the first two metadata rows ("Deal Tracker New", "Pending / Submitted").
 *
 * Usage:
 *   node scripts/import-deal-tracker-history-csv.js <path-to-csv>
 */

const { createClient } = require('@supabase/supabase-js')
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

// Map Sales Agent -> Agency Name (normalized to lowercase key).
// values MUST exactly match agencies.name in Supabase.
// These agents work across multiple carriers; we always derive the agency
// from the agent name rather than arbitrarily picking the first agency_carrier.
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
  'Aidan Coleman': 'Safe Harbor Insurance',
  'aidan coleman': 'Safe Harbor Insurance',
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

function toNum (v) {
  if (v === undefined || v === null || String(v).trim() === '') return null
  const n = parseFloat(String(v).replace(/,/g, ''))
  return Number.isNaN(n) ? null : n
}

/** Normalize date to YYYY-MM-DD for DB date columns */
function toDate (v) {
  const s = toNull(v)
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return s
  return d.toISOString().slice(0, 10)
}

/**
 * Convert one CSV row (deal tracker layout) into a deal_tracker entry.
 * carrierId and agencyCarrierId are resolved per-carrier beforehand.
 */
function rowToEntry (row, agencyCarrierId, carrierId, carrierName) {
  const get = (csvKey) => {
    const v = row[csvKey]
    return v !== undefined ? v : null
  }

  const dealValue = toNum(get('Deal Value'))
  const ccValue = toNum(get('CC Value'))

  return {
    agency_carrier_id: agencyCarrierId,
    carrier_id: carrierId,
    name: toNull(get('Name')),
    tasks: toNull(get('Tasks')),
    ghl_name: toNull(get('GHL Name')),
    ghl_stage: toNull(get('GHL Stage')),
    policy_status: toNull(get('Policy Status')),
    deal_creation_date: toDate(get('Deal creation date')),
    policy_number: toNull(get('Policy Number')) || '',
    carrier: carrierName || (toNull(get('Carrier')) || ''),
    deal_value: dealValue,
    cc_value: ccValue,
    notes: toNull(get('Notes')),
    status: toNull(get('Status')),
    last_updated: new Date().toISOString(),
    sales_agent: toNull(get('Sales Agent')),
    writing_number: toNull(get('Writing #')),
    commission_type: toNull(get('Commission Type')),
    effective_date: toDate(get('Effective Date')),
    call_center: toNull(get('Call Center')),
    phone_number: toNull(get('Phone Number')),
    cc_pmt_ws: toNull(get('CC PMT WS')),
    cc_cb_ws: toNull(get('CC CB WS')),
    carrier_status: toNull(get('Carrier Status')),
    policy_type: toNull(get('Policy Type')),
  }
}

/**
 * Resolve carrier_id for each distinct CSV carrier string using the carriers table.
 * Returns a map: normalizedCsvCarrier -> { carrierId, carrierName, carrierCode }
 */
async function buildCarrierLookup (carrierStrings) {
  const lookup = new Map()
  if (!carrierStrings || carrierStrings.size === 0) return lookup

  console.log('Resolving carriers from Supabase for:', [...carrierStrings].join(', '))

  for (const raw of carrierStrings) {
    const label = (raw || '').trim()
    if (!label) continue
    const upper = label.toUpperCase()

    let data, error

    // Special-case known alias: ANAM should map to AMAM / American Amicable
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
      // Try first by exact code match, then by name ilike
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
 * Build a lookup from (carrier_id, agency_name) -> agency_carrier_id.
 * We DO NOT pick the "first" agency_carrier for a carrier; instead we always
 * map via the agent -> agency mapping above, and then resolve that agency
 * for the specific carrier.
 */
async function buildAgencyCarrierByNameLookup (carrierLookup) {
  const map = new Map() // key: `${carrierId}::${agencyNameLower}` -> agencyCarrierId

  const carrierIds = [...new Set(
    [...carrierLookup.values()]
      .map(info => info.carrierId)
      .filter(Boolean)
  )]

  if (carrierIds.length === 0) return map

  const { data, error } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, agencies ( id, name )')
    .in('carrier_id', carrierIds)

  if (error) {
    console.error('Failed to fetch agency_carriers for carriers:', error.message)
    return map
  }

  for (const row of data || []) {
    const carrierId = row.carrier_id
    const agencyName = row.agencies?.name
    if (!carrierId || !agencyName) continue
    const key = `${carrierId}::${agencyName.toLowerCase()}`
    map.set(key, row.id)
  }

  return map
}

function resolveAgencyCarrierIdForRow (row, carrierInfo, agencyCarrierByName) {
  const salesAgent = (row['Sales Agent'] || '').trim()
  const agentKey = salesAgent.toLowerCase()
  const agencyName = SALES_AGENT_AGENCY[agentKey]

  if (!agencyName) {
    console.warn(
      `No agency mapping for Sales Agent "${salesAgent}". Row for policy "${row['Policy Number']}" will be skipped.`
    )
    return null
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
    console.error('Usage: node scripts/import-deal-tracker-history-csv.js <path-to-csv>')
    process.exit(1)
  }

  const resolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath)
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved)
    process.exit(1)
  }

  console.log('Reading historical Deal Tracker CSV:', resolved)
  const csvContent = fs.readFileSync(resolved, 'utf-8')

  // The historical file has two "header" rows before the real column header:
  //   1) "Deal Tracker New,..."
  //   2) "Pending / Submitted,..."
  //
  // We strip the first two lines so that the third line becomes the header row
  // for csv-parse's `columns: true` option.
  const allLines = csvContent.split(/\r?\n/)
  const sliced = allLines.slice(2) // drop first two metadata lines
  const effectiveContent = sliced.join('\n')

  const records = csv.parse(effectiveContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })

  if (!records || records.length === 0) {
    console.error('No data rows in CSV.')
    process.exit(1)
  }

  // Filter out any rows that don't look like actual deals
  const dataRows = records.filter(row => {
    const policyNumber = (row['Policy Number'] || '').trim()
    const carrier = (row['Carrier'] || '').trim()
    // Require at least a policy number or a carrier string to treat as a deal row
    return !!(policyNumber || carrier)
  })

  if (dataRows.length === 0) {
    console.error('After filtering metadata rows, no deal rows remain. Check the file format.')
    process.exit(1)
  }

  console.log(`Parsed ${records.length} CSV rows; using ${dataRows.length} data rows after filtering.`)

  // Collect distinct carrier labels from CSV
  const carrierStrings = new Set(
    dataRows
      .map(r => (r['Carrier'] || '').trim())
      .filter(Boolean)
  )

  const carrierLookup = await buildCarrierLookup(carrierStrings)
  const agencyCarrierByName = await buildAgencyCarrierByNameLookup(carrierLookup)

  const entries = []
  let skipped = 0

  for (const row of dataRows) {
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

    const agencyCarrierId = resolveAgencyCarrierIdForRow(row, carrierInfo, agencyCarrierByName)
    if (!agencyCarrierId) {
      skipped++
      continue
    }

    entries.push(
      rowToEntry(row, agencyCarrierId, carrierInfo.carrierId, carrierInfo.carrierName)
    )
  }

  console.log(`Prepared ${entries.length} deal_tracker entries. Skipped ${skipped} rows without resolvable carrier/agency or policy number.`)

  if (entries.length === 0) {
    console.error('No entries to insert. Aborting.')
    process.exit(1)
  }

  console.log('Upserting into deal_tracker...')
  const BATCH_SIZE = 500
  let saved = 0
  let failed = 0

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from('deal_tracker')
      .upsert(batch, { onConflict: 'agency_carrier_id,policy_number', ignoreDuplicates: false })

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

