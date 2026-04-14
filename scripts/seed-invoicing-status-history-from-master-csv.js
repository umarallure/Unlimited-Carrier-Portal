/**
 * Seed invoicing_status_history from legacy "Master Invoice - Database.csv".
 *
 * Uses only needed columns:
 * - Policy # (required)
 * - Business Type (required -> invoicing_status)
 * - Week Date (preferred effective_date)
 * - Carrier (optional matcher)
 * - Call Center (optional matcher)
 *
 * Matching strategy:
 * 1) Find deal_tracker rows by policy_number
 * 2) Prefer row that also matches Carrier and/or Call Center from CSV
 * 3) Fallback to latest updated row for that policy
 *
 * Usage:
 *   node scripts/seed-invoicing-status-history-from-master-csv.js "/abs/path/Master Invoice - Database.csv" --dry-run
 *   node scripts/seed-invoicing-status-history-from-master-csv.js "/abs/path/Master Invoice - Database.csv"
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

function toNull(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim()
  return s === '' ? null : s
}

function norm(v) {
  return (v || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

function normalizePolicyNumber(v) {
  const s = toNull(v)
  if (!s) return ''
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (/^\d+$/.test(cleaned)) {
    // Numeric policy numbers should match regardless of leading zeros.
    return cleaned.replace(/^0+/, '') || '0'
  }
  return cleaned
}

function policyLookupCandidates(v) {
  const s = toNull(v)
  if (!s) return []
  const cleaned = s.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  if (!cleaned) return []
  if (!/^\d+$/.test(cleaned)) return [cleaned]

  const out = new Set()
  const stripped = cleaned.replace(/^0+/, '') || '0'
  out.add(cleaned)
  out.add(stripped)
  // Add a few common zero-prefixed variants used by carrier exports.
  for (let len = Math.max(cleaned.length, stripped.length); len <= 12; len++) {
    if (stripped.length > len) continue
    out.add(stripped.padStart(len, '0'))
  }
  return Array.from(out)
}

function parseUsDateToYmd(v) {
  const s = toNull(v)
  if (!s) return null
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return s
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!us) return null
  const mm = String(parseInt(us[1], 10)).padStart(2, '0')
  const dd = String(parseInt(us[2], 10)).padStart(2, '0')
  return `${us[3]}-${mm}-${dd}`
}

function mapBusinessTypeToStatus(v) {
  const t = norm(v)
  if (!t) return null
  if (t === 'new sales' || t === 'new sale') return 'new_sale'
  if (t === 'new charge back' || t === 'new chargeback') return 'New Charge Back'
  if (t === 'chargeback' || t === 'charge back') return 'New Charge Back'
  if (t === 're-charge back' || t === 're-chargeback') return 'rechargeback'
  if (t === 'repay') return 'repay'
  if (t === 'paid delete') return 'paid_delete'
  if (t === 'cb delete') return 'cb_delete'
  if (t === 'cb never paid') return 'cb_never_paid'
  if (t === 'cb repay') return 'cb_repay'
  return null
}

function parseArgs() {
  const args = process.argv.slice(2)
  const csvPath = args.find((a) => !a.startsWith('--'))
  const dryRun = args.includes('--dry-run')
  if (!csvPath) {
    console.error('Usage: node scripts/seed-invoicing-status-history-from-master-csv.js <path-to-csv> [--dry-run]')
    process.exit(1)
  }
  return { csvPath, dryRun }
}

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function rowTimestamp(row) {
  const raw = row.updated_at || row.created_at || ''
  const t = raw ? new Date(raw).getTime() : 0
  return Number.isNaN(t) ? 0 : t
}

function chooseBestDealTrackerRow(candidates, carrier, callCenter) {
  if (!candidates || candidates.length === 0) return null
  const nCarrier = norm(carrier)
  const nCall = norm(callCenter)
  const scored = candidates
    .map((r) => {
      let score = 0
      if (nCarrier && norm(r.carrier) === nCarrier) score += 2
      if (nCall && norm(r.call_center) === nCall) score += 3
      return { r, score, ts: rowTimestamp(r) }
    })
    .sort((a, b) => b.score - a.score || b.ts - a.ts)
  return scored[0].r
}

async function main() {
  const { csvPath, dryRun } = parseArgs()
  const resolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath)
  if (!fs.existsSync(resolved)) {
    console.error('File not found:', resolved)
    process.exit(1)
  }

  console.log('Reading CSV:', resolved)
  const content = fs.readFileSync(resolved, 'utf-8')
  const records = csv.parse(content, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  })
  if (!records || records.length === 0) {
    console.error('No rows found in CSV.')
    process.exit(1)
  }

  const normalizedRows = records
    .map((r) => ({
      policy_number: toNull(r['Policy #']),
      policy_number_norm: normalizePolicyNumber(r['Policy #']),
      carrier: toNull(r['Carrier']),
      call_center: toNull(r['Call Center']),
      status: mapBusinessTypeToStatus(r['Business Type']),
      effective_date: parseUsDateToYmd(r['Week Date']),
    }))
    .filter((r) => r.policy_number && r.policy_number_norm && r.status && r.effective_date)

  console.log(`Parsed ${records.length} rows; eligible for seeding: ${normalizedRows.length}`)
  if (normalizedRows.length === 0) {
    console.error('No eligible rows with Policy # + Business Type + Week Date.')
    process.exit(1)
  }

  const policyNumbers = Array.from(new Set(normalizedRows.map((r) => r.policy_number)))
  const policyLookupNumbers = Array.from(
    new Set(
      normalizedRows.flatMap((r) => policyLookupCandidates(r.policy_number)),
    ),
  )
  const dtRows = []
  for (const batch of chunk(policyLookupNumbers, 400)) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select('agency_carrier_id, policy_number, carrier, call_center, updated_at, created_at')
      .in('policy_number', batch)
    if (error) throw new Error(error.message)
    dtRows.push(...(data || []))
  }

  const dtByPolicy = new Map()
  const dtByPolicyNorm = new Map()
  for (const row of dtRows) {
    const k = String(row.policy_number || '').trim()
    if (!k) continue
    const list = dtByPolicy.get(k) || []
    list.push(row)
    dtByPolicy.set(k, list)
    const nk = normalizePolicyNumber(k)
    if (nk) {
      const nList = dtByPolicyNorm.get(nk) || []
      nList.push(row)
      dtByPolicyNorm.set(nk, nList)
    }
  }

  // Fallback matcher: commission_tracker rows can still provide agency_carrier_id
  // for policies not yet present in deal_tracker.
  const ctRows = []
  for (const batch of chunk(policyLookupNumbers, 400)) {
    const { data, error } = await supabase
      .from('commission_tracker')
      .select('agency_carrier_id, policy_number, carrier, created_at')
      .in('policy_number', batch)
    if (error) throw new Error(error.message)
    ctRows.push(...(data || []))
  }
  const ctByPolicyNorm = new Map()
  for (const row of ctRows) {
    const nk = normalizePolicyNumber(row.policy_number)
    if (!nk) continue
    const list = ctByPolicyNorm.get(nk) || []
    list.push({
      agency_carrier_id: row.agency_carrier_id,
      policy_number: row.policy_number,
      carrier: row.carrier,
      call_center: null,
      created_at: row.created_at,
      updated_at: row.created_at,
    })
    ctByPolicyNorm.set(nk, list)
  }

  const prepared = []
  let unresolved = 0
  const unresolvedRows = []
  for (const row of normalizedRows) {
    let candidates = dtByPolicy.get(row.policy_number) || []
    if (candidates.length === 0) {
      candidates = dtByPolicyNorm.get(row.policy_number_norm) || []
    }
    if (candidates.length === 0) {
      candidates = ctByPolicyNorm.get(row.policy_number_norm) || []
    }
    const matched = chooseBestDealTrackerRow(candidates, row.carrier, row.call_center)
    if (!matched) {
      unresolved++
      unresolvedRows.push({
        policy_number: row.policy_number,
        carrier: row.carrier,
        call_center: row.call_center,
        status: row.status,
        effective_date: row.effective_date,
      })
      continue
    }
    prepared.push({
      agency_carrier_id: matched.agency_carrier_id,
      carrier: matched.carrier || row.carrier || null,
      policy_number: row.policy_number,
      invoicing_status: row.status,
      effective_date: row.effective_date,
    })
  }

  const payload = prepared
  console.log(`Resolved rows: ${payload.length}; unresolved policies: ${unresolved}`)
  if (unresolvedRows.length > 0) {
    const outPath = path.join(process.cwd(), 'tmp-unresolved-invoicing-seed.csv')
    const header = 'policy_number,carrier,call_center,status,effective_date'
    const body = unresolvedRows
      .map((r) =>
        [r.policy_number, r.carrier, r.call_center, r.status, r.effective_date]
          .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
          .join(','),
      )
      .join('\n')
    fs.writeFileSync(outPath, `${header}\n${body}\n`, 'utf-8')
    console.log(`Wrote unresolved rows to: ${outPath}`)
  }

  if (payload.length === 0) {
    console.error('Nothing to insert.')
    process.exit(1)
  }

  if (dryRun) {
    console.log('Dry run enabled. First 10 rows:')
    console.log(payload.slice(0, 10))
    return
  }

  // Create one batch per effective_date so the unique index
  // (batch_id, policy_number, carrier) allows same policy across weeks.
  const rowsByDate = new Map()
  for (const row of payload) {
    const d = row.effective_date
    const list = rowsByDate.get(d) || []
    list.push(row)
    rowsByDate.set(d, list)
  }

  const allDates = Array.from(rowsByDate.keys()).sort()
  let inserted = 0
  for (const d of allDates) {
    const { data: batchRow, error: batchError } = await supabase
      .from('invoicing_batches')
      .insert({
        start_date: d,
        end_date: d,
        gross_total: 0,
        cc_total: 0,
        paid_at: new Date().toISOString(),
        paid_by_email: 'legacy-seed-script',
      })
      .select('id')
      .single()
    if (batchError || !batchRow?.id) {
      throw new Error(batchError?.message || `Failed to create seed batch for ${d}`)
    }
    const batchId = String(batchRow.id)
    const dayRows = rowsByDate.get(d) || []
    for (const part of chunk(dayRows, 500)) {
      const withBatch = part.map((row) => ({
        ...row,
        batch_id: batchId,
      }))
      const { error } = await supabase.from('invoicing_status_history').insert(withBatch)
      if (error) throw new Error(error.message)
      inserted += part.length
    }
    console.log(`Inserted ${inserted}/${payload.length} (date ${d}, batch ${batchId}, rows ${dayRows.length})`)
  }

  console.log(`Done. Inserted ${inserted} status history rows.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

