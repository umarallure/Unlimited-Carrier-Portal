// Pure decision logic for the Policy Audit "Missing Commission" check.
// Extracted from app/policy-audit/page.tsx so it can be unit tested without a
// live database — the report's correctness depends on this logic being right
// regardless of what happens to be sitting in any particular environment.

export const ACTIVE_STAGES_NEEDING_COMMISSION = [
  'Active Placed - Paid as Advanced',
  'ACTIVE PLACED - Paid as Advanced',
  'Active Placed - Paid as Earned',
  'Premium Paid - Commission Pending',
]

// Carriers whose commission is expected to key off the policy's ISSUE date
// rather than its effective date. An issue date is, by definition, already in
// the past by the time a policy exists in our system, so these carriers get no
// date gating at all — just active status + a real commission on file.
//
// MOH, Sentinel, and Americo were originally grouped here too, but were moved
// to the effective-date group deliberately (safer default): unlike AMAM, none
// of them have been individually verified to actually pay on issue, and
// mapping-gap checks against fresh carrier data (Sept 2026) found no evidence
// of an AMAM-style "issued but stuck below active-stage" scenario for them —
// so there was no upside to the extra risk of skipping date gating on an
// unconfirmed assumption. AMAM is the only one confirmed directly against
// commission data: commission already exists for a majority of its
// "IssNotPaid" (issued, not yet paid) policies, proving it pays before the
// client's own first payment even clears.
//
// This is a business decision, not something derivable from the code: there's
// no explicit "carrier X pays on date Y" rule anywhere in this codebase
// (checked lib/dealTracker.*.ts, lib/ghlStageResolver.ts,
// lib/commissionTracker.ts — none state a payment-timing rule per carrier).
export const ISSUE_DATE_CARRIER_CODES = new Set(['AMAM'])

// AMAM is checked by its own raw carrier_status rather than ghl_stage.
// Verified against data: AMAM commission already exists for a majority of
// "IssNotPaid" policies, and these policies resolve to "Issued - Pending
// First Draft"/"FDPF..." stages, never the active-stage set. Gating on
// ghl_stage would make them permanently invisible to this report.
// "Pending", "Declined", "Withdrawn", "NotTaken", "Incomplete", "InfNotTaken",
// "NeedReqmnt" are excluded — AMAM hasn't issued those yet (or ever will).
export const AMAM_ISSUED_CARRIER_STATUSES = ['Active', 'IssNotPaid', 'Act-Pastdue', 'Act-Ret Item', 'RPU', 'Terminated']

// Carriers not yet synced into commission_tracker (lib/commissionTracker.ts) —
// for these, "no commission_tracker row" doesn't mean "no commission exists,"
// it means "not checked yet." Surfaced in the UI rather than silently reading 0.
export const MISSING_COMMISSION_UNCOVERED_CARRIER_CODES = new Set(['RNA', 'LIBERTY'])

export type CarrierIdentityRow = {
  carrier: string | null
  carriers: { code: string | null } | null
}

// Some deal_tracker rows have no working carrier_id link (legacy data), so the
// carriers(code) join comes back null even though the free-text `carrier`
// field has a value — and that free-text value isn't consistent (e.g.
// "Sentinel Security Life" vs "Sentinel"). Fall back to matching it directly
// so those rows don't silently fall out of both carrier groups above.
export function resolveCarrierCode(row: CarrierIdentityRow): string | null {
  if (row.carriers?.code) return row.carriers.code
  const raw = (row.carrier || '').toUpperCase()
  if (!raw) return null
  if (raw.includes('MUTUAL OF OMAHA') || raw === 'MOH') return 'MOH'
  if (raw.includes('SENTINEL')) return 'SENTINEL'
  if (raw.includes('AMERICO')) return 'AMERICO'
  if (raw.includes('AMERICAN AMICABLE') || raw.includes('AMAM')) return 'AMAM'
  if (raw.includes('ROYAL NEIGHBORS') || raw === 'RNA') return 'RNA'
  if (raw.includes('LIBERTY')) return 'LIBERTY'
  if (raw.includes('COREBRIDGE')) return 'COREBRIDGE'
  if (raw.includes('AETNA')) return 'AETNA'
  if (raw.includes('AFLAC')) return 'AFLAC'
  if (raw.includes('AMERICAN HOME LIFE') || raw === 'AHL') return 'AHL'
  return raw
}

export function ymdFromDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return String(dateStr).trim().slice(0, 10)
}

export type CommissionDueRow = CarrierIdentityRow & { effective_date: string | null }

// A row is "due" for the missing-commission check when either:
//  - it's an issue-date carrier (no date gating, always due once in an
//    eligible stage/status), or
//  - its effective_date has strictly passed (not today, not future — the
//    carrier hasn't had time to process anything yet if effective_date is
//    today or later).
export function isDueForCommissionCheck(row: CommissionDueRow, todayYmd: string): boolean {
  const code = resolveCarrierCode(row)
  if (code && ISSUE_DATE_CARRIER_CODES.has(code)) return true
  return !!row.effective_date && ymdFromDate(row.effective_date) < todayYmd
}

export function isUncoveredCarrier(row: CarrierIdentityRow): boolean {
  const code = resolveCarrierCode(row)
  return !!code && MISSING_COMMISSION_UNCOVERED_CARRIER_CODES.has(code)
}

export function isAmamIssuedCarrierStatus(carrierStatus: string | null): boolean {
  return !!carrierStatus && AMAM_ISSUED_CARRIER_STATUSES.includes(carrierStatus)
}

// Merge two candidate lists (the ghl_stage-based query and the AMAM
// carrier_status-based query) without duplicating a row that satisfied both.
export function mergeCandidatesDeduped<T extends { id: string }>(main: T[], extra: T[]): T[] {
  const seen = new Set(main.map((r) => r.id))
  return [...main, ...extra.filter((r) => !seen.has(r.id))]
}

// Stages a policy sits in before it has actually been issued (mirrors the
// "Transfer Portal" group in app/policy-audit/page.tsx's CRM_STAGE_GROUPS).
// Any deal_tracker_status_history row whose new_ghl_stage is NOT one of these
// is proof the policy was issued at some point, regardless of what its
// carrier_status says today.
const PRE_ISSUE_GHL_STAGES = new Set([
  'Pending Approval', 'New Submission', 'Fulfilled Carrier Requirement',
  'Application Withdrawn', 'Declined Underwriting', 'Pending Manual Action',
  'Returned To Center - DQ', "DQ'd Can't be sold", 'GI DQ', 'Chargeback DQ',
  'Previously Sold BPO', 'Needs BPO Callback', 'Incomplete Transfer',
  'Pending Failed Payment Fix',
])

export type GhlStageHistoryRow = {
  deal_tracker_id: string
  new_ghl_stage: string | null
  created_at: string
}

// deal_tracker_id -> earliest history row proving the policy was issued.
// Preferred over checking today's carrier_status: it doesn't matter what the
// carrier reports now (declined later, terminated, re-worded their status
// vocabulary) — a real recorded transition past a pre-issue stage is
// authoritative proof issuance happened, and gives an actual date for it.
// Falls back to nothing when deal_tracker_status_history has no rows for a
// policy, which is the common case today (see lib/missingCommission.test.ts —
// this table was found to be almost entirely unpopulated in practice).
export function findIssuedDatesFromHistory(historyRows: GhlStageHistoryRow[]): Record<string, string> {
  const earliestByRow: Record<string, string> = {}
  const sorted = [...historyRows].sort((a, b) => a.created_at.localeCompare(b.created_at))
  for (const h of sorted) {
    if (!h.new_ghl_stage || PRE_ISSUE_GHL_STAGES.has(h.new_ghl_stage)) continue
    if (!earliestByRow[h.deal_tracker_id]) earliestByRow[h.deal_tracker_id] = h.created_at
  }
  return earliestByRow
}
