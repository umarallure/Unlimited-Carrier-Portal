/**
 * Import Aetna deals from a CSV file (e.g. deals_aetna.xlsx.csv) into the deal_tracker table.
 *
 * Prerequisites:
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY
 *   - An agency_carrier record for Aetna (script can list them if you don't know the ID)
 *
 * Usage:
 *   node scripts/import-aetna-deals-csv.js <path-to-csv>
 *   node scripts/import-aetna-deals-csv.js "D:\UnlimitedInsurance\Carrier\Policies and Commission Files\deals_aetna.xlsx.csv"
 *
 * Optional env:
 *   AGENCY_CARRIER_ID=<uuid>  Use this agency_carrier for all rows (required if you have multiple Aetna agency_carriers).
 *
 * If AGENCY_CARRIER_ID is not set and there is exactly one Aetna agency_carrier, that one is used.
 * If there are multiple, the script lists them and exits; set AGENCY_CARRIER_ID and run again.
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

// CSV column name -> deal_tracker column name (for reference)
const COLUMN_MAP = {
  'Name': 'name',
  'Tasks': 'tasks',
  'GHL Name': 'ghl_name',
  'GHL Stage': 'ghl_stage',
  'Policy Status': 'policy_status',
  'Deal creation date': 'deal_creation_date',
  'Policy Number': 'policy_number',
  'Carrier': 'carrier',
  'Deal Value': 'deal_value',
  'CC Value': 'cc_value',
  'Notes': 'notes',
  'Status': 'status',
  'Last updated': 'last_updated',
  'Sales Agent': 'sales_agent',
  'Writing #': 'writing_number',
  'Commission Type': 'commission_type',
  'Effective Date': 'effective_date',
  'Call Center': 'call_center',
  'Phone Number': 'phone_number',
  'CC PMT WS': 'cc_pmt_ws',
  'CC CB WS': 'cc_cb_ws',
  'Carrier Status': 'carrier_status',
  'Policy Type': 'policy_type',
}

// Map Sales Agent -> Agency Name (must match agencies.name in DB)
// Heritage agents
const SALES_AGENT_AGENCY = {
  'Abdul Ibrahim': 'Heritage Insurance',
  'Isaac Reed': 'Heritage Insurance',
  'Noah Brock': 'Heritage Insurance',
  'Trinity Queen': 'Heritage Insurance',
  // Safe Harbor agents
  'Brandon Flinchum': 'Safe Harbor Insurance',
  // Unlimited agents
  'Benjamin Wunder': 'Unlimited Insurance',
  'Caleb Johnson': 'Unlimited Insurance',
  'Claudia Tradardi': 'Unlimited Insurance',
  'Lydia Sutton': 'Unlimited Insurance',
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

function rowToEntry (row, agencyCarrierId, carrierId) {
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
    carrier: toNull(get('Carrier')) || 'Aetna',
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
 * Load all Aetna agency_carriers and build a lookup by agency name.
 * Returns { carrierId, byAgencyName, defaultAgencyCarrierId }.
 *
 * - If AGENCY_CARRIER_ID is set, that is used as the default for any rows
 *   whose Sales Agent is not in SALES_AGENT_AGENCY.
 */
async function getAetnaAgencyCarrierLookup () {
  const fromEnv = process.env.AGENCY_CARRIER_ID

  const { data: allRows, error } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, agencies ( id, name ), carriers ( id, name, code )')

  if (error) {
    console.error('Failed to fetch agency_carriers:', error.message)
    process.exit(1)
  }

  const aetnaRows = (allRows || []).filter(
    (ac) => (ac.carriers?.code || '').toUpperCase() === 'AETNA'
  )

  if (aetnaRows.length === 0) {
    console.error('No Aetna agency_carrier found. Create Heritage / Unlimited / Safe Harbor agencies with Aetna attached, then run again.')
    process.exit(1)
  }

  const byAgencyName = new Map()
  let carrierId = null
  for (const ac of aetnaRows) {
    const agencyName = (ac.agencies?.name || '').trim()
    if (!agencyName) continue
    byAgencyName.set(agencyName.toLowerCase(), ac.id)
    if (!carrierId && ac.carrier_id) carrierId = ac.carrier_id
  }

  if (!carrierId) {
    console.error('Could not resolve Aetna carrier_id from agency_carriers.')
    process.exit(1)
  }

  let defaultAgencyCarrierId = fromEnv && fromEnv.trim() ? fromEnv.trim() : null
  if (!defaultAgencyCarrierId) {
    if (aetnaRows.length === 1) {
      defaultAgencyCarrierId = aetnaRows[0].id
    } else {
      console.log('Multiple Aetna agency_carriers found. Set AGENCY_CARRIER_ID to the default agency_carrier for unmatched rows.')
    }
  }

  return {
    carrierId,
    byAgencyName,
    defaultAgencyCarrierId,
  }
}

function resolveAgencyCarrierIdForRow (row, lookup) {
  const salesAgent = (row['Sales Agent'] || '').trim()
  const agencyName = SALES_AGENT_AGENCY[salesAgent]

  if (agencyName) {
    const acId = lookup.byAgencyName.get(agencyName.toLowerCase())
    if (acId) return acId
    console.warn(`No Aetna agency_carrier found for agency "${agencyName}" (Sales Agent "${salesAgent}").`)
  }

  if (lookup.defaultAgencyCarrierId) {
    return lookup.defaultAgencyCarrierId
  }

  throw new Error(`Cannot resolve agency_carrier_id for Sales Agent "${salesAgent}" and no default AGENCY_CARRIER_ID is set.`)
}

async function main () {
  const csvPath = process.argv[2]
  if (!csvPath) {
    console.error('Usage: node scripts/import-aetna-deals-csv.js <path-to-csv>')
    console.error('Example: node scripts/import-aetna-deals-csv.js "D:\\UnlimitedInsurance\\Carrier\\Policies and Commission Files\\deals_aetna.xlsx.csv"')
    process.exit(1)
  }

  const resolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath)
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved)
    process.exit(1)
  }

  console.log('Reading CSV:', resolved)
  const csvContent = fs.readFileSync(resolved, 'utf-8')
  const records = csv.parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })

  if (records.length === 0) {
    console.error('No data rows in CSV.')
    process.exit(1)
  }

  console.log('Resolving Aetna agency_carriers and carrier_id...')
  const lookup = await getAetnaAgencyCarrierLookup()
  console.log('Aetna carrier_id:', lookup.carrierId, '| agencies found:', lookup.byAgencyName.size)
  if (lookup.defaultAgencyCarrierId) {
    console.log('Default agency_carrier_id for unmatched rows:', lookup.defaultAgencyCarrierId)
  }

  const entries = []
  let skipped = 0
  for (const row of records) {
    const policyNumber = toNull(row['Policy Number'])
    if (!policyNumber) {
      skipped++
      continue
    }
    const agencyCarrierIdForRow = resolveAgencyCarrierIdForRow(row, lookup)
    entries.push(rowToEntry(row, agencyCarrierIdForRow, lookup.carrierId))
  }
  if (skipped) console.log('Skipped', skipped, 'rows without Policy Number')

  console.log('Upserting', entries.length, 'rows into deal_tracker...')
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
