/**
 * Lazily requests an AI match suggestion for one unmatched deal_tracker policy —
 * called per-row from the review UI (not eagerly for the whole unmatched list) to
 * keep AI cost/latency bounded to what the reviewer actually looks at. Never writes
 * anything; the caller must separately POST confirm-lead-match after a human picks.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { fetchUnattachedLeadCandidates } from '@/lib/leadNotesSync'
import { scoreCandidates } from '@/lib/leadMatchCandidates'
import { aiMatchConfigured, suggestLeadMatch } from '@/lib/aiLeadMatch'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { id?: string; policyNumber?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const dealId = String(body.id ?? '').trim()
  const policyNumber = String(body.policyNumber ?? '').trim()
  if (!policyNumber) return NextResponse.json({ error: 'policyNumber is required.' }, { status: 400 })

  if (!aiMatchConfigured()) {
    return NextResponse.json({
      leadId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'AI matching is not configured (missing NVIDIA_API_KEY).',
    })
  }

  // Prefer the specific row by id when the client has it — deal_tracker allows
  // duplicate policy_number values (e.g. reissued policies), so an id-less lookup
  // can silently pick the wrong one of two rows sharing the same policy number.
  let dealQuery = supabase.from('deal_tracker').select('policy_number, name, carrier, sales_agent')
  dealQuery = dealId ? dealQuery.eq('id', dealId) : dealQuery.eq('policy_number', policyNumber)
  const { data: dealRows, error: dealError } = await dealQuery.limit(1)

  if (dealError) return NextResponse.json({ error: dealError.message }, { status: 500 })
  const deal = ((dealRows ?? []) as Record<string, unknown>[])[0]
  if (!deal) return NextResponse.json({ error: 'Policy not found in deal_tracker.' }, { status: 404 })

  const { client: ddf } = getDdfClient('new')
  const candidatePool = await fetchUnattachedLeadCandidates(ddf)
  const name = (deal.name as string | null) ?? null
  const carrier = (deal.carrier as string | null) ?? null
  const agent = (deal.sales_agent as string | null) ?? null
  const scored = scoreCandidates({ name, agent, carrier }, candidatePool, 5)

  const suggestion = await suggestLeadMatch(
    { policyNumber, name, carrier, agent },
    scored.map((c) => ({
      leadId: c.id,
      firstName: c.first_name,
      lastName: c.last_name,
      agent: c.licensed_agent_account,
      carrier: c.carrier,
    }))
  )

  if (!suggestion) {
    return NextResponse.json({
      leadId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'AI suggestion unavailable — pick manually.',
    })
  }
  return NextResponse.json(suggestion)
}
