/**
 * Batch version of suggest-ddf-match: resolves every currently-Incomplete deal_tracker
 * upload row in one request instead of the human clicking "Ask AI" and waiting per row.
 * Same candidate pipeline and never-writes-anything contract as the single-row route (see
 * that file's header comment) — this just fans it out across many rows efficiently:
 *
 * - The DDF candidate pool is fetched once per unique carrier (fetchDdfCandidatePool),
 *   not once per row, then scored per-row in memory (scoreDdfCandidatesFromPool).
 * - AI calls run with bounded concurrency rather than serially — NVIDIA alone has shown
 *   20-90+ second latency per call, so a batch of even a dozen rows run one-at-a-time
 *   could take many minutes; a handful in flight at once keeps total wall-clock time sane
 *   regardless of which provider is active.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { fetchDdfCandidatePool, scoreDdfCandidatesFromPool, type ScoredDdfCandidate } from '@/lib/leadMatchCandidates'
import { aiMatchConfigured, suggestDdfMatch } from '@/lib/aiLeadMatch'
import type { DdfCarrierRecord } from '@/lib/dealTracker'

export const dynamic = 'force-dynamic'

const MAX_ROWS = 200
const CONCURRENCY = 4

type BatchRowInput = { rowKey: string; name: string; carrier: string; agent: string | null }

type BatchRowResult = {
  rowKey: string
  recordId: string | null
  confidence: number
  matchedName: boolean
  matchedAgent: boolean
  matchedCarrier: boolean
  reasoning: string
  record: ReturnType<typeof toCandidateShape> | null
  topCandidates: ReturnType<typeof toCandidateShape>[]
  usedWiderWindow: boolean
}

function toCandidateShape(c: ScoredDdfCandidate) {
  return {
    id: c.id ?? null,
    insuredName: c.insured_name ?? null,
    callCenter: c.lead_vendor ?? c.lead_vendor_name ?? null,
    phoneNumber: c.client_phone_number ?? c.phone_number ?? null,
    draftDate: c.draft_date ?? null,
    agent: c.licensed_agent_account ?? null,
    score: c.score,
  }
}

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving input order in the result array. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { rows?: BatchRowInput[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const rows = Array.isArray(body.rows) ? body.rows.slice(0, MAX_ROWS) : []
  if (rows.length === 0) return NextResponse.json({ results: [] })

  const emptyResult = (rowKey: string, reasoning: string): BatchRowResult => ({
    rowKey,
    recordId: null,
    confidence: 0,
    matchedName: false,
    matchedAgent: false,
    matchedCarrier: false,
    reasoning,
    record: null,
    topCandidates: [],
    usedWiderWindow: false,
  })

  if (!aiMatchConfigured()) {
    return NextResponse.json({
      results: rows.map((r) => emptyResult(r.rowKey, 'AI matching is not configured (missing NVIDIA_API_KEY).')),
    })
  }

  const { client: ddf, table } = getDdfClient('new')

  // Fetch the DDF candidate pool once per unique carrier, reused across every row sharing it.
  const carrierPools = new Map<string, Promise<DdfCarrierRecord[]>>()
  const poolForCarrier = (carrier: string) => {
    if (!carrierPools.has(carrier)) {
      carrierPools.set(carrier, fetchDdfCandidatePool(ddf, table, carrier))
    }
    return carrierPools.get(carrier)!
  }

  const results = await mapWithConcurrency(rows, CONCURRENCY, async (row): Promise<BatchRowResult> => {
    const name = String(row.name ?? '').trim() || null
    const carrier = String(row.carrier ?? '').trim() || null
    const agent = row.agent != null ? String(row.agent).trim() || null : null

    if (!name || !carrier) return emptyResult(row.rowKey, 'Name and carrier are required.')

    const pool = await poolForCarrier(carrier)
    const { candidates: scored, usedWiderWindow } = scoreDdfCandidatesFromPool(pool, { name, agent, carrier })

    if (scored.length === 0) {
      return emptyResult(
        row.rowKey,
        `No Daily Deal Flow records for carrier "${carrier}"${agent ? ` and agent "${agent}"` : ''} in the last 10 days have a name resembling "${name}".`
      )
    }

    const topCandidates = scored.slice(0, 3).map(toCandidateShape)
    const candidateById = new Map(scored.map((c) => [String(c.id ?? ''), c]))
    const suggestion = await suggestDdfMatch(
      { name, carrier, agent },
      scored.map((c) => ({
        recordId: String(c.id ?? ''),
        insuredName: c.insured_name ?? null,
        agent: c.licensed_agent_account ?? null,
        carrier: c.carrier ?? null,
      }))
    )

    if (!suggestion) {
      return {
        ...emptyResult(row.rowKey, 'AI suggestion unavailable — pick from the top matches below.'),
        topCandidates,
        usedWiderWindow,
      }
    }

    const matchedRecord = suggestion.recordId ? candidateById.get(suggestion.recordId) : null

    return {
      rowKey: row.rowKey,
      ...suggestion,
      record: matchedRecord ? toCandidateShape(matchedRecord) : null,
      topCandidates,
      usedWiderWindow,
    }
  })

  return NextResponse.json({ results })
}
