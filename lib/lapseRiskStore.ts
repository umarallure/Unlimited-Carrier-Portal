/**
 * Persistence for Lapse Risk Detection runs.
 *
 * Each upload is a snapshot: a `lapse_risk_runs` row (carrying the grace period
 * DERIVED from that file, so the numbers can be explained later) plus one
 * `lapse_risk_policies` row per flagged policy.
 */

import { supabase } from './supabaseClient'
import type { FlaggedPolicy, LapseRiskResult, RiskBucket, RiskTier } from './lapseRisk'

export const RUNS_TABLE = 'lapse_risk_runs'
export const POLICIES_TABLE = 'lapse_risk_policies'

const INSERT_CHUNK = 500

export interface LapseRiskRun {
  id: string
  source_file: string | null
  snapshot_date: string
  grace_by_company: Record<string, { grace_days: number; sample: number; confidence: number }>
  default_grace_days: number
  total_rows: number
  active_count: number
  at_risk_count: number
  critical_count: number
  high_count: number
  early_count: number
  nsf_suspect_count: number
  pending_first_draft_count: number
  annual_premium_at_risk: number
  created_at: string
  created_by_email: string | null
}

export interface SavedPolicy extends Omit<FlaggedPolicy, 'bucket' | 'tier'> {
  id: string
  run_id: string
  bucket: RiskBucket
  tier: RiskTier | null
}

function chunk<T>(items: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Persist a detection result as a new run.
 *
 * The run row is written first so the policies have a parent; if the policy
 * insert then fails, the run is deleted rather than left as an empty snapshot
 * that would read as "we checked and found nothing".
 */
export async function saveLapseRiskRun(input: {
  result: LapseRiskResult
  sourceFile: string
}): Promise<{ runId: string; savedPolicies: number }> {
  const { result, sourceFile } = input
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: runRow, error: runError } = await supabase
    .from(RUNS_TABLE)
    .insert({
      source_file: sourceFile,
      snapshot_date: result.snapshotDate,
      grace_by_company: result.graceByCompany,
      default_grace_days: result.defaultGraceDays,
      total_rows: result.totalRows,
      active_count: result.activeCount,
      at_risk_count: result.atRiskCount,
      critical_count: result.criticalCount,
      high_count: result.highCount,
      early_count: result.earlyCount,
      nsf_suspect_count: result.nsfSuspectCount,
      pending_first_draft_count: result.pendingFirstDraftCount,
      annual_premium_at_risk: result.annualPremiumAtRisk,
      created_by: user?.id ?? null,
      created_by_email: user?.email ?? null,
    })
    .select('id')
    .single()

  if (runError || !runRow) {
    throw new Error(`Failed to create the run: ${runError?.message ?? 'no row returned'}`)
  }
  const runId = String((runRow as { id: string }).id)

  const payload = result.flagged.map((f) => ({
    run_id: runId,
    bucket: f.bucket,
    company_code: f.company_code,
    policy_number: f.policy_number,
    status_category: f.status_category,
    insured: f.insured,
    phone: f.phone,
    state: f.state,
    agent: f.agent,
    pay_mode: f.pay_mode,
    is_installment: f.is_installment,
    draft_amount: f.draft_amount,
    modal_premium: f.modal_premium,
    annual_premium: f.annual_premium,
    effective_date: f.effective_date,
    paid_to_date: f.paid_to_date,
    last_payment: f.last_payment,
    expected_next_draft: f.expected_next_draft,
    payments_made: f.payments_made,
    days_since_pay: f.days_since_pay,
    days_until_lapse: f.days_until_lapse,
    cycle_days: f.cycle_days,
    tier: f.tier,
    failure_type: f.failure_type,
    logic_one_liner: f.logic_one_liner,
    action_item: f.action_item,
  }))

  try {
    for (const batch of chunk(payload)) {
      const { error } = await supabase
        .from(POLICIES_TABLE)
        .upsert(batch, { onConflict: 'run_id,policy_number' })
      if (error) throw new Error(error.message)
    }
  } catch (err: unknown) {
    await supabase.from(RUNS_TABLE).delete().eq('id', runId)
    throw new Error(
      `Failed to save flagged policies, so the run was rolled back: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  return { runId, savedPolicies: payload.length }
}

/** Runs, newest first. */
export async function listLapseRiskRuns(limit = 50): Promise<LapseRiskRun[]> {
  const { data, error } = await supabase
    .from(RUNS_TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Failed to load runs: ${error.message}`)
  return (data as LapseRiskRun[]) || []
}

/** Flagged policies for one run, in the spec's call-list order. */
export async function listRunPolicies(runId: string): Promise<SavedPolicy[]> {
  const { data, error } = await supabase
    .from(POLICIES_TABLE)
    .select('*')
    .eq('run_id', runId)
    .order('days_until_lapse', { ascending: true, nullsFirst: false })
    .order('annual_premium', { ascending: false })
  if (error) throw new Error(`Failed to load run policies: ${error.message}`)
  return (data as SavedPolicy[]) || []
}

export async function deleteLapseRiskRun(runId: string): Promise<void> {
  // lapse_risk_policies has ON DELETE CASCADE, so the children go with it.
  const { error } = await supabase.from(RUNS_TABLE).delete().eq('id', runId)
  if (error) throw new Error(`Failed to delete run: ${error.message}`)
}

/** Call-list CSV for the current view. */
export function toCallListCsv(rows: SavedPolicy[]): string {
  const headers = [
    'Tier', 'Bucket', 'Failure Type', 'Policy Number', 'Insured', 'Phone', 'State', 'Agent',
    'Pay Mode', 'Draft Amount', 'Annual Premium', 'Effective Date', 'Last Payment',
    'Paid To Date', 'Payments Made', 'Days Since Pay', 'Days Until Lapse', 'Why', 'Action',
  ]
  const cell = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.tier ?? '', r.bucket, r.failure_type, r.policy_number, r.insured, r.phone, r.state, r.agent,
        r.pay_mode, r.draft_amount, r.annual_premium, r.effective_date, r.last_payment,
        r.paid_to_date, r.payments_made, r.days_since_pay, r.days_until_lapse,
        r.logic_one_liner, r.action_item,
      ].map(cell).join(',')
    )
  }
  return lines.join('\n')
}
