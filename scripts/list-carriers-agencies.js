/**
 * List carriers, agencies, and agency_carriers to help configure import scripts.
 *
 * Usage (from admin-dashboard):
 *   node scripts/list-carriers-agencies.js
 */

const { createClient } = require('@supabase/supabase-js')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function main () {
  console.log('Supabase URL:', supabaseUrl)

  const { data: carriers, error: carriersError } = await supabase
    .from('carriers')
    .select('id, name, code')
    .order('name')

  if (carriersError) {
    console.error('Error fetching carriers:', carriersError.message)
  } else {
    console.log('\n== Carriers ==')
    carriers.forEach(c => {
      console.log(`carrier_id=${c.id} | code=${c.code} | name=${c.name}`)
    })
  }

  const { data: agencies, error: agenciesError } = await supabase
    .from('agencies')
    .select('id, name')
    .order('name')

  if (agenciesError) {
    console.error('Error fetching agencies:', agenciesError.message)
  } else {
    console.log('\n== Agencies ==')
    agencies.forEach(a => {
      console.log(`agency_id=${a.id} | name=${a.name}`)
    })
  }

  const { data: acRows, error: acError } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, agency_id, carriers ( name, code ), agencies ( name )')
    .order('carrier_id')

  if (acError) {
    console.error('Error fetching agency_carriers:', acError.message)
  } else {
    console.log('\n== Agency-Carriers ==')
    acRows.forEach(row => {
      const carrierName = row.carriers?.name ?? ''
      const carrierCode = row.carriers?.code ?? ''
      const agencyName = row.agencies?.name ?? ''
      console.log(
        `agency_carrier_id=${row.id} | carrier_id=${row.carrier_id} (${carrierCode} / ${carrierName}) | agency_id=${row.agency_id} (${agencyName})`
      )
    })
  }
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})

