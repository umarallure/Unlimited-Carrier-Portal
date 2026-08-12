/**
 * Lapse Risk Detection — implements lapse-risk-detection-spec v2.
 *
 * Finds active policies that have missed a draft and are on track to lapse,
 * from an AMH `policySummary` Excel export.
 *
 * The v2 primary trigger is PAYMENT RECENCY (LASTPAYMENTDATE), not
 * `PAIDTODATE < today`. Quarterly-mode policies drafted in monthly installments
 * legitimately carry a trailing paid-to date, and the v1 rule flagged that whole
 * book as missed payments. PAIDTODATE still drives the lapse clock (Step D) and
 * the NSF verification check (Step C).
 *
 * Everything here is pure except parseLapseRiskWorkbook's File read, so the
 * detection maths is unit-tested against the spec's published numbers.
 */

import * as XLSX from 'xlsx'

export const SHEET_NAME = 'Policy Summary'
/** Real headers sit on the second row; row 1 is a merged title ("header=1"). */
export const HEADER_ROW_INDEX = 1
/** Spec §3 Step B: one monthly cycle (31) + EFT posting lag (5). */
export const EFT_POSTING_LAG_DAYS = 5
export const DEFAULT_GRACE_DAYS = 45
/** Spec Step C: paid-to must have had long enough to move before we call NSF. */
export const NSF_MIN_POLICY_AGE_DAYS = 60

const DAY_MS = 86_400_000

export type RiskTier = 'CRITICAL' | 'HIGH' | 'EARLY'
export type RiskBucket = 'AT_RISK' | 'NSF_SUSPECT' | 'PENDING_FIRST_DRAFT'
export type FailureType =
  | 'NEVER_STARTED'
  | 'PAYMENT_STOPPED'
  | 'NSF_SUSPECT'
  | 'FIRST_DRAFT_PENDING'

/** One row of the export, already coerced. Dates are YYYY-MM-DD or null. */
export interface PolicyRow {
  company_code: string | null
  policy_number: string
  status_category: string | null
  insured: string | null
  phone: string | null
  state: string | null
  agent: string | null
  pay_mode: string | null
  effective_date: string | null
  paid_to_date: string | null
  term_date: string | null
  last_payment: string | null
  last_pay_amount: number | null
  modal_premium: number | null
  annual_premium: number | null
}

export interface FlaggedPolicy {
  bucket: RiskBucket
  company_code: string | null
  policy_number: string
  status_category: string | null
  insured: string | null
  phone: string | null
  state: string | null
  agent: string | null
  pay_mode: string | null
  is_installment: boolean
  draft_amount: number | null
  modal_premium: number | null
  annual_premium: number | null
  effective_date: string | null
  paid_to_date: string | null
  last_payment: string | null
  expected_next_draft: string | null
  payments_made: number | null
  days_since_pay: number | null
  days_until_lapse: number | null
  cycle_days: number
  tier: RiskTier | null
  failure_type: FailureType
  logic_one_liner: string
  action_item: string
}

export interface GraceByCompany {
  [companyCode: string]: { grace_days: number; sample: number; confidence: number }
}

export interface LapseRiskResult {
  snapshotDate: string
  graceByCompany: GraceByCompany
  defaultGraceDays: number
  totalRows: number
  activeCount: number
  flagged: FlaggedPolicy[]
  atRiskCount: number
  criticalCount: number
  highCount: number
  earlyCount: number
  nsfSuspectCount: number
  pendingFirstDraftCount: number
  annualPremiumAtRisk: number
  /** Pay modes with no known cycle, where a monthly cycle was assumed. */
  assumedCycleModes: string[]
}

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------

/** Date-only YYYY-MM-DD, or null. Equivalent to pandas errors='coerce'. */
export function toYmd(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    const y = value.getUTCFullYear()
    const m = String(value.getUTCMonth() + 1).padStart(2, '0')
    const d = String(value.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  const raw = String(value).trim()
  if (!raw) return null

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`

  const us = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/)
  if (us) {
    let year = Number(us[3])
    if (year < 100) year += year < 70 ? 2000 : 1900
    const month = Number(us[1])
    const day = Number(us[2])
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // Excel serial (only when the sheet was read without cellDates).
  const serial = Number(raw)
  if (Number.isFinite(serial) && serial > 20000 && serial < 80000) {
    const ms = Math.round((serial - 25569) * DAY_MS)
    return toYmd(new Date(ms))
  }
  return null
}

/** Numeric, tolerating "$1,234.56" and "(12.00)". Null when unusable. */
export function toNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  let raw = String(value).trim().replace(/[$,\s]/g, '')
  if (!raw) return null
  let negative = false
  if (/^\(.*\)$/.test(raw)) {
    negative = true
    raw = raw.slice(1, -1)
  }
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

function ymdToMs(ymd: string | null): number | null {
  if (!ymd) return null
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/** Whole days from `from` to `to`. Date-only, so no DST/timezone drift. */
export function daysBetween(from: string | null, to: string | null): number | null {
  const a = ymdToMs(from)
  const b = ymdToMs(to)
  if (a == null || b == null) return null
  return Math.round((b - a) / DAY_MS)
}

/** Calendar-month step, clamping to month end (Jan 31 + 1m -> Feb 28/29). */
export function addMonths(ymd: string | null, months: number): string | null {
  const ms = ymdToMs(ymd)
  if (ms == null) return null
  const d = new Date(ms)
  const targetMonth = d.getUTCMonth() + months
  const anchor = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, 1))
  const lastDay = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(d.getUTCDate(), lastDay)
  return toYmd(new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), day)))
}

/** Local calendar date as YYYY-MM-DD — the business "today". */
export function localToday(): string {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// ---------------------------------------------------------------------------
// Billing cycle (spec §2 and §5)
// ---------------------------------------------------------------------------

/**
 * A quarterly policy drafted in ~1/3 of its modal premium each month is on a
 * MONTHLY cycle despite the Q mode label. Detected by the pay ratio, per spec §2
 * (LASTPAYAMT / CURRENTMODALPREMIUM ≈ 0.33 vs ≈ 1.0).
 */
export function isInstallmentPayer(lastPayAmount: number | null, modalPremium: number | null): boolean {
  if (!lastPayAmount || !modalPremium || modalPremium <= 0) return false
  return lastPayAmount / modalPremium < 0.5
}

export interface CycleResolution {
  cycleDays: number
  /** True when the mode was unrecognised and a monthly cycle was assumed. */
  assumed: boolean
}

/**
 * Days in one draft cycle. Spec §5: do not assume monthly for modes outside
 * M / Q-installment — derive from PAYMENTMODEDISPLAYTEXT instead.
 */
export function resolveCycleDays(
  payMode: string | null,
  lastPayAmount: number | null,
  modalPremium: number | null
): CycleResolution {
  const mode = String(payMode ?? '').trim().toUpperCase()
  const installment = isInstallmentPayer(lastPayAmount, modalPremium)

  if (mode === 'M' || mode === 'MONTHLY') return { cycleDays: 31, assumed: false }
  if (mode === 'Q' || mode === 'QUARTERLY') {
    // Installment payers draft monthly; true quarterly payers draft every ~92 days.
    return { cycleDays: installment ? 31 : 92, assumed: false }
  }
  if (mode === 'SA' || mode === 'SEMI-ANNUAL' || mode === 'SEMIANNUAL') {
    return { cycleDays: installment ? 31 : 182, assumed: false }
  }
  if (mode === 'A' || mode === 'ANNUAL') {
    return { cycleDays: installment ? 31 : 365, assumed: false }
  }
  // Unknown/blank/direct bill: assume monthly but tell the caller we guessed.
  return { cycleDays: 31, assumed: true }
}

// ---------------------------------------------------------------------------
// Step A — derive the grace period
// ---------------------------------------------------------------------------

/**
 * grace_days = mode(TERMDATE - PAIDTODATE) over that company's Lapsed rows.
 * Never hardcoded — recomputed per upload, per COMPANYCODE (spec Step A).
 * Companies with no usable Lapsed rows are simply absent; callers fall back.
 */
export function deriveGraceByCompany(rows: PolicyRow[]): GraceByCompany {
  const diffsByCompany = new Map<string, number[]>()

  for (const row of rows) {
    if (String(row.status_category ?? '').trim().toLowerCase() !== 'lapsed') continue
    const diff = daysBetween(row.paid_to_date, row.term_date)
    if (diff == null || diff < 0) continue
    const company = String(row.company_code ?? '').trim() || 'UNKNOWN'
    const bucket = diffsByCompany.get(company)
    if (bucket) bucket.push(diff)
    else diffsByCompany.set(company, [diff])
  }

  const out: GraceByCompany = {}
  for (const [company, diffs] of diffsByCompany) {
    const freq = new Map<number, number>()
    for (const d of diffs) freq.set(d, (freq.get(d) ?? 0) + 1)
    let best = diffs[0]
    let bestCount = 0
    for (const [value, count] of freq) {
      // Tie-break on the smaller grace: the more conservative call list.
      if (count > bestCount || (count === bestCount && value < best)) {
        best = value
        bestCount = count
      }
    }
    out[company] = { grace_days: best, sample: diffs.length, confidence: bestCount }
  }
  return out
}

function graceFor(graceByCompany: GraceByCompany, companyCode: string | null): number {
  const company = String(companyCode ?? '').trim() || 'UNKNOWN'
  return graceByCompany[company]?.grace_days ?? DEFAULT_GRACE_DAYS
}

// ---------------------------------------------------------------------------
// Step D — urgency tier
// ---------------------------------------------------------------------------

/** <=7 CRITICAL, 8..21 HIGH, >=22 EARLY. Unknown paid-to is treated as CRITICAL. */
export function resolveTier(daysUntilLapse: number | null): RiskTier {
  if (daysUntilLapse == null) return 'CRITICAL'
  if (daysUntilLapse <= 7) return 'CRITICAL'
  if (daysUntilLapse <= 21) return 'HIGH'
  return 'EARLY'
}

// ---------------------------------------------------------------------------
// Step E — action templates
// ---------------------------------------------------------------------------

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'the draft amount'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Action wording keyed on (tier, failure_type), interpolating the draft amount. */
export function buildActionItem(
  tier: RiskTier | null,
  failureType: FailureType,
  draftAmount: number | null,
  daysUntilLapse: number | null
): string {
  const amount = money(draftAmount)

  if (failureType === 'NSF_SUSPECT') {
    return `Payments are recorded but paid-to date has not moved — verify with the carrier whether the ${amount} drafts are actually clearing, then re-collect if they reversed.`
  }
  if (failureType === 'FIRST_DRAFT_PENDING') {
    return `Approved but the first draft never posted. Confirm banking details with the client and re-submit the ${amount} draft.`
  }

  const terminationPending = daysUntilLapse != null && daysUntilLapse <= 0
  if (terminationPending) {
    return failureType === 'NEVER_STARTED'
      ? `Past grace, termination pending. The policy never got off the ground — call today, confirm banking details, and collect ${amount} to request reinstatement.`
      : `Past grace, termination pending. Call today and collect ${amount} to request reinstatement before the carrier terminates.`
  }

  if (tier === 'CRITICAL') {
    const window = daysUntilLapse != null ? `${daysUntilLapse} day(s)` : 'days'
    return failureType === 'NEVER_STARTED'
      ? `Call today — first draft never cleared and grace expires in ${window}. Verify banking details and collect ${amount}.`
      : `Call today — grace expires in ${window}. Collect ${amount} to keep the policy in force.`
  }
  if (tier === 'HIGH') {
    return failureType === 'NEVER_STARTED'
      ? `Call this week: no payment has cleared yet. Confirm banking details and collect ${amount}.`
      : `Call this week: a draft was missed. Collect ${amount} and confirm the account is good for the next cycle.`
  }
  return failureType === 'NEVER_STARTED'
    ? `Early outreach: first draft has not cleared. Confirm banking details and set up ${amount}.`
    : `Early outreach: a draft was missed but there is time. Collect ${amount} and check for a banking change.`
}

// ---------------------------------------------------------------------------
// Steps B–E — detection
// ---------------------------------------------------------------------------

/** Duplicate POLICYNUMBER: keep the row with the latest PAIDTODATE (spec §5). */
export function dedupeByLatestPaidTo(rows: PolicyRow[]): PolicyRow[] {
  const byPolicy = new Map<string, PolicyRow>()
  for (const row of rows) {
    const key = String(row.policy_number ?? '').trim()
    if (!key) continue
    const existing = byPolicy.get(key)
    if (!existing) {
      byPolicy.set(key, row)
      continue
    }
    const a = ymdToMs(row.paid_to_date) ?? -Infinity
    const b = ymdToMs(existing.paid_to_date) ?? -Infinity
    if (a > b) byPolicy.set(key, row)
  }
  return Array.from(byPolicy.values())
}

/**
 * Run the whole detection over already-parsed rows.
 *
 * `snapshotDate` is the business "today" (date-only), so a run can be replayed
 * for an older file and produce the same answer it would have then.
 */
export function detectLapseRisk(allRows: PolicyRow[], snapshotDate: string): LapseRiskResult {
  const rows = dedupeByLatestPaidTo(allRows)
  const graceByCompany = deriveGraceByCompany(rows)
  const assumedModes = new Set<string>()
  const flagged: FlaggedPolicy[] = []

  const statusOf = (r: PolicyRow) => String(r.status_category ?? '').trim().toLowerCase()
  const activeRows = rows.filter((r) => statusOf(r) === 'active')

  for (const p of activeRows) {
    const grace = graceFor(graceByCompany, p.company_code)
    const { cycleDays, assumed } = resolveCycleDays(p.pay_mode, p.last_pay_amount, p.modal_premium)
    if (assumed) assumedModes.add(String(p.pay_mode ?? '').trim() || '(blank)')
    const tolerance = cycleDays + EFT_POSTING_LAG_DAYS
    const installment = isInstallmentPayer(p.last_pay_amount, p.modal_premium)

    // Step B — payment recency. A null LASTPAYMENTDATE on an active policy means
    // nothing has ever been collected, so measure from ORIGEFFDATE (spec §5).
    const paymentAnchor = p.last_payment ?? p.effective_date
    const daysSincePay = daysBetween(paymentAnchor, snapshotDate)

    // Step D — lapse clock, always from PAIDTODATE regardless of billing mode.
    const elapsedSincePaidTo = daysBetween(p.paid_to_date, snapshotDate)
    const daysUntilLapse = elapsedSincePaidTo == null ? null : grace - elapsedSincePaidTo

    const shared = {
      company_code: p.company_code,
      policy_number: p.policy_number,
      status_category: p.status_category,
      insured: p.insured,
      phone: p.phone,
      state: p.state,
      agent: p.agent,
      pay_mode: p.pay_mode,
      is_installment: installment,
      draft_amount: p.last_pay_amount,
      modal_premium: p.modal_premium,
      annual_premium: p.annual_premium,
      effective_date: p.effective_date,
      paid_to_date: p.paid_to_date,
      last_payment: p.last_payment,
      cycle_days: cycleDays,
    }

    if (daysSincePay != null && daysSincePay > tolerance) {
      const paymentsMade =
        p.last_payment && p.effective_date
          ? Math.round((daysBetween(p.effective_date, p.last_payment) ?? 0) / 30.4) + 1
          : 0
      const tier = resolveTier(daysUntilLapse)
      const failureType: FailureType = paymentsMade <= 1 ? 'NEVER_STARTED' : 'PAYMENT_STOPPED'
      const terminationPending = daysUntilLapse != null && daysUntilLapse <= 0

      flagged.push({
        ...shared,
        bucket: 'AT_RISK',
        expected_next_draft: addMonths(paymentAnchor, 1),
        payments_made: paymentsMade,
        days_since_pay: daysSincePay,
        days_until_lapse: daysUntilLapse,
        tier,
        failure_type: failureType,
        logic_one_liner: p.last_payment
          ? `Last payment ${p.last_payment} was ${daysSincePay} days ago (over the ${tolerance}-day ${cycleDays}-day-cycle tolerance), so at least one draft was missed.` +
            (terminationPending
              ? ` Paid to ${p.paid_to_date}; ${grace}-day grace already expired — termination pending.`
              : ` Paid to ${p.paid_to_date}; ${daysUntilLapse} of ${grace} grace days left.`)
          : `No payment has ever been recorded; ${daysSincePay} days since the ${p.effective_date} effective date.` +
            (terminationPending
              ? ` ${grace}-day grace already expired — termination pending.`
              : ` ${daysUntilLapse} of ${grace} grace days left.`),
        action_item: buildActionItem(tier, failureType, p.last_pay_amount, daysUntilLapse),
      })
      continue
    }

    // Step C — NSF verification. Looks current on recency, but paid-to never
    // moved off the effective date, and the policy is old enough that it should
    // have. A reversed draft leaves LASTPAYMENTDATE in place.
    const policyAge = daysBetween(p.effective_date, snapshotDate)
    if (
      p.paid_to_date != null &&
      p.effective_date != null &&
      p.paid_to_date === p.effective_date &&
      policyAge != null &&
      policyAge >= NSF_MIN_POLICY_AGE_DAYS
    ) {
      flagged.push({
        ...shared,
        bucket: 'NSF_SUSPECT',
        expected_next_draft: addMonths(paymentAnchor, 1),
        payments_made: null,
        days_since_pay: daysSincePay,
        days_until_lapse: daysUntilLapse,
        tier: null,
        failure_type: 'NSF_SUSPECT',
        logic_one_liner: `Payment recorded ${p.last_payment ?? 'n/a'} (${daysSincePay ?? '?'} days ago, within tolerance) but paid-to date is still the ${p.effective_date} effective date after ${policyAge} days — drafts may be reversing.`,
        action_item: buildActionItem(null, 'NSF_SUSPECT', p.last_pay_amount, daysUntilLapse),
      })
    }
  }

  // §4 — secondary bucket: approved, first draft never posted. Not on the grace
  // clock yet, but the same failure mode that produces first-payment lapses.
  for (const p of rows) {
    if (statusOf(p) !== 'issued not in force') continue
    const { cycleDays, assumed } = resolveCycleDays(p.pay_mode, p.last_pay_amount, p.modal_premium)
    if (assumed) assumedModes.add(String(p.pay_mode ?? '').trim() || '(blank)')
    const draftAmount = p.last_pay_amount ?? p.modal_premium
    flagged.push({
      bucket: 'PENDING_FIRST_DRAFT',
      company_code: p.company_code,
      policy_number: p.policy_number,
      status_category: p.status_category,
      insured: p.insured,
      phone: p.phone,
      state: p.state,
      agent: p.agent,
      pay_mode: p.pay_mode,
      is_installment: isInstallmentPayer(p.last_pay_amount, p.modal_premium),
      draft_amount: draftAmount,
      modal_premium: p.modal_premium,
      annual_premium: p.annual_premium,
      effective_date: p.effective_date,
      paid_to_date: p.paid_to_date,
      last_payment: p.last_payment,
      expected_next_draft: null,
      payments_made: 0,
      days_since_pay: daysBetween(p.effective_date, snapshotDate),
      days_until_lapse: null,
      cycle_days: cycleDays,
      tier: null,
      failure_type: 'FIRST_DRAFT_PENDING',
      logic_one_liner: `Status "${p.status_category}" — approved with EFT pending; no first draft has posted.`,
      action_item: buildActionItem(null, 'FIRST_DRAFT_PENDING', draftAmount, null),
    })
  }

  // Spec §3 Step E ordering: soonest to lapse first, then biggest premium.
  const rank: Record<RiskBucket, number> = { AT_RISK: 0, NSF_SUSPECT: 1, PENDING_FIRST_DRAFT: 2 }
  flagged.sort((a, b) => {
    if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket]
    const al = a.days_until_lapse ?? Number.POSITIVE_INFINITY
    const bl = b.days_until_lapse ?? Number.POSITIVE_INFINITY
    if (al !== bl) return al - bl
    return (b.annual_premium ?? 0) - (a.annual_premium ?? 0)
  })

  const atRisk = flagged.filter((f) => f.bucket === 'AT_RISK')
  return {
    snapshotDate,
    graceByCompany,
    defaultGraceDays: DEFAULT_GRACE_DAYS,
    totalRows: rows.length,
    activeCount: activeRows.length,
    flagged,
    atRiskCount: atRisk.length,
    criticalCount: atRisk.filter((f) => f.tier === 'CRITICAL').length,
    highCount: atRisk.filter((f) => f.tier === 'HIGH').length,
    earlyCount: atRisk.filter((f) => f.tier === 'EARLY').length,
    nsfSuspectCount: flagged.filter((f) => f.bucket === 'NSF_SUSPECT').length,
    pendingFirstDraftCount: flagged.filter((f) => f.bucket === 'PENDING_FIRST_DRAFT').length,
    annualPremiumAtRisk: Math.round(atRisk.reduce((sum, f) => sum + (f.annual_premium ?? 0), 0) * 100) / 100,
    assumedCycleModes: Array.from(assumedModes),
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const REQUIRED_HEADERS = [
  'POLICYNUMBER',
  'STATUSCATEGORY',
  'ORIGEFFDATE',
  'PAIDTODATE',
  'TERMDATE',
  'LASTPAYMENTDATE',
  'LASTPAYAMT',
  'PAYMENTMODEDISPLAYTEXT',
  'CURRENTMODALPREMIUM',
  'CURRENTANNUALPREMIUM',
] as const

/** Map a header row + data rows into PolicyRow[]. Exported for testing. */
export function mapSheetRows(headerRow: unknown[], dataRows: unknown[][]): PolicyRow[] {
  const headers = headerRow.map((h) => String(h ?? '').trim().toUpperCase())
  const idx = (name: string) => headers.indexOf(name)

  const missing = REQUIRED_HEADERS.filter((h) => idx(h) === -1)
  if (missing.length > 0) {
    throw new Error(
      `The sheet is missing required column(s): ${missing.join(', ')}. ` +
        `Found: ${headers.filter(Boolean).join(', ')}`
    )
  }

  const iCompany = idx('COMPANYCODE')
  const iPolicy = idx('POLICYNUMBER')
  const iStatus = idx('STATUSCATEGORY')
  const iEff = idx('ORIGEFFDATE')
  const iPaidTo = idx('PAIDTODATE')
  const iTerm = idx('TERMDATE')
  const iLastPay = idx('LASTPAYMENTDATE')
  const iLastAmt = idx('LASTPAYAMT')
  const iMode = idx('PAYMENTMODEDISPLAYTEXT')
  const iModal = idx('CURRENTMODALPREMIUM')
  const iAnnual = idx('CURRENTANNUALPREMIUM')
  const iInsured = idx('INSUREDNAME')
  const iPhone = idx('PHONE1')
  const iState = idx('STATE')
  const iAgent = idx('AGENTCOMPLETENAME')

  const text = (row: unknown[], i: number): string | null => {
    if (i === -1) return null
    const v = row[i]
    if (v == null) return null
    const s = String(v).replace(/\s+/g, ' ').trim()
    return s || null
  }

  const out: PolicyRow[] = []
  for (const row of dataRows) {
    const policyNumber = text(row, iPolicy)
    if (!policyNumber) continue
    out.push({
      company_code: text(row, iCompany),
      policy_number: policyNumber,
      status_category: text(row, iStatus),
      insured: text(row, iInsured),
      phone: text(row, iPhone),
      state: text(row, iState),
      agent: text(row, iAgent),
      pay_mode: text(row, iMode),
      effective_date: toYmd(row[iEff]),
      paid_to_date: toYmd(row[iPaidTo]),
      term_date: toYmd(row[iTerm]),
      last_payment: toYmd(row[iLastPay]),
      last_pay_amount: toNumber(row[iLastAmt]),
      modal_premium: toNumber(row[iModal]),
      annual_premium: toNumber(row[iAnnual]),
    })
  }
  return out
}

/** Read the uploaded workbook into PolicyRow[]. */
export async function parseLapseRiskWorkbook(file: File): Promise<PolicyRow[]> {
  const buffer = await file.arrayBuffer()
  const workbook = XLSX.read(buffer, { cellDates: true })

  const sheetName =
    workbook.SheetNames.find((n) => n.trim().toLowerCase() === SHEET_NAME.toLowerCase()) ??
    workbook.SheetNames[0]
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`Could not find a "${SHEET_NAME}" sheet in this workbook.`)

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null })
  if (grid.length <= HEADER_ROW_INDEX) throw new Error('The sheet has no data rows.')

  return mapSheetRows(grid[HEADER_ROW_INDEX], grid.slice(HEADER_ROW_INDEX + 1))
}
