/**
 * Server-side DDF financial lookup for invoicing.
 *
 * The new DDF Supabase project requires the service role key (RLS bypass),
 * which Next.js never exposes to the browser. The invoicing page is a client
 * component, so it routes the lookup through this API route instead of
 * importing `getDdfClient('new')` directly.
 *
 * POST body: { insuredName: string, carrier: string, dealCreationDate?: string | null }
 * Returns:   { productType: string | null, monthlyPremium: number | null, faceAmount: number | null }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { normalizeNameForSearch } from '@/lib/dealTracker'
import { chooseDdfSourceByDealCreationDate, getDdfClient } from '@/lib/ddfSource'

function normalizeCarrierForMatch(carrier: string | null | undefined): string {
  return String(carrier ?? '').trim().toLowerCase()
}

function carrierMatchCandidates(carrier: string | null | undefined): string[] {
  const raw = String(carrier ?? '').trim().toLowerCase()
  if (!raw) return []
  const compact = raw.replace(/[^a-z0-9]/g, '')
  const out = new Set<string>()
  out.add(raw)
  out.add(compact)
  if (raw.includes('(')) out.add(raw.replace(/\(.*?\)/g, '').trim())
  if (compact.includes('amam') || compact.includes('anam')) {
    out.add('amam')
    out.add('anam')
    out.add('american amicable')
  }
  if (compact === 'ahl' || compact.includes('americanhomelife')) {
    out.add('ahl')
    out.add('american home life')
    out.add('americanhomelife')
  }
  if (compact === 'moh' || compact.includes('mutualofomaha')) {
    out.add('moh')
    out.add('mutual of omaha')
    out.add('mutualofomaha')
  }
  if (compact === 'rna' || compact.includes('royalneighborsofamerica')) {
    out.add('rna')
    out.add('royal neighbors of america')
    out.add('royalneighborsofamerica')
  }
  return Array.from(out).filter(Boolean)
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(n)) return null
  return n
}

function extractNamePartsForMatch(name: string): { first: string; last: string } {
  const normalized = normalizeNameForSearch(name)
  const parts = normalized.split(' ').filter(Boolean)
  return {
    first: parts[0] ?? '',
    last: parts.length > 1 ? parts[parts.length - 1] : '',
  }
}

function legacyExternalClient(): { client: ReturnType<typeof createClient>; table: string } {
  const url =
    process.env.LEGACY_DDF_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.LEGACY_DDF_ANON_KEY ||
    process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Missing legacy DDF env. Set LEGACY_DDF_SUPABASE_URL and LEGACY_DDF_ANON_KEY (or fallback external/public vars).'
    )
  }
  return { client: createClient(url, key), table: process.env.LEGACY_DDF_TABLE || 'daily_deal_flow' }
}

type DailyDealFlowFinancialRow = {
  insured_name: string | null
  carrier: string | null
  product_type: string | null
  monthly_premium: number | null
  face_amount: number | null
  created_at: string | null
}

export async function POST(request: NextRequest) {
  let body: { insuredName?: string; carrier?: string; dealCreationDate?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const insuredName = String(body.insuredName ?? '').trim()
  const carrier = String(body.carrier ?? '').trim()
  const dealCreationDate = body.dealCreationDate ?? null

  const normalizedName = normalizeNameForSearch(insuredName)
  const normalizedCarrier = normalizeCarrierForMatch(carrier)
  if (!normalizedName || !normalizedCarrier) {
    return NextResponse.json({ productType: null, monthlyPremium: null, faceAmount: null })
  }

  let sourceClient: ReturnType<typeof createClient>
  let table: string
  try {
    const source = chooseDdfSourceByDealCreationDate(dealCreationDate)
    if (source === 'new') {
      const resolved = getDdfClient('new')
      sourceClient = resolved.client as ReturnType<typeof createClient>
      table = resolved.table
    } else {
      const legacy = legacyExternalClient()
      sourceClient = legacy.client
      table = legacy.table
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'DDF env not configured'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const { first, last } = extractNamePartsForMatch(normalizedName)
  const attempts = [normalizedName]
  if (first && last && first !== last) attempts.push(`${first}%${last}`)
  if (first && first.length > 2) attempts.push(`${first}%`)
  if (last && last.length > 2) attempts.push(`%${last}`)
  const carrierCandidates = carrierMatchCandidates(carrier)

  try {
    for (const carrierCandidate of carrierCandidates) {
      for (const pattern of attempts) {
        const { data, error } = await sourceClient
          .from(table)
          .select('insured_name, carrier, product_type, monthly_premium, face_amount, created_at')
          .ilike('insured_name', pattern)
          .ilike('carrier', `%${carrierCandidate}%`)
          .order('created_at', { ascending: false })
          .limit(50)
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 })
        }
        const rows = (data || []) as DailyDealFlowFinancialRow[]
        if (!rows.length) continue
        const exact = rows.find((r) => normalizeNameForSearch(r.insured_name || '') === normalizedName)
        const best = exact ?? rows[0]
        return NextResponse.json({
          productType: (best.product_type || '').trim() || null,
          monthlyPremium: toNullableNumber(best.monthly_premium),
          faceAmount: toNullableNumber(best.face_amount),
        })
      }
    }
    return NextResponse.json({ productType: null, monthlyPremium: null, faceAmount: null })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'DDF lookup failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
