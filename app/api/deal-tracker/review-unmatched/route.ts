/**
 * Lists deal_tracker policies that the exact-key CRM matcher (findLeadsForPolicyNumbers
 * in lib/leadNotesSync.ts) couldn't attach to a lead, with a scored candidate shortlist
 * for each — the read side of the AI-assisted unmatched-lead review. No AI call here;
 * that's a separate lazy call from the client (see suggest-lead-match/route.ts) so this
 * list stays cheap to load.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { findLeadsForPolicyNumbers, fetchUnattachedLeadCandidates } from '@/lib/leadNotesSync'
import { scoreCandidates } from '@/lib/leadMatchCandidates'

export const dynamic = 'force-dynamic'

const DEAL_TRACKER_SCAN_LIMIT = 5000
const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 50

type DealTrackerScanRow = {
  id: string
  policy_number: string
  name: string | null
  carrier: string | null
  deal_creation_date: string | null
  effective_date: string | null
  sales_agent: string | null
  deal_value: number | null
  ghl_stage: string | null
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(searchParams.get('pageSize') ?? String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  )

  const { data: dealRows, error: dealError } = await supabase
    .from('deal_tracker')
    .select('id, policy_number, name, carrier, deal_creation_date, effective_date, sales_agent, deal_value, ghl_stage')
    .not('policy_number', 'is', null)
    .order('deal_creation_date', { ascending: false })
    .limit(DEAL_TRACKER_SCAN_LIMIT)

  if (dealError) return NextResponse.json({ error: dealError.message }, { status: 500 })

  // If we hit the cap, older rows (past this scan window) weren't examined at all —
  // surface that rather than silently presenting a total that looks complete.
  const scanLimitReached = (dealRows ?? []).length >= DEAL_TRACKER_SCAN_LIMIT

  const rows = ((dealRows ?? []) as DealTrackerScanRow[]).filter(
    (r) => r.policy_number && r.policy_number.trim()
  )
  const policyNumbers = Array.from(new Set(rows.map((r) => r.policy_number.trim())))

  const { client: ddf } = getDdfClient('new')
  const { unmatchedPolicyNumbers } = await findLeadsForPolicyNumbers(ddf, policyNumbers)
  const unmatchedSet = new Set(unmatchedPolicyNumbers)

  const unmatchedRows = rows.filter((r) => unmatchedSet.has(r.policy_number.trim()))
  const total = unmatchedRows.length
  const start = (page - 1) * pageSize
  const pageRows = unmatchedRows.slice(start, start + pageSize)

  const candidatePool = pageRows.length > 0 ? await fetchUnattachedLeadCandidates(ddf) : []

  const results = pageRows.map((r) => ({
    id: r.id,
    policyNumber: r.policy_number.trim(),
    name: r.name,
    carrier: r.carrier,
    dealCreationDate: r.deal_creation_date,
    effectiveDate: r.effective_date,
    salesAgent: r.sales_agent,
    dealValue: r.deal_value,
    ghlStage: r.ghl_stage,
    candidates: scoreCandidates({ name: r.name, agent: r.sales_agent, carrier: r.carrier }, candidatePool, 5).map((c) => ({
      leadId: c.id,
      firstName: c.first_name,
      lastName: c.last_name,
      phone: c.phone,
      agent: c.licensed_agent_account,
      carrier: c.carrier,
      monthlyPremium: c.monthly_premium,
      draftDate: c.draft_date,
      score: c.score,
    })),
  }))

  return NextResponse.json({ total, page, pageSize, rows: results, scanLimitReached })
}
