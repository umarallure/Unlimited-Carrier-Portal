/**
 * Check daily_deal_flow table in EXTERNAL Supabase (DDF lookup target).
 * Run from admin-dashboard: node scripts/check-ddf-table.js
 * Loads .env.local for NEXT_PUBLIC_EXTERNAL_SUPABASE_* (or main SUPABASE_*).
 */

require('dotenv').config({ path: '.env.local' })
const { createClient } = require('@supabase/supabase-js')

const url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_EXTERNAL_SUPABASE_URL/KEY or NEXT_PUBLIC_SUPABASE_URL/KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(url, key)
const isExternal = !!process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL

console.log('Using', isExternal ? 'EXTERNAL' : 'main', 'Supabase:', url.replace(/https:\/\//, '').slice(0, 30) + '...\n')

async function main() {
  // 1) Total count
  const { count: totalCount, error: countErr } = await supabase
    .from('daily_deal_flow')
    .select('*', { count: 'exact', head: true })

  if (countErr) {
    console.error('Error reading daily_deal_flow:', countErr.message)
    console.error('Code:', countErr.code, '| Details:', countErr.details)
    return
  }

  console.log('daily_deal_flow total rows:', totalCount ?? 0)

  // 2) Sample of rows (only columns that exist: no lead_vendor_name, no phone_number in this DB)
  const { data: sample, error: sampleErr } = await supabase
    .from('daily_deal_flow')
    .select('carrier, insured_name, lead_vendor, client_phone_number, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  if (sampleErr) {
    console.error('Error sampling rows:', sampleErr.message)
  } else {
    console.log('\nSample columns / carrier values (latest 5 rows):')
    sample?.forEach((r, i) => {
      console.log('  Row', i + 1, '| carrier:', JSON.stringify(r?.carrier), '| insured_name:', (r?.insured_name || '').slice(0, 30))
    })
  }

  // 3) Distinct carrier values (fetch a page and derive distinct)
  const { data: allCarriers, error: carriersErr } = await supabase
    .from('daily_deal_flow')
    .select('carrier')
    .limit(2000)

  if (carriersErr) {
    console.error('Error fetching carriers:', carriersErr.message)
  } else {
    const distinct = [...new Set((allCarriers || []).map(r => r?.carrier ?? '(null)'))]
    console.log('\nDistinct carrier values (up to 2000 rows):', distinct.slice(0, 30))
    if (distinct.length > 30) console.log('  ... and', distinct.length - 30, 'more')
  }

  // 4) Liberty-specific: rows where carrier contains "Liberty" (ilike)
  const { data: libertyRows, error: libertyErr } = await supabase
    .from('daily_deal_flow')
    .select('carrier, insured_name, lead_vendor, client_phone_number')
    .ilike('carrier', '%Liberty%')
    .limit(10)

  if (libertyErr) {
    console.error('\nError querying Liberty rows:', libertyErr.message)
  } else {
    console.log('\nRows where carrier ILIKE \'%Liberty%\':', libertyRows?.length ?? 0)
    libertyRows?.slice(0, 5).forEach((r, i) => {
      console.log('  Liberty', i + 1, '| carrier:', JSON.stringify(r?.carrier), '| insured_name:', (r?.insured_name || '').slice(0, 35))
    })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
