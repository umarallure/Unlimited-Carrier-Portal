/**
 * Invoicing Audit – server-side join between the NEW Daily Deal Flow Supabase
 * (service-role only, never exposed to the browser) and our accounting
 * `deal_tracker` table.
 *
 * Flow:
 *  1. Pull every DDF lead whose `date` falls inside the invoice period and
 *     whose `status` is Pending Approval.
 *  2. Resolve each lead's real policy id via the `leads` table (same NEW DDF
 *     project): join daily_deal_flow.submission_id -> leads.submission_id and
 *     read leads.policy_id. DDF's own policy_number is unreliable.
 *  3. Look the resolved policy ids up in `deal_tracker` (by policy_number) and
 *     attach ghl_stage / carrier_status / cc_value so we can verify what the
 *     carriers actually did with the leads the call centers generated.
 *
 * POST body: { dateFrom: 'YYYY-MM-DD', dateTo: 'YYYY-MM-DD' }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient, sourceForLog } from '@/lib/ddfSource'

export const dynamic = 'force-dynamic'

const DDF_PAGE_SIZE = 1000
const DDF_MAX_ROWS = 100_000
const DEAL_TRACKER_IN_CHUNK = 200
const LEADS_IN_CHUNK = 200
const LEADS_TABLE = process.env.NEW_DDF_LEADS_TABLE || 'leads'
const DDF_AUDIT_STATUS = 'Pending Approval'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type DdfLead = {
  submission_id: string | null
  date: string | null
  insured_name: string | null
  lead_vendor: string | null
  agent: string | null
  buffer_agent: string | null
  licensed_agent_account: string | null
  carrier: string | null
  product_type: string | null
  monthly_premium: number | null
  face_amount: number | null
  status: string | null
  call_result: string | null
  placement_status: string | null
  draft_date: string | null
}

type DealTrackerMatch = {
  ghl_stage: string | null
  carrier_status: string | null
  cc_value: number | null
  carrier: string | null
  name: string | null
  effective_date: string | null
}

type AuditStatus = 'matched' | 'no_deal_tracker' | 'no_policy'

type AuditRow = DdfLead & {
  policy_number: string | null
  audit_status: AuditStatus
  audit_note: string
  dt_ghl_stage: string | null
  dt_carrier_status: string | null
  dt_cc_value: number | null
  dt_carrier: string | null
  dt_name: string | null
  dt_effective_date: string | null
}

function normalizePolicy(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(n) ? n : null
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * GET /api/invoicing-audit?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 * Returns the distinct lead vendors (call centers) that generated leads in the
 * period, so the audit can be scoped to one call center before it runs.
 */
export async function GET(request: NextRequest) {
  const dateFrom = String(request.nextUrl.searchParams.get('dateFrom') ?? '').trim()
  const dateTo = String(request.nextUrl.searchParams.get('dateTo') ?? '').trim()
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    return NextResponse.json(
      { error: 'dateFrom and dateTo are required (YYYY-MM-DD).' },
      { status: 400 }
    )
  }
  if (dateFrom > dateTo) {
    return NextResponse.json({ error: 'dateFrom must be on or before dateTo.' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  try {
    const { client: ddf, table } = getDdfClient('new')
    const vendors = new Set<string>()
    let from = 0
    while (from < DDF_MAX_ROWS) {
      const to = from + DDF_PAGE_SIZE - 1
      const { data, error } = await ddf
        .from(table)
        .select('lead_vendor')
        .eq('status', DDF_AUDIT_STATUS)
        .gte('date', dateFrom)
        .lte('date', dateTo)
        .order('lead_vendor', { ascending: true })
        .range(from, to)

      if (error) throw new Error(`DDF query failed: ${error.message}`)
      const page = (data ?? []) as unknown as { lead_vendor: string | null }[]
      for (const r of page) {
        const v = String(r.lead_vendor ?? '').trim()
        if (v) vendors.add(v)
      }
      if (page.length < DDF_PAGE_SIZE) break
      from += DDF_PAGE_SIZE
    }
    return NextResponse.json({
      leadVendors: Array.from(vendors).sort((a, b) => a.localeCompare(b)),
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to load lead vendors.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  let body: { dateFrom?: string; dateTo?: string; leadVendor?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const dateFrom = String(body.dateFrom ?? '').trim()
  const dateTo = String(body.dateTo ?? '').trim()
  const leadVendor = String(body.leadVendor ?? '').trim()
  const scopeVendor = leadVendor && leadVendor.toLowerCase() !== 'all' ? leadVendor : null
  if (!DATE_RE.test(dateFrom) || !DATE_RE.test(dateTo)) {
    return NextResponse.json(
      { error: 'dateFrom and dateTo are required (YYYY-MM-DD).' },
      { status: 400 }
    )
  }
  if (dateFrom > dateTo) {
    return NextResponse.json({ error: 'dateFrom must be on or before dateTo.' }, { status: 400 })
  }

  // Accounting Supabase (carries the signed-in user's session for deal_tracker / RLS).
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  // 1) Pull DDF leads for the invoice period from the NEW DDF project.
  const leads: DdfLead[] = []
  try {
    const { client: ddf, table } = getDdfClient('new')
    let from = 0
    while (from < DDF_MAX_ROWS) {
      const to = from + DDF_PAGE_SIZE - 1
      let query = ddf
        .from(table)
        .select(
          'submission_id, date, insured_name, lead_vendor, agent, buffer_agent, licensed_agent_account, carrier, product_type, monthly_premium, face_amount, status, call_result, placement_status, draft_date'
        )
        .eq('status', DDF_AUDIT_STATUS)
        .gte('date', dateFrom)
        .lte('date', dateTo)
      if (scopeVendor) query = query.eq('lead_vendor', scopeVendor)
      const { data, error } = await query
        .order('date', { ascending: true })
        .order('submission_id', { ascending: true })
        .range(from, to)

      if (error) throw new Error(`DDF query failed: ${error.message}`)
      const page = (data ?? []) as unknown as DdfLead[]
      leads.push(...page)
      if (page.length < DDF_PAGE_SIZE) break
      from += DDF_PAGE_SIZE
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to load DDF leads.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // 2) Resolve each DDF submission to its real policy id via the `leads`
  //    table (same NEW DDF project as daily_deal_flow). DDF's own
  //    policy_number is unreliable; leads.policy_id is the source of truth.
  const submissionIds = Array.from(
    new Set(leads.map((l) => String(l.submission_id ?? '').trim()).filter(Boolean))
  )

  const policyBySubmission = new Map<string, string>()
  try {
    const { client: ddf } = getDdfClient('new')
    for (const part of chunk(submissionIds, LEADS_IN_CHUNK)) {
      const { data, error } = await ddf
        .from(LEADS_TABLE)
        .select('submission_id, policy_id')
        .in('submission_id', part)

      if (error) throw new Error(`leads query failed: ${error.message}`)
      for (const raw of (data ?? []) as Record<string, unknown>[]) {
        const sid = String(raw.submission_id ?? '').trim()
        const pid = normalizePolicy(raw.policy_id)
        if (!sid || !pid || policyBySubmission.has(sid)) continue // first non-empty wins
        policyBySubmission.set(sid, pid)
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to look up leads.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // 3) Look up every distinct resolved policy id in our accounting deal_tracker.
  const distinctPolicies = Array.from(new Set(policyBySubmission.values()))

  const dealTrackerByPolicy = new Map<string, DealTrackerMatch>()
  try {
    for (const part of chunk(distinctPolicies, DEAL_TRACKER_IN_CHUNK)) {
      const { data, error } = await supabase
        .from('deal_tracker')
        .select('policy_number, ghl_stage, carrier_status, cc_value, carrier, name, effective_date, updated_at')
        .in('policy_number', part)
        .order('updated_at', { ascending: false, nullsFirst: false })

      if (error) throw new Error(`deal_tracker query failed: ${error.message}`)
      for (const raw of (data ?? []) as Record<string, unknown>[]) {
        const key = normalizePolicy(raw.policy_number)
        if (!key || dealTrackerByPolicy.has(key)) continue // first (most-recent) wins
        dealTrackerByPolicy.set(key, {
          ghl_stage: raw.ghl_stage != null ? String(raw.ghl_stage) : null,
          carrier_status: raw.carrier_status != null ? String(raw.carrier_status) : null,
          cc_value: toNumber(raw.cc_value),
          carrier: raw.carrier != null ? String(raw.carrier) : null,
          name: raw.name != null ? String(raw.name) : null,
          effective_date: raw.effective_date != null ? String(raw.effective_date) : null,
        })
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to look up deal_tracker.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // 4) Build the audited rows + summary.
  let matched = 0
  let noDealTracker = 0
  let noPolicy = 0
  let totalMonthlyPremium = 0
  let totalCcValue = 0
  const carrierSet = new Set<string>()
  const leadVendorSet = new Set<string>()

  const rows: AuditRow[] = leads.map((lead) => {
    const sid = String(lead.submission_id ?? '').trim()
    const policy = sid ? (policyBySubmission.get(sid) ?? '') : ''
    const dt = policy ? dealTrackerByPolicy.get(policy) : undefined
    if (lead.carrier) carrierSet.add(lead.carrier)
    if (lead.lead_vendor) leadVendorSet.add(lead.lead_vendor)
    const mp = toNumber(lead.monthly_premium)
    if (mp != null) totalMonthlyPremium += mp

    let audit_status: AuditStatus
    let audit_note: string
    if (!policy) {
      audit_status = 'no_policy'
      audit_note = 'No update from carrier yet'
      noPolicy += 1
    } else if (!dt) {
      audit_status = 'no_deal_tracker'
      audit_note = 'Policy # not found in Deal Tracker'
      noDealTracker += 1
    } else {
      audit_status = 'matched'
      audit_note = 'Matched in Deal Tracker'
      matched += 1
      if (dt.cc_value != null) totalCcValue += dt.cc_value
    }

    return {
      ...lead,
      policy_number: policy || null,
      audit_status,
      audit_note,
      dt_ghl_stage: dt?.ghl_stage ?? null,
      dt_carrier_status: dt?.carrier_status ?? null,
      dt_cc_value: dt?.cc_value ?? null,
      dt_carrier: dt?.carrier ?? null,
      dt_name: dt?.name ?? null,
      dt_effective_date: dt?.effective_date ?? null,
    }
  })

  return NextResponse.json({
    dateFrom,
    dateTo,
    leadVendor: scopeVendor,
    source: sourceForLog('new'),
    summary: {
      totalLeads: rows.length,
      withPolicy: matched + noDealTracker,
      matched,
      noDealTracker,
      noPolicy,
      distinctPolicies: distinctPolicies.length,
      totalMonthlyPremium,
      totalCcValue,
      carriers: Array.from(carrierSet).sort((a, b) => a.localeCompare(b)),
      leadVendors: Array.from(leadVendorSet).sort((a, b) => a.localeCompare(b)),
    },
    rows,
  })
}
