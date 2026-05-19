/**
 * Invoicing Audit – Drafts tab.
 *
 * Two modes (GET only, it reads server state):
 *
 *   • List   (no ?id)      → every saved invoice draft that has not been paid
 *                            yet (rows in `invoicing_drafts`), for the picker.
 *   • Detail (?id=<draft>) → that one saved draft returned EXACTLY as it sits
 *                            in the snapshot (call-center groups, policy rows,
 *                            totals), with each policy enriched with its
 *                            current Deal Tracker status and its full
 *                            invoicing payment history.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { InvoiceDraftSnapshot, InvoicePolicyDraft } from '@/lib/invoicing'

export const dynamic = 'force-dynamic'

const IN_CHUNK = 200

type PaymentEvent = {
  batch_id: string
  paid_at: string | null
  period: string
  amount: number | null
  gross_amount: number | null
  status: string | null
}

type CommissionEvent = {
  date: string | null
  advance_amount: number | null
  charge_back_amount: number | null
  carrier: string | null
}

type PolicyAudit = {
  dt_ghl_stage: string | null
  dt_carrier_status: string | null
  dt_effective_date: string | null
  dt_cc_value: number | null
  dt_name: string | null
  payments: PaymentEvent[]
  payment_count: number
  total_paid: number
  last_paid_at: string | null
  commissions: CommissionEvent[]
}

type AuditedPolicy = {
  policy_number: string
  policy_name: string | null
  carrier: string | null
  call_center: string | null
  latest_invoicing_status: string | null
  gross_net: number | null
  cc_net: number | null
  audit: PolicyAudit
}

type AuditedGroup = {
  call_center: string
  gross_total: number
  cc_invoice_total: number
  policy_count: number
  policies: AuditedPolicy[]
}

/**
 * Match the rest of the invoicing code (lib/invoicing.ts): strip separators,
 * upper-case, and drop leading zeros for all-numeric policy numbers so
 * `0112963000` and `112963000` collapse to the same key.
 */
function normalizePolicyNumber(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+/, '') || '0'
}

/** Candidate raw strings to feed Supabase `.in()` so formatting differences still match. */
function policyCandidates(value: unknown): string[] {
  const trimmed = String(value ?? '').trim()
  const alnum = trimmed.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
  const norm = normalizePolicyNumber(value)
  return Array.from(new Set([trimmed, alnum, norm].filter(Boolean)))
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

function periodLabel(start: string | null | undefined, end: string | null | undefined): string {
  const s = String(start ?? '').slice(0, 10)
  const e = String(end ?? '').slice(0, 10)
  if (s && e) return `${s} → ${e}`
  return s || e || '—'
}

type DraftRecord = {
  id: string
  start_date: string | null
  end_date: string | null
  call_center_filter: string | null
  updated_at: string | null
  payload: InvoiceDraftSnapshot | null
}

function callCenterLabel(rec: DraftRecord): string {
  const explicit =
    (rec.call_center_filter && rec.call_center_filter.trim()) ||
    (rec.payload?.selectedCallCenter && String(rec.payload.selectedCallCenter).trim())
  if (explicit && explicit.toLowerCase() !== '__preset_all_call_centers__') return explicit
  const groups = rec.payload?.draft?.groups ?? []
  if (groups.length === 1) return groups[0].callCenter || 'All call centers'
  if (groups.length > 1) return `All call centers (${groups.length})`
  return 'All call centers'
}

function countPolicies(rec: DraftRecord): number {
  const groups = rec.payload?.draft?.groups ?? []
  return groups.reduce((sum, g) => sum + (g.policies?.length ?? 0), 0)
}

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const draftId = String(request.nextUrl.searchParams.get('id') ?? '').trim()

  // ── List mode ──────────────────────────────────────────────────────────
  if (!draftId) {
    try {
      const { data, error } = await supabase
        .from('invoicing_drafts')
        .select('id, start_date, end_date, call_center_filter, updated_at, payload')
        .is('paid_batch_id', null)
        .order('updated_at', { ascending: false })
      if (error) throw new Error(`invoicing_drafts query failed: ${error.message}`)
      const recs = (data ?? []) as unknown as DraftRecord[]
      return NextResponse.json({
        drafts: recs.map((rec) => ({
          id: String(rec.id),
          startDate: rec.start_date,
          endDate: rec.end_date,
          period: periodLabel(rec.start_date, rec.end_date),
          callCenter: callCenterLabel(rec),
          updatedAt: rec.updated_at,
          policyCount: countPolicies(rec),
        })),
      })
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Failed to load saved invoice drafts.'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // ── Detail mode ────────────────────────────────────────────────────────
  let rec: DraftRecord
  try {
    const { data, error } = await supabase
      .from('invoicing_drafts')
      .select('id, start_date, end_date, call_center_filter, updated_at, payload')
      .eq('id', draftId)
      .maybeSingle()
    if (error) throw new Error(`invoicing_drafts query failed: ${error.message}`)
    if (!data) {
      return NextResponse.json({ error: 'Saved draft not found.' }, { status: 404 })
    }
    rec = data as unknown as DraftRecord
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to load the saved draft.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  const draft = rec.payload?.draft
  const groups = draft?.groups ?? []
  // Candidate raw strings for the `.in()` queries (handles leading-zero /
  // separator differences), bucketed back by the canonical normalized key.
  const lookupCandidates = Array.from(
    new Set(
      groups.flatMap((g) =>
        (g.policies ?? []).flatMap((p: InvoicePolicyDraft) => policyCandidates(p.policyNumber))
      )
    )
  )

  // Current Deal Tracker status for each policy (most-recent row wins).
  const dealTrackerByPolicy = new Map<
    string,
    { ghl_stage: string | null; carrier_status: string | null; effective_date: string | null; cc_value: number | null; name: string | null }
  >()
  try {
    for (const part of chunk(lookupCandidates, IN_CHUNK)) {
      if (part.length === 0) continue
      const { data, error } = await supabase
        .from('deal_tracker')
        .select('policy_number, ghl_stage, carrier_status, effective_date, cc_value, name, updated_at')
        .in('policy_number', part)
        .order('updated_at', { ascending: false, nullsFirst: false })
      if (error) throw new Error(`deal_tracker query failed: ${error.message}`)
      for (const raw of (data ?? []) as Record<string, unknown>[]) {
        const key = normalizePolicyNumber(raw.policy_number)
        if (!key || dealTrackerByPolicy.has(key)) continue
        dealTrackerByPolicy.set(key, {
          ghl_stage: raw.ghl_stage != null ? String(raw.ghl_stage) : null,
          carrier_status: raw.carrier_status != null ? String(raw.carrier_status) : null,
          effective_date: raw.effective_date != null ? String(raw.effective_date) : null,
          cc_value: toNumber(raw.cc_value),
          name: raw.name != null ? String(raw.name) : null,
        })
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to look up deal_tracker.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Full invoicing history from `invoicing_status_history` – the canonical
  // per-policy invoicing ledger (every new_sale / repay / chargeback event,
  // including legacy-seeded rows that never went through the new paid flow).
  const batchMeta = new Map<string, { paid_at: string | null; period: string }>()
  const paymentsByPolicy = new Map<string, PaymentEvent[]>()
  try {
    for (const part of chunk(lookupCandidates, IN_CHUNK)) {
      if (part.length === 0) continue
      const { data, error } = await supabase
        .from('invoicing_status_history')
        .select('batch_id, policy_number, invoicing_status, effective_date, week_of, lead_value, created_at')
        .in('policy_number', part)
      if (error) throw new Error(`invoicing_status_history query failed: ${error.message}`)
      const events = (data ?? []) as Record<string, unknown>[]

      const missingBatchIds = Array.from(
        new Set(
          events
            .map((l) => String(l.batch_id ?? '').trim())
            .filter((id) => id && !batchMeta.has(id))
        )
      )
      for (const batchPart of chunk(missingBatchIds, IN_CHUNK)) {
        if (batchPart.length === 0) continue
        const { data: batches, error: batchError } = await supabase
          .from('invoicing_batches')
          .select('id, paid_at, start_date, end_date')
          .in('id', batchPart)
        if (batchError) throw new Error(`invoicing_batches query failed: ${batchError.message}`)
        for (const b of (batches ?? []) as Record<string, unknown>[]) {
          const id = String(b.id ?? '').trim()
          if (!id) continue
          batchMeta.set(id, {
            paid_at: b.paid_at != null ? String(b.paid_at) : null,
            period: periodLabel(b.start_date as string, b.end_date as string),
          })
        }
      }

      for (const l of events) {
        const key = normalizePolicyNumber(l.policy_number)
        if (!key) continue
        const batchId = String(l.batch_id ?? '').trim()
        const meta = batchId ? batchMeta.get(batchId) : undefined
        const effectiveDate = l.effective_date != null ? String(l.effective_date) : null
        const createdAt = l.created_at != null ? String(l.created_at) : null
        // "When" = batch paid date if it went through the paid flow, else the
        // invoicing effective date, else the row's created timestamp.
        const when = meta?.paid_at ?? effectiveDate ?? createdAt
        const list = paymentsByPolicy.get(key) ?? []
        list.push({
          batch_id: batchId,
          paid_at: when,
          period: meta?.period ?? (l.week_of != null ? String(l.week_of) : effectiveDate ?? '—'),
          amount: toNumber(l.lead_value),
          gross_amount: null,
          status: l.invoicing_status != null ? String(l.invoicing_status) : null,
        })
        paymentsByPolicy.set(key, list)
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to look up invoicing history.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Commission Tracker – every commission event recorded against the policy.
  // A policy can legitimately have multiple commission rows (e.g. advance +
  // subsequent payments / chargebacks); we list them all.
  const commissionsByPolicy = new Map<string, CommissionEvent[]>()
  try {
    for (const part of chunk(lookupCandidates, IN_CHUNK)) {
      if (part.length === 0) continue
      const { data, error } = await supabase
        .from('commission_tracker')
        .select('policy_number, date, advance_amount, charge_back_amount, carrier')
        .in('policy_number', part)
        .order('date', { ascending: false })
      if (error) throw new Error(`commission_tracker query failed: ${error.message}`)
      for (const raw of (data ?? []) as Record<string, unknown>[]) {
        const key = normalizePolicyNumber(raw.policy_number)
        if (!key) continue
        const list = commissionsByPolicy.get(key) ?? []
        list.push({
          date: raw.date != null ? String(raw.date) : null,
          advance_amount: toNumber(raw.advance_amount),
          charge_back_amount: toNumber(raw.charge_back_amount),
          carrier: raw.carrier != null ? String(raw.carrier) : null,
        })
        commissionsByPolicy.set(key, list)
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Failed to look up commission_tracker.'
    return NextResponse.json({ error: message }, { status: 500 })
  }

  // Stitch the audit details onto the draft, preserving its exact structure.
  const auditedGroups: AuditedGroup[] = groups.map((g) => ({
    call_center: g.callCenter,
    gross_total: toNumber(g.grossTotal) ?? 0,
    cc_invoice_total: toNumber(g.ccInvoiceTotal) ?? 0,
    policy_count: g.policies?.length ?? 0,
    policies: (g.policies ?? []).map((p: InvoicePolicyDraft): AuditedPolicy => {
      const key = normalizePolicyNumber(p.policyNumber)
      const dt = dealTrackerByPolicy.get(key)
      const payments = (paymentsByPolicy.get(key) ?? []).slice().sort((a, b) => {
        const ta = a.paid_at ? new Date(a.paid_at).getTime() : 0
        const tb = b.paid_at ? new Date(b.paid_at).getTime() : 0
        return tb - ta
      })
      const commissions = (commissionsByPolicy.get(key) ?? []).slice().sort((a, b) => {
        const ta = a.date ? new Date(a.date).getTime() : 0
        const tb = b.date ? new Date(b.date).getTime() : 0
        return tb - ta
      })
      const totalPaid = payments.reduce((sum, ev) => sum + (ev.amount ?? 0), 0)
      return {
        policy_number: p.policyNumber,
        policy_name: p.policyName ?? null,
        carrier: p.carrier ?? null,
        call_center: p.callCenter ?? g.callCenter ?? null,
        latest_invoicing_status: p.latestInvoicingStatus ?? null,
        gross_net: toNumber(p.grossNet),
        cc_net: toNumber(p.ccNet),
        audit: {
          dt_ghl_stage: dt?.ghl_stage ?? null,
          dt_carrier_status: dt?.carrier_status ?? null,
          dt_effective_date: dt?.effective_date ?? null,
          dt_cc_value: dt?.cc_value ?? null,
          dt_name: dt?.name ?? null,
          payments,
          payment_count: payments.length,
          total_paid: Math.round(totalPaid * 100) / 100,
          last_paid_at: payments.find((ev) => ev.paid_at)?.paid_at ?? null,
          commissions,
        },
      }
    }),
  }))

  return NextResponse.json({
    meta: {
      id: String(rec.id),
      period: periodLabel(rec.start_date, rec.end_date),
      callCenter: callCenterLabel(rec),
      updatedAt: rec.updated_at,
    },
    groups: auditedGroups,
    grossGrandTotal: toNumber(draft?.grossGrandTotal) ?? 0,
    ccGrandTotal: toNumber(draft?.ccGrandTotal) ?? 0,
  })
}
