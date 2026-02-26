/**
 * Server-side DDF lookup – avoids CORS by having the browser call this instead of external Supabase.
 * POST body: { carrier: string, names: string[] }
 * Returns: { results: Record<string, { call_center: string | null, phone_number: string | null, draft_date: string | null }> }
 * Caches DDF rows per carrier for 90s so chunked client requests only hit external DB once.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getDdfRecordsForCarrier, matchDdfNamesToRecords } from '@/lib/dealTracker'

const CACHE_TTL_MS = 90_000
const ddfCache = new Map<string, { data: Awaited<ReturnType<typeof getDdfRecordsForCarrier>>; ts: number }>()

function getCachedOrFetch(carrier: string, supabase: ReturnType<typeof createClient>) {
  const key = (carrier || 'AMAM').toUpperCase()
  const now = Date.now()
  const entry = ddfCache.get(key)
  if (entry && now - entry.ts < CACHE_TTL_MS) {
    return Promise.resolve(entry.data)
  }
  return getDdfRecordsForCarrier(supabase, carrier).then(records => {
    ddfCache.set(key, { data: records, ts: now })
    return records
  })
}

export async function POST(request: NextRequest) {
  // Prefer external DDF Supabase; fall back to main project so one-DB setups work
  let url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL
  let key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY
  if (!url || !key) {
    url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? undefined
    key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? undefined
  }
  if (!url || !key) {
    return NextResponse.json(
      { error: 'Missing Supabase env. Set NEXT_PUBLIC_EXTERNAL_SUPABASE_URL/KEY or NEXT_PUBLIC_SUPABASE_URL/KEY for DDF.' },
      { status: 500 }
    )
  }

  let body: { carrier?: string; names?: string[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const carrier = body.carrier || 'AMAM'
  const names = Array.isArray(body.names) ? body.names : []

  const supabase = createClient(url, key) as ReturnType<typeof createClient>
  const records = await getCachedOrFetch(carrier, supabase)
  const map = matchDdfNamesToRecords(records, names)

  // Log when Liberty (or other) DDF returns no/low matches so we can debug empty Call Center/Phone
  const carrierUpper = (carrier || '').toUpperCase()
  if (carrierUpper === 'LIBERTY' || names.length > 0) {
    const sampleCarriers = [...new Set((records as { carrier?: string }[]).slice(0, 20).map(r => r.carrier ?? '(null)'))]
    console.log('[ddf-lookup]', carrier, '| names requested:', names.length, '| DDF rows for carrier:', records.length, '| matched:', map.size, '| sample DDF carriers:', sampleCarriers.slice(0, 5))
  }

  const results: Record<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }> = {}
  map.forEach((v, k) => {
    results[k] = { call_center: v.call_center, phone_number: v.phone_number, draft_date: v.draft_date }
  })

  return NextResponse.json({ results })
}
