/**
 * Server-side DDF lookup – avoids CORS by having the browser call this instead of external Supabase.
 * POST body: { carrier: string, names: string[] }
 * Returns: { results: Record<string, { call_center: string | null, phone_number: string | null, draft_date: string | null, lead_name: string | null }> }
 * Caches DDF rows per carrier for 90s so chunked client requests only hit external DB once.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getDdfRecordsForCarrier, matchDdfNamesToRecords } from '@/lib/dealTracker'
import { getDdfClient } from '@/lib/ddfSource'

const CACHE_TTL_MS = 90_000
const ddfCache = new Map<string, { data: Awaited<ReturnType<typeof getDdfRecordsForCarrier>>; ts: number }>()

function normalizeLookupName(value: string): string {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function getCachedOrFetch(
  carrier: string,
  source: 'new',
  supabase: ReturnType<typeof createClient>,
  table: string,
) {
  const key = `${source}:${table}:${(carrier || 'AMAM').toUpperCase()}`
  const now = Date.now()
  const entry = ddfCache.get(key)
  if (entry && now - entry.ts < CACHE_TTL_MS) {
    return Promise.resolve(entry.data)
  }
  return getDdfRecordsForCarrier(supabase, carrier, table).then(records => {
    ddfCache.set(key, { data: records, ts: now })
    return records
  })
}

export async function POST(request: NextRequest) {
  type LookupItem = { key?: string; name?: string; dealCreationDate?: string | null }
  let body: { carrier?: string; names?: string[]; items?: LookupItem[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const carrier = body.carrier || 'AMAM'
  const items = Array.isArray(body.items)
    ? body.items
        .map((it, index) => ({
          key: String(it?.key ?? `${index}`),
          name: String(it?.name ?? '').trim(),
          dealCreationDate: it?.dealCreationDate ?? null,
        }))
        .filter((it) => it.name.length > 0)
    : []
  const names = Array.isArray(body.names)
    ? body.names.map((n, index) => ({ key: `${index}`, name: String(n ?? '').trim(), dealCreationDate: null }))
    : []
  const normalizedItems = (items.length > 0 ? items : names).filter((it) => it.name.length > 0)

  // Log when Liberty (or other) DDF returns no/low matches so we can debug empty Call Center/Phone
  const carrierUpper = (carrier || '').toUpperCase()
  const resolvedResults = new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }>()
  try {
    const source = 'new'
    const sourceItems = normalizedItems
    const { client, table } = getDdfClient(source)
    const records = await getCachedOrFetch(carrier, source, client as ReturnType<typeof createClient>, table)
    const map = matchDdfNamesToRecords(records, sourceItems.map((it) => it.name))
    sourceItems.forEach((it) => {
      const key = it.key
      const matched = map.get(normalizeLookupName(it.name)) || map.get(it.name) || null
      if (matched) {
        resolvedResults.set(key, {
          call_center: matched.call_center ?? null,
          phone_number: matched.phone_number ?? null,
          draft_date: matched.draft_date ?? null,
          lead_name: matched.lead_name ?? null,
        })
      }
    })
    if (carrierUpper === 'LIBERTY' || sourceItems.length > 0) {
      const sampleCarriers = [...new Set((records as { carrier?: string }[]).slice(0, 20).map((r) => r.carrier ?? '(null)'))]
      console.log(
        '[ddf-lookup]',
        carrier,
        '| source:',
        source,
        '| names requested:',
        sourceItems.length,
        '| DDF rows:',
        records.length,
        '| matched:',
        resolvedResults.size,
        '| sample carriers:',
        sampleCarriers.slice(0, 5),
      )
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'DDF lookup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const results: Record<string, { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }> = {}
  normalizedItems.forEach((it) => {
    const v = resolvedResults.get(it.key)
    if (!v) return
    results[it.key] = v
  })

  return NextResponse.json({ results })
}
