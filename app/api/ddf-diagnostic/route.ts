/**
 * DDF Diagnostic API – query the external Daily Deal Flow table and test name matching.
 * GET /api/ddf-diagnostic?carrier=AMAM&name=JANIS K MILL
 * Run this to see why a policy isn't matching DDF (connection, columns, carrier filter, name logic).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function normalizeName(name: string): string {
  return (name || '').replace(/\s+/g, ' ').trim()
}

function extractNameParts(fullName: string): { firstName: string; lastName: string } {
  const raw = (fullName ?? '').trim()
  if (!raw) return { firstName: '', lastName: '' }
  const commaIdx = raw.indexOf(',')
  if (commaIdx >= 0) {
    const beforeComma = raw.slice(0, commaIdx).replace(/\s+/g, ' ').trim()
    const afterComma = raw.slice(commaIdx + 1).replace(/\s+/g, ' ').trim()
    const firstWordAfter = afterComma.split(' ').filter(Boolean)[0] ?? ''
    if (beforeComma && firstWordAfter) return { firstName: firstWordAfter, lastName: beforeComma }
  }
  const n = normalizeName(fullName)
  const parts = n.split(' ').filter(p => p.length > 0)
  if (parts.length === 0) return { firstName: '', lastName: '' }
  return { firstName: parts[0], lastName: parts[parts.length - 1] }
}

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

export async function GET(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY
  const carrier = request.nextUrl.searchParams.get('carrier') || 'AMAM'
  const testName = request.nextUrl.searchParams.get('name') || 'JANIS K MILL'

  const out: Record<string, unknown> = {
    configured: !!(url && key),
    carrier,
    testName,
    step: '',
    error: null as string | null,
    rowCount: 0,
    columns: [] as string[],
    sampleRows: [] as unknown[],
    matchingRows: [] as unknown[],
    testMatchDetail: null as Record<string, unknown> | null,
  }

  if (!url || !key) {
    out.error = 'Missing NEXT_PUBLIC_EXTERNAL_SUPABASE_URL or NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY in .env.local'
    return NextResponse.json(out, { status: 200 })
  }

  const supabase = createClient(url, key)

  // Parse test name first so we can scope the query by name (fetch all DDF rows for this person, not just top 500 by date)
  const testParts = extractNameParts(testName)
  const policyFirst = (testParts.firstName || '').trim()
  const policyLast = (testParts.lastName || '').trim()
  const hasNameFilter = policyFirst.length > 0 && policyLast.length > 0

  const carrierUpper = (carrier || '').toUpperCase()
  const isAmam = carrierUpper === 'AMAM' || carrierUpper === 'ANAM' || carrierUpper.includes('AMERICAN AMICABLE')
  const isLiberty = carrierUpper === 'LIBERTY'
  const isCorebridge = carrierUpper === 'COREBRIDGE'

  out.step = isAmam ? 'Querying daily_deal_flow with carrier ilike %AMAM% or %ANAM% or %American%' : `Querying daily_deal_flow with carrier filter for ${carrier}`

  let query = supabase
    .from('daily_deal_flow')
    .select('*')
    .order('created_at', { ascending: false })

  if (isAmam) {
    query = query.or('carrier.ilike.%AMAM%,carrier.ilike.%ANAM%,carrier.ilike.%American%')
  } else if (isLiberty) {
    query = query.ilike('carrier', '%Liberty%')
  } else if (isCorebridge) {
    query = query.ilike('carrier', '%Corebridge%')
  } else {
    query = query.ilike('carrier', `%${carrier}%`)
  }

  // When a name is provided, fetch rows where insured_name contains first OR last so we get all DDF entries for this person (e.g. "Kimberly V Kirkland" and "Kimberly Kirkland")
  if (hasNameFilter) {
    query = query.or(`insured_name.ilike.%${policyFirst}%,insured_name.ilike.%${policyLast}%`)
    query = query.limit(300)
  } else {
    query = query.limit(500)
  }

  const { data: rows, error } = await query

  if (error) {
    out.error = error.message
    out.pgCode = error.code
    return NextResponse.json(out, { status: 200 })
  }

  out.rowCount = rows?.length ?? 0
  out.columns = rows?.length ? Object.keys(rows[0] as object) : []

  // Check for expected columns (support alternate names)
  const columns = out.columns as string[]
  const hasLeadVendor = columns.some((c: string) => /lead_vendor|lead_vendor_name/i.test(c))
  const hasPhone = columns.some((c: string) => /client_phone_number|phone_number/i.test(c))
  const hasInsuredName = columns.some((c: string) => /insured_name/i.test(c))
  out.hasExpectedColumns = { leadVendor: hasLeadVendor, phone: hasPhone, insuredName: hasInsuredName }

  // Sample rows (first 3), hide sensitive if any
  out.sampleRows = (rows ?? []).slice(0, 3).map((r: Record<string, unknown>) => ({
    insured_name: r.insured_name ?? r.insuredname,
    lead_vendor: r.lead_vendor ?? r.lead_vendor_name,
    client_phone_number: r.client_phone_number ?? r.phone_number,
    carrier: r.carrier,
  }))

  // 2) Name matching for testName (fuzzy first+last)
  const normalizedTest = normalizeName(testName).toLowerCase()
  const policyFirstLower = policyFirst.toLowerCase()
  const policyLastLower = policyLast.toLowerCase()
  out.testNameParsed = { normalized: normalizedTest, firstName: policyFirstLower, lastName: policyLastLower }

  const matchingRows: Record<string, unknown>[] = []
  for (const r of rows ?? []) {
    const rec = r as Record<string, unknown>
    const rName = normalizeName(String(rec.insured_name ?? rec.insuredname ?? ''))
    const rParts = extractNameParts(rName)
    const rFirst = rParts.firstName.toLowerCase()
    const rLast = rParts.lastName.toLowerCase()
    if (!rFirst || !rLast) continue
    const dFirst = editDistance(policyFirstLower, rFirst)
    const dLast = editDistance(policyLastLower, rLast)
    if (dFirst <= 2 && dLast <= 2) {
      matchingRows.push({
        insured_name: rec.insured_name ?? rec.insuredname,
        lead_vendor: rec.lead_vendor ?? rec.lead_vendor_name,
        client_phone_number: rec.client_phone_number ?? rec.phone_number,
        carrier: rec.carrier,
        editDistanceFirst: dFirst,
        editDistanceLast: dLast,
      })
    }
  }

  out.matchingRows = matchingRows
  out.testMatchDetail = {
    strategy: matchingRows.length > 0 ? 'Fuzzy first+last (edit distance <= 2)' : 'No match',
    wouldGetCallCenter: matchingRows.length > 0 ? (matchingRows[0] as Record<string, unknown>).lead_vendor : null,
    wouldGetPhone: matchingRows.length > 0 ? (matchingRows[0] as Record<string, unknown>).client_phone_number : null,
  }

  return NextResponse.json(out, { status: 200 })
}
