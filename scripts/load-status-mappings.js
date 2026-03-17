/**
 * Script to load carrier status mappings from CSV file into database
 * Run this after running the supabase_deal_tracker.sql migration
 */

const { createClient } = require('@supabase/supabase-js')
const fs = require('fs')
const path = require('path')
const csv = require('csv-parse/sync')

require('dotenv').config({ path: path.join(__dirname, '../.env.local') })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials. Please set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseKey)

async function loadStatusMappings() {
  const csvPath = path.join(__dirname, '../Monday Status based on Carrier Status - Sheet1.csv')
  
  if (!fs.existsSync(csvPath)) {
    console.error(`CSV file not found at: ${csvPath}`)
    process.exit(1)
  }

  const csvContent = fs.readFileSync(csvPath, 'utf-8')
  const records = csv.parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
  })

  console.log(`Found ${records.length} status mappings in CSV`)

  // Map carrier names to carrier codes
  const carrierCodeMap = {
    'Aetna': 'AETNA',
    'Aflac': 'AFLAC',
    'Americo': 'AMERICO',
    'ANAM': 'AMAM',
    'CHUB': 'CHUB',
    'CICA': 'CICA',
    'Corebridge': 'COREBRIDGE',
    'GTL': 'GTL',
    'Liberty': 'LIBERTY',
    'MOH': 'MOH',
    'Royal Neighbors': 'RNA', // CSV says "Royal Neighbors", app carrier code is RNA
    'SBLI': 'SBLI',
    'Transamerica': 'TRANSAMERICA',
    'Sentinel': 'SENTINEL',
  }

  // Fetch all carriers to map codes to IDs
  const { data: carriers, error: carriersError } = await supabase
    .from('carriers')
    .select('id, code, name')

  if (carriersError) {
    console.error('Error fetching carriers:', carriersError)
    throw carriersError
  }

  // Create a map of carrier code -> carrier ID
  const carrierIdMap = new Map()
  carriers.forEach(c => {
    if (c.code) {
      carrierIdMap.set(c.code.toUpperCase(), c.id)
    }
    // Also map by name (case-insensitive)
    if (c.name) {
      carrierIdMap.set(c.name.toUpperCase(), c.id)
    }
  })

  const mappings = records.map(record => {
    const carrierCode = carrierCodeMap[record.Carrier] || record.Carrier.toUpperCase()
    const carrierId = carrierIdMap.get(carrierCode) || carrierIdMap.get(record.Carrier.toUpperCase()) || null

    return {
      carrier: record.Carrier, // Keep original name from CSV
      carrier_code: carrierCode, // Map to code
      carrier_id: carrierId, // Map to actual carrier ID (UUID)
      policy_status_in_carrier_portal: record['Policy Status in Carrier Portal'],
      stage_monday: record['Stage Monday'],
    }
  })

  // Insert mappings (upsert to avoid duplicates)
  let inserted = 0
  let updated = 0
  let failed = 0

  for (const mapping of mappings) {
    const { data, error } = await supabase
      .from('carrier_status_mapping')
      .upsert(mapping, {
        onConflict: 'carrier,policy_status_in_carrier_portal',
      })
      .select()

    if (error) {
      console.error(`Error upserting mapping for ${mapping.carrier} - ${mapping.policy_status_in_carrier_portal}:`, error)
      failed++
    } else {
      if (data && data.length > 0) {
        // Check if it was an insert or update
        const existing = await supabase
          .from('carrier_status_mapping')
          .select('id')
          .eq('carrier', mapping.carrier)
          .eq('policy_status_in_carrier_portal', mapping.policy_status_in_carrier_portal)
          .single()

        if (existing.data) {
          updated++
        } else {
          inserted++
        }
      }
    }
  }

  console.log(`\nStatus Mapping Load Complete:`)
  console.log(`  Inserted: ${inserted}`)
  console.log(`  Updated: ${updated}`)
  console.log(`  Failed: ${failed}`)
}

loadStatusMappings()
  .then(() => {
    console.log('\nDone!')
    process.exit(0)
  })
  .catch(error => {
    console.error('Error loading status mappings:', error)
    process.exit(1)
  })
