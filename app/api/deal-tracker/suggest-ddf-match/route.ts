/**
 * AI-assisted suggestion for an "Incomplete" deal_tracker upload row — the
 * upload-time DDF name matcher (matchDdfNamesToRecords) already ran and found
 * nothing. Unlike an earlier version of this route, this does its OWN broader
 * server-side search (getDdfRecordsForCarrier + scoreDdfCandidates) rather than
 * only searching whatever the client's local "View DDF" panel already found —
 * that panel uses a strict edit-distance<=2-on-both-name-parts filter, the same
 * tier the upload matcher itself already tried and failed, so it very often has
 * nothing for the AI to search either. This route's candidate pool is every DDF
 * record for the carrier, scored more permissively (name required, agent/carrier
 * as bonuses) before being handed to the LLM.
 *
 * Never writes anything: the response includes the suggested daily_deal_flow
 * record's own details so the client can render it standalone (it may not be one
 * of the rows shown in the local "View DDF" list) and apply it with one click —
 * "using" it just fills the row's Call Center/Phone/Effective Date inputs, same
 * as picking a candidate by hand.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { getDdfRecordsForCarrier } from '@/lib/dealTracker'
import { scoreDdfCandidates } from '@/lib/leadMatchCandidates'
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

  const emptyResponse = (reasoning: string) =>
    NextResponse.json({
      recordId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning,
      record: null,
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
  const records = await getDdfRecordsForCarrier(ddf, carrier, table)
  const scored = scoreDdfCandidates({ name, agent, carrier }, records, 8)

  if (scored.length === 0) {
    return emptyResponse(`No Daily Deal Flow records for carrier "${carrier}" have a name resembling "${name}".`)
  }

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
    return emptyResponse('AI suggestion unavailable — pick manually.')
  }

  const matchedRecord = suggestion.recordId ? candidateById.get(suggestion.recordId) : null

  return NextResponse.json({
    ...suggestion,
    record: matchedRecord
      ? {
          id: matchedRecord.id ?? null,
          insuredName: matchedRecord.insured_name ?? null,
          callCenter: matchedRecord.lead_vendor ?? matchedRecord.lead_vendor_name ?? null,
          phoneNumber: matchedRecord.client_phone_number ?? matchedRecord.phone_number ?? null,
          draftDate: matchedRecord.draft_date ?? null,
          agent: matchedRecord.licensed_agent_account ?? null,
        }
      : null,
  })
}
