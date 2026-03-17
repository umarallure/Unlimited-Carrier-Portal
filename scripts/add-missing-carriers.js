/**
 * Add missing carriers (GTL, SBLI, Aflac, Sentinel, Americo, CHUB)
 * and link each to all existing agencies in the database.
 *
 * Usage (from admin-dashboard):
 *   node scripts/add-missing-carriers.js
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

const MISSING_CARRIERS = [
  { code: 'GTL', name: 'GTL' },
  { code: 'SBLI', name: 'SBLI' },
  { code: 'AFLAC', name: 'Aflac' },
  { code: 'SENTINEL', name: 'Sentinel' },
  { code: 'AMERICO', name: 'Americo' },
  { code: 'CHUB', name: 'CHUB' },
]

async function main () {
  console.log('Supabase URL:', supabaseUrl)

  // 1. Load existing carriers to avoid duplicates
  const { data: existingCarriers, error: carriersError } = await supabase
    .from('carriers')
    .select('id, code, name')

  if (carriersError) {
    console.error('Error fetching carriers:', carriersError.message)
    process.exit(1)
  }

  const existingByCode = new Map()
  ;(existingCarriers || []).forEach(c => {
    if (c.code) existingByCode.set(c.code.toUpperCase(), c)
  })

  // 2. Insert missing carriers
  const toInsert = MISSING_CARRIERS.filter(c => !existingByCode.has(c.code.toUpperCase()))

  if (toInsert.length > 0) {
    console.log('Inserting carriers:', toInsert.map(c => `${c.code} (${c.name})`).join(', '))
    const { data: inserted, error: insertError } = await supabase
      .from('carriers')
      .insert(toInsert)
      .select('id, code, name')

    if (insertError) {
      console.error('Failed to insert carriers:', insertError.message)
      process.exit(1)
    }

    inserted.forEach(c => {
      existingByCode.set(c.code.toUpperCase(), c)
    })
  } else {
    console.log('All missing carriers already exist; no new carriers inserted.')
  }

  // 3. Load all agencies
  const { data: agencies, error: agenciesError } = await supabase
    .from('agencies')
    .select('id, name')

  if (agenciesError) {
    console.error('Error fetching agencies:', agenciesError.message)
    process.exit(1)
  }

  if (!agencies || agencies.length === 0) {
    console.error('No agencies found; cannot link agency_carriers.')
    process.exit(1)
  }

  // 4. Load existing agency_carriers to avoid duplicate links
  const { data: acRows, error: acError } = await supabase
    .from('agency_carriers')
    .select('id, carrier_id, agency_id')

  if (acError) {
    console.error('Error fetching agency_carriers:', acError.message)
    process.exit(1)
  }

  const acSet = new Set()
  ;(acRows || []).forEach(row => {
    acSet.add(`${row.carrier_id}::${row.agency_id}`)
  })

  // 5. Build new agency_carriers rows: each missing carrier linked to all agencies
  const newLinks = []
  for (const carrierDef of MISSING_CARRIERS) {
    const carrier = existingByCode.get(carrierDef.code.toUpperCase())
    if (!carrier) continue
    for (const agency of agencies) {
      const key = `${carrier.id}::${agency.id}`
      if (!acSet.has(key)) {
        newLinks.push({
          carrier_id: carrier.id,
          agency_id: agency.id,
        })
        acSet.add(key)
      }
    }
  }

  if (newLinks.length > 0) {
    console.log('Inserting agency_carriers links:', newLinks.length)
    const { error: linkError } = await supabase
      .from('agency_carriers')
      .insert(newLinks)

    if (linkError) {
      console.error('Failed to insert agency_carriers:', linkError.message)
      process.exit(1)
    }
  } else {
    console.log('All carrier/agency combinations already exist; no new agency_carriers inserted.')
  }

  console.log('Done adding missing carriers and agency links.')
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})

