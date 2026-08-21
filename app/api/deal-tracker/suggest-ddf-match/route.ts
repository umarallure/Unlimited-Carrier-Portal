/**
 * AI-assisted suggestion for an "Incomplete" deal_tracker upload row — the
 * upload-time DDF name matcher (matchDdfNamesToRecords) already ran and found
 * nothing. This route does its OWN broader server-side search
 * (findDdfAiCandidates) rather than only searching whatever the client's local
 * "View DDF" panel already found — that panel uses a strict
 * edit-distance<=2-on-both-name-parts filter, the same tier the upload matcher
 * itself already tried and failed, so it very often has nothing for the AI to
 * search either.
 *
 * Candidate pool: every DDF record for the carrier AND the same writing agent
 * (hard filters, not soft bonuses — a record for a different agent is never a
 * candidate at all) within the last 7 days, widening once to 10 days if that's
 * empty. See lib/leadMatchCandidates.ts's findDdfAiCandidates/
 * scoreDdfCandidatesFromPool for why this replaced the old carrier-only,
 * agent-as-bonus search: narrower and more precise, and shared with the batch
 * "Ask AI on all Incomplete rows" flow so both paths behave identically.
 *
 * Never writes anything: the response includes the suggested daily_deal_flow
 * record's own details so the client can render it standalone (it may not be one
 * of the rows shown in the local "View DDF" list) and apply it with one click —
 * "using" it just fills the row's Call Center/Phone/Effective Date inputs, same
 * as picking a candidate by hand.
 *
 * The response also always includes topCandidates (the top-ranked scored records,
 * independent of what the AI did with them) — the AI call is one more point of
 * failure on top of an already-flaky NVIDIA/Fireworks endpoint, so a human must be
 * able to fall back to "pick from the best-scored options" even when the model
 * declines, hallucinates, times out, or errors outright.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { findDdfAiCandidates, type ScoredDdfCandidate } from '@/lib/leadMatchCandidates'
import { aiMatchConfigured, suggestDdfMatch } from '@/lib/aiLeadMatch'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { name?: string; carrier?: string; agent?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const name = String(body.name ?? '').trim() || null
  const carrier = String(body.carrier ?? '').trim() || null
  const agent = body.agent != null ? String(body.agent).trim() || null : null

  const toCandidateShape = (c: ScoredDdfCandidate) => ({
    id: c.id ?? null,
    insuredName: c.insured_name ?? null,
    callCenter: c.lead_vendor ?? c.lead_vendor_name ?? null,
    phoneNumber: c.client_phone_number ?? c.phone_number ?? null,
    draftDate: c.draft_date ?? null,
    agent: c.licensed_agent_account ?? null,
    score: c.score,
  })

  const emptyResponse = (
    reasoning: string,
    topCandidates: ReturnType<typeof toCandidateShape>[] = [],
    usedWiderWindow = false
  ) =>
    NextResponse.json({
      recordId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning,
      record: null,
      topCandidates,
      usedWiderWindow,
    })

  if (!aiMatchConfigured()) {
    return emptyResponse('AI matching is not configured (missing NVIDIA_API_KEY).')
  }
  if (!name || !carrier) {
    return emptyResponse('Name and carrier are required.')
  }

  // Same DDF source the upload matcher itself always uses (see
  // bulkFetchDailyDealFlowInfo in lib/dealTracker.ts) — not the deal-date-based
  // legacy/new cutover the manual diagnostic panel uses, so this always searches
  // wherever the live data actually is.
  const { client: ddf, table } = getDdfClient('new')
  const { candidates: scored, usedWiderWindow } = await findDdfAiCandidates(ddf, table, { name, agent, carrier })

  if (scored.length === 0) {
    return emptyResponse(
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
    return emptyResponse('AI suggestion unavailable — pick from the top matches below.', topCandidates, usedWiderWindow)
  }

  const matchedRecord = suggestion.recordId ? candidateById.get(suggestion.recordId) : null

  return NextResponse.json({
    ...suggestion,
    record: matchedRecord ? toCandidateShape(matchedRecord) : null,
    topCandidates,
    usedWiderWindow,
  })
}
