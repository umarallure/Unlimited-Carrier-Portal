import { extractYmdFromDbValue, mergeEffectiveDate } from './calendarDate'

/**
 * GHL Stage Resolution Logic
 *
 * Replaces the simple first-match lookup with conditional logic that considers:
 * - Carrier status (from carrier portal)
 * - Effective/draft date (for time-based decisions)
 * - Commission data (for active/advanced/earned distinction)
 * - Previous GHL stage (for transition rules)
 * - Grace period per carrier (for "not taken" classification)
 */

const CARRIER_GRACE_PERIODS: Record<string, number> = {
  ANAM: 45,
  AMAM: 45,
  AETNA: 30,
  AFLAC: 30,
  CICA: 30,
  COREBRIDGE: 30,
  MOH: 30,
  RNA: 21,
  SBLI: 20,

  // Default for carriers not listed in the business rule yet.
  AMERICO: 31,
  CHUB: 31,
  GTL: 31,
  LIBERTY: 31,
  SENTINEL: 31,
  TRANSAMERICA: 31,
  AHL: 31,
}

const ACTIVE_STAGES = new Set([
  'Premium Paid - Commission Pending',
  'Active Placed - Paid as Advanced',
  'ACTIVE PLACED - Paid as Advanced',
  'Active Placed - Paid as Earned',
  'ACTIVE - 3 Months +',
  'ACTIVE - 6 months +',
  'ACTIVE - 9 months',
  'ACTIVE - Past Charge-Back Period',
])

const ISSUED_STAGES = new Set([
  'Issued - Pending First Draft',
  'FDPF Pending Reason',
  'FDPF Insufficient Funds',
  'FDPF Unauthorized Draft',
  'FDPF Incorrect Banking Info',
])

const PENDING_LAPSE_STAGES = new Set([
  'Pending Lapse',
  'Pending Lapse Insufficient Funds',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Unauthorized Draft',
  'Pending Lapse Pending Reason',
])

/** Advanced / Earned / 3M+ imply commission was paid — only when deal_value > 0 (see resolveGhlStage). */
function stageRequiresPositiveDealValue(stage: string): boolean {
  const t = stage.trim().toLowerCase()
  return (
    t === 'active placed - paid as advanced' ||
    t === 'active placed - paid as earned' ||
    t === 'active - 3 months +' ||
    t === 'active - 6 months +' ||
    t === 'active - 9 months' ||
    t === 'active - past charge-back period'
  )
}

/**
 * Stages that require manual auditing/approval.
 * During auto-mapping we must never overwrite an existing manual stage,
 * and we must not auto-set a record into these manual stages.
 */
const MANUAL_APPROVAL_STAGES = new Set([
  'Pending Manual Action',
  'FDPF Insufficient Funds',
  'FDPF Unauthorized Draft',
  'FDPF Incorrect Banking Info',
])

const MANUAL_STAGE_SAFE_PARENT: Record<string, string> = {
  'Pending Manual Action': 'Pending Approval',
  'FDPF Insufficient Funds': 'FDPF Pending Reason',
  'FDPF Unauthorized Draft': 'FDPF Pending Reason',
  'FDPF Incorrect Banking Info': 'FDPF Pending Reason',
}

export const GHL_STAGE_ORDER = [
  'Pending Approval',
  'Pending Manual Action',
  'Application Withdrawn',
  'Declined Underwriting',
  'CANNOT BE FOUND IN CARRIER',
  'Issued - Pending First Draft',
  'FDPF Pending Reason',
  'FDPF Insufficient Funds',
  'FDPF Incorrect Banking Info',
  "FDPF Unauthorized Draft",
  'Premium Paid - Commission Pending',
  'Active Placed - Paid as Advanced',
  'Active Placed - Paid as Earned',
  'ACTIVE - 3 Months +',
  'ACTIVE - 6 months +',
  'ACTIVE - 9 months',
  'ACTIVE - Past Charge-Back Period',
  'Pending Lapse',
  'Pending Lapse Pending Reason',
  'Pending Lapse Insufficient Funds',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Unauthorized Draft',
  'Chargeback Failed Payment',
  'Chargeback Cancellation',
] as const

export type GhlStageName = (typeof GHL_STAGE_ORDER)[number]

export const GHL_STAGE_CATEGORIES: {
  key: string
  label: string
  color: string
  stages: string[]
}[] = [
  {
    key: 'pending',
    label: 'Pending',
    color: '#f59e0b',
    stages: ['Pending Approval', 'Pending Manual Action'],
  },
  {
    key: 'withdrawn',
    label: 'Withdrawn / Declined',
    color: '#6b7280',
    stages: ['Application Withdrawn', 'Declined Underwriting', 'CANNOT BE FOUND IN CARRIER'],
  },
  {
    key: 'issued',
    label: 'Issued / FDPF',
    color: '#3b82f6',
    stages: [
      'Issued - Pending First Draft',
      'FDPF Pending Reason',
      'FDPF Insufficient Funds',
      'FDPF Unauthorized Draft',
      'FDPF Incorrect Banking Info',
    ],
  },
  {
    key: 'active',
    label: 'Active',
    color: '#22c55e',
    stages: [
      'Premium Paid - Commission Pending',
      'Active Placed - Paid as Advanced',
      'Active Placed - Paid as Earned',
      'ACTIVE - 3 Months +',
      'ACTIVE - 6 months +',
      'ACTIVE - 9 months',
      'ACTIVE - Past Charge-Back Period',
    ],
  },
  {
    key: 'pendingLapse',
    label: 'Pending Lapse',
    color: '#f97316',
    stages: [
      'Pending Lapse',
      'Pending Lapse Pending Reason',
      'Pending Lapse Insufficient Funds',
      'Pending Lapse Incorrect Banking Info',
      'Pending Lapse Unauthorized Draft',
    ],
  },
  {
    key: 'chargeback',
    label: 'Chargeback',
    color: '#ef4444',
    stages: ['Chargeback Failed Payment', 'Chargeback Cancellation'],
  },
]

export function getStageColor(stage: string): string {
  for (const cat of GHL_STAGE_CATEGORIES) {
    if (cat.stages.includes(stage)) return cat.color
  }
  return '#6b7280'
}

export function getStageCategory(stage: string): string {
  for (const cat of GHL_STAGE_CATEGORIES) {
    if (cat.stages.includes(stage)) return cat.label
  }
  return 'Other'
}

function parseDate(dateStr: string | null): Date | null {
  if (dateStr == null) return null
  const s = String(dateStr).trim()
  if (!s) return null
  // Normalize common export/input format before generic parsing.
  // Example: "04/05/2026" should be interpreted as 2026-04-05.
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|[\sT].*)?$/)
  if (us) {
    const m = String(parseInt(us[1], 10)).padStart(2, '0')
    const d = String(parseInt(us[2], 10)).padStart(2, '0')
    const ymd = `${us[3]}-${m}-${d}`
    const dUs = new Date(`${ymd}T12:00:00`)
    return isNaN(dUs.getTime()) ? null : dUs
  }
  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`)
  return isNaN(d.getTime()) ? null : d
}

/** Local calendar day (no time-of-day drift). */
function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Add n calendar months in local time (e.g. Jan 5 + 3 → Apr 5). */
function addCalendarMonths(d: Date, n: number): Date {
  const result = new Date(d.getTime())
  result.setMonth(result.getMonth() + n)
  return result
}

function qualifiesForMonthThreshold(effDate: Date | null, today: Date, months: number): boolean {
  if (!effDate || isNaN(effDate.getTime())) return false
  const anchor = startOfLocalDay(effDate)
  const monthMark = addCalendarMonths(anchor, months)
  const now = startOfLocalDay(today)
  return now >= monthMark
}

/** True when today is a strictly later calendar day than effective (FDPF starts the day after effective). */
function isEffectiveDateFullyPassed(effDate: Date | null, today: Date): boolean {
  if (!effDate || isNaN(effDate.getTime())) return false
  return startOfLocalDay(today).getTime() > startOfLocalDay(effDate).getTime()
}

function toLocalYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Pending policies with draft/effective date still before today: roll forward by whole calendar months
 * until the date is on or after today's calendar day (same rule as +1 month until caught up).
 */
function rollPastDraftMonthsUntilCurrent(effDate: Date | null, today: Date): Date | null {
  if (!effDate || isNaN(effDate.getTime())) return null
  const todayDay = startOfLocalDay(today)
  let cur = startOfLocalDay(effDate)
  while (cur.getTime() < todayDay.getTime()) {
    cur = startOfLocalDay(addCalendarMonths(cur, 1))
  }
  return cur
}

/**
 * Carrier portal text suggests "pending approval" style pending (draft-date roll applies),
 * not issued/active/lapse/decline/withdrawn.
 */
function looksLikePendingDraftCarrierStatus(carrierStatus: string | null): boolean {
  if (!carrierStatus) return false
  const s = carrierStatus.toLowerCase()
  if (s.includes('issued')) return false
  if (s.includes('lapse') || s.includes('lapsing')) return false
  if (s.includes('declin')) return false
  if (s.includes('withdraw')) return false
  if (s.includes('cannot be found')) return false
  if (s.includes('premium paid') || s.includes('active - premium') || s.includes('in force')) return false
  if (s.includes('pending lapse') || s.includes('lapse pending')) return false
  if (s.includes('pending payment') || s.includes('commission pending')) return false
  if (s.includes('pending approval')) return true
  if (s.includes('application pending') || s.includes('pending application')) return true
  if (s.includes('pending') && s.includes('underwriting')) return true
  // AMAM and similar feeds often provide generic "pending" text.
  if (s.includes('pending')) return true
  return false
}

/**
 * Mapped `policy_status` is "pending" for approval / in-process — draft-date roll applies.
 * Pending lapse / lapsed / lapsing is not that bucket (different business rules).
 */
function looksLikePendingPolicyStatus(policyStatus: string | null): boolean {
  if (!policyStatus) return false
  const s = policyStatus.toLowerCase()
  if (s.includes('lapse') || s.includes('lapsing') || s.includes('lapsed')) return false
  if (s.includes('issued')) return false
  if (s.includes('declin')) return false
  if (s.includes('withdraw')) return false
  if (s.includes('pending payment') || s.includes('commission pending')) return false
  if (s.includes('pending approval')) return true
  if (s.includes('application pending') || s.includes('pending application')) return true
  if (s.includes('pending') && s.includes('underwriting')) return true
  // Generic "Pending" / "Pending …" without lapse (e.g. Monday stage label).
  if (s.includes('pending')) return true
  return false
}

/**
 * If pending + effective/draft date is before today, return rolled YYYY-MM-DD; otherwise null (no change).
 * Call after mergeEffectiveDate so stored effective_date advances month-by-month until current.
 */
export function applyPendingDraftRollToEffectiveDate(
  effectiveYmd: string | null | undefined,
  carrierStatus: string | null | undefined,
  policyStatus?: string | null | undefined,
): string | null {
  const shouldRoll =
    policyStatus != null
      ? looksLikePendingPolicyStatus(policyStatus)
      : looksLikePendingDraftCarrierStatus(carrierStatus ?? null)
  if (!shouldRoll) return null
  const ymd = extractYmdFromDbValue(effectiveYmd ?? '') || (effectiveYmd != null ? String(effectiveYmd).trim().slice(0, 10) : '')
  if (!ymd) return null
  const parsed = parseDate(ymd)
  if (!parsed) return null
  const rolled = rollPastDraftMonthsUntilCurrent(parsed, new Date())
  if (!rolled) return null
  const out = toLocalYmd(rolled)
  return out === ymd ? null : out
}

/** Merge effective date (DDF + fallbacks), then roll month-by-month if pending + draft still before today. */
export function mergeEffectiveDateWithPendingRoll(
  carrierStatus: string | null | undefined,
  policyStatus: string | null | undefined,
  existingEffective: unknown,
  draftDateFromDdf: unknown,
  ...fallbacks: unknown[]
): string | null {
  // For pending policies, DDF draft date is the business anchor for monthly roll.
  // If present, use it directly (rolled if in the past), even when a row already
  // has an effective_date from a prior source.
  if (looksLikePendingPolicyStatus(policyStatus ?? null)) {
    const rawDdf = draftDateFromDdf != null ? String(draftDateFromDdf).trim() : ''
    const ddfYmd = extractYmdFromDbValue(draftDateFromDdf) || (rawDdf !== '' ? rawDdf : null)
    if (ddfYmd) {
      const rolledFromDdf = applyPendingDraftRollToEffectiveDate(ddfYmd, carrierStatus ?? null, policyStatus ?? null)
      return rolledFromDdf ?? ddfYmd
    }
  }

  const base = mergeEffectiveDate(existingEffective, draftDateFromDdf, ...fallbacks)
  return applyPendingDraftRollToEffectiveDate(base, carrierStatus ?? null, policyStatus ?? null) ?? base
}

export interface GhlStageResolutionContext {
  carrierStatus: string | null
  allMappings: Map<string, string[]>
  /**
   * Policy effective / draft date used for time-based rules (Issued vs FDPF, chargeback grace, etc.).
   * May include DDF draft when filling gaps — not commission paid/statement dates.
   */
  effectiveDate: string | null
  /**
   * Calendar anchor for ACTIVE - 9 months only: must be `deal_tracker.effective_date`.
   * When omitted, falls back to `effectiveDate` (legacy). When null/empty, never auto-promote to 9 months.
   */
  effectiveDateForThreeMonthRule?: string | null
  /**
   * Deal creation date used by pending-aging rules.
   * If pending lasts over 30 calendar days from this date, stage becomes Application Withdrawn.
   */
  dealCreationDate?: string | null
  dealValue: number | null
  /** When negative, aligns with deal_tracker charge_back / Status "Charge Back" (commission chargeback lines net separately from positive advance). */
  chargeBack?: number | null
  commissionType: string | null
  existingGhlStage: string | null
  carrierCode: string | null
}

/**
 * Resolve the correct GHL stage from multiple possible mappings using
 * time, commission, previous-stage, and grace-period conditions.
 */
function normCarrierStatusKey(s: string): string {
  return String(s).trim().replace(/\s+/g, ' ')
}

/** Match `carrier_ghl_stage_mappings.carrier_status_in_carrier_portal` when file text differs slightly from DB key. */
function lookupStagesForCarrierStatus(
  allMappings: Map<string, string[]>,
  carrierStatus: string
): string[] | null {
  const direct = allMappings.get(carrierStatus)
  if (direct && direct.length > 0) return direct
  const n = normCarrierStatusKey(carrierStatus)
  for (const [k, v] of allMappings.entries()) {
    if (v.length > 0 && normCarrierStatusKey(k) === n) return v
  }
  const nl = n.toLowerCase()
  for (const [k, v] of allMappings.entries()) {
    if (v.length > 0 && normCarrierStatusKey(k).toLowerCase() === nl) return v
  }
  return null
}

/** Index in `GHL_STAGE_ORDER` (later = further in the pipeline). Unknown stages return -1. */
function ghlStageOrderIndex(stage: string | null): number {
  if (!stage) return -1
  const exact = GHL_STAGE_ORDER.indexOf(stage as GhlStageName)
  if (exact >= 0) return exact
  const n = stage.trim().toLowerCase()
  for (let i = 0; i < GHL_STAGE_ORDER.length; i++) {
    if (GHL_STAGE_ORDER[i].toLowerCase() === n) return i
  }
  return -1
}

function normalizeStageLabel(stage: string | null): string | null {
  if (!stage) return stage
  const s = stage.trim()
  const lower = s.toLowerCase()
  if (lower === 'active - 9 months +') return 'ACTIVE - 9 months'
  if (lower === 'fdpf incorrect banking info') return 'FDPF Incorrect Banking Info'
  if (lower === 'pending lapse incorrect banking info') return 'Pending Lapse Incorrect Banking Info'
  return s
}

function stageProgressRank(stage: string | null): { family: string; rank: number } | null {
  const normalized = normalizeStageLabel(stage)
  if (!normalized) return null
  switch (normalized) {
    case 'Active Placed - Paid as Advanced':
    case 'ACTIVE PLACED - Paid as Advanced':
    case 'Active Placed - Paid as Earned':
      return { family: 'active', rank: 1 }
    case 'ACTIVE - 3 Months +':
      return { family: 'active', rank: 2 }
    case 'ACTIVE - 6 months +':
      return { family: 'active', rank: 3 }
    case 'ACTIVE - 9 months':
      return { family: 'active', rank: 4 }
    case 'ACTIVE - Past Charge-Back Period':
      return { family: 'active', rank: 5 }
    case 'FDPF Pending Reason':
      return { family: 'fdpf', rank: 1 }
    case 'FDPF Insufficient Funds':
    case 'FDPF Incorrect Banking Info':
    case 'FDPF Unauthorized Draft':
      return { family: 'fdpf', rank: 2 }
    case 'Pending Lapse Pending Reason':
      return { family: 'pendingLapse', rank: 1 }
    case 'Pending Lapse Insufficient Funds':
    case 'Pending Lapse Incorrect Banking Info':
    case 'Pending Lapse Unauthorized Draft':
      return { family: 'pendingLapse', rank: 2 }
    default:
      return null
  }
}

/** Outcomes that sit *before* "Issued" in `GHL_STAGE_ORDER` but are correct when the carrier portal says withdrawn/declined/not found. */
function isCarrierOutcomeStageBeforeIssued(stage: string | null): boolean {
  if (!stage) return false
  const t = stage.trim().toLowerCase()
  return (
    t === 'application withdrawn' ||
    t === 'declined underwriting' ||
    t === 'cannot be found in carrier'
  )
}

/**
 * Commission-only (or partial) runs can temporarily lack deal_value > 0, which used to make
 * `resolveGhlStage` pick an earlier funnel stage (e.g. Issued) even when deal_tracker already
 * had a later stage (e.g. Active). Never regress along `GHL_STAGE_ORDER` unless financial or
 * cancellation/chargeback signals justify it.
 */
function applyNonRegressiveGhlClamp(
  existing: string | null,
  candidate: string | null,
  ctx: GhlStageResolutionContext
): string | null {
  existing = normalizeStageLabel(existing)
  candidate = normalizeStageLabel(candidate)
  if (candidate == null) return existing ?? null

  const ex = ghlStageOrderIndex(existing)
  const ca = ghlStageOrderIndex(candidate)
  const exProgress = stageProgressRank(existing)
  const caProgress = stageProgressRank(candidate)

  if (
    exProgress &&
    caProgress &&
    exProgress.family === caProgress.family &&
    caProgress.rank < exProgress.rank
  ) {
    return existing ?? candidate
  }

  // Legacy / non-canonical label on deal_tracker: prefer a canonical mapped candidate when available.
  if (existing && ex < 0) {
    if (ca >= 0) return candidate
    return existing
  }
  if (ca < 0) return existing ?? candidate

  // Withdrawn / declined / not found are earlier in the array than Issued but are not "bad" regressions —
  // they must win when carrier_status + DB mapping say so (e.g. deal_value still 0).
  if (isCarrierOutcomeStageBeforeIssued(candidate)) return candidate

  if (ca >= ex) return candidate

  const chargeBackNum =
    ctx.chargeBack != null && !Number.isNaN(Number(ctx.chargeBack)) ? Number(ctx.chargeBack) : null
  if (chargeBackNum != null && chargeBackNum < 0) return candidate
  if (ctx.dealValue != null && ctx.dealValue < 0) return candidate

  const statusLower = (ctx.carrierStatus || '').toLowerCase()
  const looksLikeInitiatedCancellation =
    statusLower.includes('terminat') ||
    statusLower.includes('cancel') ||
    statusLower.includes('surrender') ||
    statusLower.includes('free look')
  if (looksLikeInitiatedCancellation) return candidate

  if (candidate === 'Chargeback Failed Payment' || candidate === 'Chargeback Cancellation') return candidate

  return existing ?? candidate
}

export function resolveGhlStage(ctx: GhlStageResolutionContext): string | null {
  return applyNonRegressiveGhlClamp(ctx.existingGhlStage, resolveGhlStageRaw(ctx), ctx)
}

function resolveGhlStageRaw(ctx: GhlStageResolutionContext): string | null {
  const {
    carrierStatus,
    allMappings,
    effectiveDate,
    effectiveDateForThreeMonthRule,
    dealCreationDate,
    dealValue,
    chargeBack,
    commissionType,
    existingGhlStage,
    carrierCode,
  } = ctx

  if (!carrierStatus) return null
  let possibleStages = lookupStagesForCarrierStatus(allMappings, carrierStatus)
  if (!possibleStages || possibleStages.length === 0) return null
  possibleStages = Array.from(
    new Set(
      possibleStages
        .map((s) => normalizeStageLabel(s))
        .filter((s): s is string => Boolean(s))
    )
  )
  const sanitizeManualStage = (stage: string): string => {
    const normalized = normalizeStageLabel(stage) ?? stage
    if (!MANUAL_APPROVAL_STAGES.has(normalized)) return normalized
    return MANUAL_STAGE_SAFE_PARENT[normalized] ?? normalized
  }
  const addStageIfMissing = (stage: string) => {
    if (!possibleStages) return
    if (!possibleStages.includes(stage)) possibleStages.push(stage)
  }

  const chargeBackNum =
    chargeBack != null && !Number.isNaN(Number(chargeBack)) ? Number(chargeBack) : null
  const statusLower = carrierStatus.toLowerCase()
  const statusCompact = statusLower.replace(/[^a-z0-9]/g, '')
  const looksLikeInitiatedCancellation =
    statusLower.includes('terminat') ||
    statusLower.includes('cancel') ||
    statusLower.includes('surrender') ||
    statusLower.includes('free look')

  // Align with statusFromDealValueAndChargeback: negative charge_back means "Charge Back" in deal_tracker
  // even when deal_value is still positive (common for AMAM/Aetna commission files with offsetting lines).
  // Without this, resolveGhlStage only saw dealValue > 0 and promoted to Active/Premium while Status flipped to Charge Back.
  if (chargeBackNum != null && chargeBackNum < 0) {
    const stageSetCb = new Set(possibleStages)
    if (looksLikeInitiatedCancellation && stageSetCb.has('Chargeback Cancellation')) {
      return sanitizeManualStage('Chargeback Cancellation')
    }
    if (stageSetCb.has('Chargeback Failed Payment')) return sanitizeManualStage('Chargeback Failed Payment')
    if (stageSetCb.has('Chargeback Cancellation')) return sanitizeManualStage('Chargeback Cancellation')
    const named = possibleStages.find(s => /chargeback/i.test(s))
    if (named) return sanitizeManualStage(named)
  }

  // Some carriers/statuses in DB have only one mapped GHL stage (commonly
  // "Premium Paid - Commission Pending"). Do not early-return in that case
  // when financial evidence says commission was paid; allow active promotion
  // rules to run using deal_value/commission_type.
  if (possibleStages.length === 1) {
    const only = possibleStages[0]
    const onlyLower = (only || '').toLowerCase()
    const hasPositiveDealSignal = dealValue != null && dealValue > 0
    const fromIssuedOrPremPending =
      onlyLower === 'issued - pending first draft' ||
      onlyLower === 'fdpf pending reason' ||
      onlyLower === 'premium paid - commission pending'
    if (hasPositiveDealSignal && fromIssuedOrPremPending) {
      addStageIfMissing('Premium Paid - Commission Pending')
      addStageIfMissing('Active Placed - Paid as Advanced')
      addStageIfMissing('Active Placed - Paid as Earned')
      addStageIfMissing('ACTIVE - 3 Months +')
      addStageIfMissing('ACTIVE - 6 months +')
      addStageIfMissing('ACTIVE - 9 months')
      addStageIfMissing('ACTIVE - Past Charge-Back Period')
    } else {
      // DB may map a pre-payment carrier status only to Advanced — never use that without payment proof.
      if (!hasPositiveDealSignal && stageRequiresPositiveDealValue(only)) {
        return sanitizeManualStage('Issued - Pending First Draft')
      }
      // Keep evaluating so pending-aging can still move to Application Withdrawn.
      if (onlyLower === 'pending approval') {
        // no-op; fall through to pending-aging checks below
      } else {
      return sanitizeManualStage(only)
      }
    }
  }

  // Commission not paid / no deal amount: drop Advanced, Earned, 3M+ from allowed targets so
  // carrier_status_mapping cannot force those stages without deal_value > 0.
  const hasPaymentProof = dealValue != null && dealValue > 0
  if (!hasPaymentProof) {
    const filtered = possibleStages.filter(s => !stageRequiresPositiveDealValue(s))
    if (filtered.length > 0) {
      possibleStages = filtered
    } else {
      possibleStages = ['Issued - Pending First Draft']
    }
  }

  const today = new Date()
  const effDate = parseDate(effectiveDate)
  const dealCreated = parseDate(dealCreationDate ?? null)
  const effDateForThreeMonth =
    effectiveDateForThreeMonthRule !== undefined
      ? parseDate(
          effectiveDateForThreeMonthRule != null && String(effectiveDateForThreeMonthRule).trim() !== ''
            ? String(effectiveDateForThreeMonthRule).trim()
            : null
        )
      : effDate
  const grace = CARRIER_GRACE_PERIODS[(carrierCode || '').toUpperCase()] ?? 31

  // If already in a manual stage, preserve it and do not overwrite.
  const normalizedExistingGhlStage = normalizeStageLabel(existingGhlStage)
  if (normalizedExistingGhlStage && MANUAL_APPROVAL_STAGES.has(normalizedExistingGhlStage)) {
    return normalizedExistingGhlStage
  }

  const stageSet = new Set(possibleStages)
  const isActPastDueStatus =
    statusCompact.includes('actpastdue') ||
    (statusLower.includes('act') && statusLower.includes('past') && statusLower.includes('due'))
  // FDPF only from the calendar day *after* effective (effective day itself stays Issued / pre-FDPF).
  const fdpfPendingReasonAllowed = isEffectiveDateFullyPassed(effDate, today)
  const selectPreFdpfStage = (): string => {
    if (stageSet.has('Issued - Pending First Draft')) return sanitizeManualStage('Issued - Pending First Draft')
    if (stageSet.has('Pending Approval')) return sanitizeManualStage('Pending Approval')
    return sanitizeManualStage('Issued - Pending First Draft')
  }
  // Withdrawn after >30 calendar days from deal *creation* only (not effective-date fallback).
  const pendingOlderThan30Days = (() => {
    if (!dealCreated) return false
    const createdDay = startOfLocalDay(dealCreated).getTime()
    const todayDay = startOfLocalDay(today).getTime()
    const days = Math.floor((todayDay - createdDay) / (1000 * 60 * 60 * 24))
    return days > 30
  })()

  // If the carrier/client initiated cancellation, prefer Chargeback Cancellation
  // even if the commission net looks like a chargeback (negative deal value).
  if (looksLikeInitiatedCancellation && stageSet.has('Chargeback Cancellation')) {
    return sanitizeManualStage('Chargeback Cancellation')
  }

  // ── Chargeback vs non-chargeback when deal_value is negative ────────
  if (dealValue != null && dealValue < 0) {
    if (stageSet.has('Chargeback Failed Payment')) return sanitizeManualStage('Chargeback Failed Payment')
    if (stageSet.has('Chargeback Cancellation')) return sanitizeManualStage('Chargeback Cancellation')
  }

  // "Act Past Due" handling (hard guard):
  // NEVER classify Act Past Due as Active Placed/Paid as Advanced.
  // within 31 calendar days from effective date -> Pending Lapse bucket
  // after 31 calendar days -> FDPF Pending Reason (issued-not-paid bucket)
  // if effective date is missing, default to Pending Lapse bucket when possible.
  if (isActPastDueStatus) {
    const pendingLapseStage = stageSet.has('Pending Lapse Pending Reason')
      ? 'Pending Lapse Pending Reason'
      : (stageSet.has('Pending Lapse') ? 'Pending Lapse' : null)
    const fdpfStage = stageSet.has('FDPF Pending Reason') ? 'FDPF Pending Reason' : null

    if (!effDate) {
      if (pendingLapseStage) return sanitizeManualStage(pendingLapseStage)
      if (fdpfStage && fdpfPendingReasonAllowed) return sanitizeManualStage(fdpfStage)
      return selectPreFdpfStage()
    }

    const cutoff = startOfLocalDay(effDate)
    cutoff.setDate(cutoff.getDate() + 31)
    const todayDay = startOfLocalDay(today)
    if (todayDay <= cutoff) {
      if (pendingLapseStage) return sanitizeManualStage(pendingLapseStage)
      return sanitizeManualStage('Pending Lapse')
    }
    if (!fdpfPendingReasonAllowed) return selectPreFdpfStage()
    if (fdpfStage) return sanitizeManualStage(fdpfStage)
    return sanitizeManualStage('FDPF Pending Reason')
  }

  // ── Rule 1: Issued - Pending First Draft vs FDPF Pending Reason ────
  if (stageSet.has('Issued - Pending First Draft') && stageSet.has('FDPF Pending Reason')) {
    if (fdpfPendingReasonAllowed) return sanitizeManualStage('FDPF Pending Reason')
    return sanitizeManualStage('Issued - Pending First Draft')
  }

  // ── Rule 2: Active / Premium Paid / Advanced / 3M+ / 6M+ / 9M ──────
  const hasAdvanced =
    stageSet.has('Active Placed - Paid as Advanced') ||
    stageSet.has('ACTIVE PLACED - Paid as Advanced')
  const hasEarned = stageSet.has('Active Placed - Paid as Earned')
  const hasThreeMonths = stageSet.has('ACTIVE - 3 Months +')
  const hasSixMonths = stageSet.has('ACTIVE - 6 months +')
  const hasNineMonths = stageSet.has('ACTIVE - 9 months')
  const hasPastCbPeriod = stageSet.has('ACTIVE - Past Charge-Back Period')
  const hasPremPaid = stageSet.has('Premium Paid - Commission Pending')
  const hasAnyActive =
    hasAdvanced || hasEarned || hasThreeMonths || hasSixMonths || hasNineMonths || hasPastCbPeriod || hasPremPaid

  if (hasAnyActive) {
    const alsoHasChargeback =
      stageSet.has('Chargeback Failed Payment') || stageSet.has('Chargeback Cancellation')

    if (alsoHasChargeback && dealValue != null && dealValue < 0) {
      return stageSet.has('Chargeback Failed Payment')
        ? sanitizeManualStage('Chargeback Failed Payment')
        : sanitizeManualStage('Chargeback Cancellation')
    }

    if (dealValue == null || dealValue <= 0) {
      if (hasPremPaid) return sanitizeManualStage('Premium Paid - Commission Pending')
    }

    if (dealValue != null && dealValue > 0) {
      // Time-based active milestones are progressive; always pick the highest
      // eligible milestone so older active policies do not stick on lower labels.
      if (qualifiesForMonthThreshold(effDateForThreeMonth, today, 9))
        return sanitizeManualStage('ACTIVE - 9 months')
      if (qualifiesForMonthThreshold(effDateForThreeMonth, today, 6))
        return sanitizeManualStage('ACTIVE - 6 months +')
      if (qualifiesForMonthThreshold(effDateForThreeMonth, today, 3))
        return sanitizeManualStage('ACTIVE - 3 Months +')

      if (commissionType) {
        const ct = commissionType.toLowerCase()
        if (ct.includes('advance') && hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
        if (ct.includes('earn') && hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
      }

      // Current business rule: we do not classify into "Paid as Earned".
      // Any paid policy is treated as "Paid as Advanced".
      if (hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
      return sanitizeManualStage('Active Placed - Paid as Advanced')

    }

    if (hasPremPaid) return sanitizeManualStage('Premium Paid - Commission Pending')
  }

  // ── Rule 3: Chargeback Failed Payment vs Chargeback Cancellation ───
  if (stageSet.has('Chargeback Failed Payment') && stageSet.has('Chargeback Cancellation')) {
    // Requested termination / client-initiated cancellation must stay Cancellation.
    if (looksLikeInitiatedCancellation) {
      return sanitizeManualStage('Chargeback Cancellation')
    }
    if (
      statusLower.includes('not taken') ||
      statusLower.includes('nottaken') ||
      statusLower.includes('non-take') ||
      statusLower.includes('nt no pay') ||
      statusLower.includes('not issued')
    ) {
      // "Not Taken" classification depends on when the carrier portal first reports it.
      // Do not reclassify existing Not Taken chargeback rows on subsequent uploads.
      if (
        existingGhlStage === 'Chargeback Cancellation' ||
        existingGhlStage === 'Chargeback Failed Payment'
      ) {
        return sanitizeManualStage(existingGhlStage)
      }
      if (effDate) {
        const cutoff = startOfLocalDay(effDate)
        cutoff.setDate(cutoff.getDate() + grace)
        const todayDay = startOfLocalDay(today)
        return todayDay <= cutoff
          ? sanitizeManualStage('Chargeback Cancellation')
          : sanitizeManualStage('Chargeback Failed Payment')
      }
      return sanitizeManualStage('Chargeback Failed Payment')
    }

    if (statusLower.includes('lapse')) return sanitizeManualStage('Chargeback Failed Payment')

    return sanitizeManualStage('Chargeback Failed Payment')
  }

  // ── Rule 4: Pending Lapse vs Chargeback Failed Payment ─────────────
  if (stageSet.has('Pending Lapse') && stageSet.has('Chargeback Failed Payment')) {
    if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) return sanitizeManualStage('Pending Lapse')
    if (existingGhlStage && PENDING_LAPSE_STAGES.has(existingGhlStage))
      return sanitizeManualStage('Chargeback Failed Payment')
    return sanitizeManualStage('Pending Lapse')
  }

  // ── Rule 5: Pending Approval vs Pending Manual Action ──────────────
  // Pending Manual Action is ONLY set manually by auditors
  if (stageSet.has('Pending Approval') && stageSet.has('Pending Manual Action')) {
    if (pendingOlderThan30Days) {
      return sanitizeManualStage('Application Withdrawn')
    }
    return sanitizeManualStage('Pending Approval')
  }

  // ── Rule 6: Pending Lapse sub-stages default to generic ────────────
  if (
    stageSet.has('Pending Lapse') &&
    (stageSet.has('Pending Lapse Insufficient Funds') ||
      stageSet.has('Pending Lapse Pending Reason') ||
      stageSet.has('Pending Lapse Unauthorized Draft') ||
      stageSet.has('Pending Lapse Incorrect Banking Info'))
  ) {
    return sanitizeManualStage('Pending Lapse')
  }

  // ── Rule 7: Application Withdrawn vs Pending Lapse ─────────────────
  if (stageSet.has('Application Withdrawn') && stageSet.has('Pending Lapse')) {
    if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) return sanitizeManualStage('Pending Lapse')
    return sanitizeManualStage('Application Withdrawn')
  }

  // ── Rule 8: Declined Underwriting vs Chargeback ────────────────────
  if (
    stageSet.has('Declined Underwriting') &&
    (stageSet.has('Chargeback Failed Payment') || stageSet.has('Chargeback Cancellation'))
  ) {
    if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) {
      return stageSet.has('Chargeback Failed Payment')
        ? sanitizeManualStage('Chargeback Failed Payment')
        : sanitizeManualStage('Chargeback Cancellation')
    }
    return sanitizeManualStage('Declined Underwriting')
  }

  // ── Rule 9: FDPF sub-stages default to generic ────────────────────
  if (
    stageSet.has('FDPF Pending Reason') &&
    (
      stageSet.has('FDPF Insufficient Funds') ||
      stageSet.has('FDPF Unauthorized Draft') ||
      stageSet.has('FDPF Incorrect Banking Info')
    )
  ) {
    if (!fdpfPendingReasonAllowed) return selectPreFdpfStage()
    return sanitizeManualStage('FDPF Pending Reason')
  }

  // ── Rule 10: Pending Approval vs Pending Lapse ─────────────────────
  if (stageSet.has('Pending Approval') && stageSet.has('Pending Lapse')) {
    if (pendingOlderThan30Days) {
      return sanitizeManualStage('Application Withdrawn')
    }
    if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) return sanitizeManualStage('Pending Lapse')
    return sanitizeManualStage('Pending Approval')
  }

  // ── Rule 11: Multi-target "past due" (ANAM Act-Pastdue) ───────────
  // Mix of FDPF + Pending Lapse + Chargeback
  const hasFdpf = stageSet.has('FDPF Pending Reason')
  const hasPendingLapse = stageSet.has('Pending Lapse')
  const hasChargebackFailed = stageSet.has('Chargeback Failed Payment')
  if (hasFdpf && hasPendingLapse && hasChargebackFailed) {
    if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) return sanitizeManualStage('Pending Lapse')
    if (existingGhlStage && ISSUED_STAGES.has(existingGhlStage)) {
      if (!fdpfPendingReasonAllowed) return selectPreFdpfStage()
      return sanitizeManualStage('FDPF Pending Reason')
    }
    if (existingGhlStage && PENDING_LAPSE_STAGES.has(existingGhlStage))
      return sanitizeManualStage('Chargeback Failed Payment')
    if (!fdpfPendingReasonAllowed) return sanitizeManualStage('Pending Lapse')
    return sanitizeManualStage('FDPF Pending Reason')
  }

  // ── Fallback: first mapping ────────────────────────────────────────
  const firstNonManual = possibleStages.find(s => !MANUAL_APPROVAL_STAGES.has(s))
  const fallback = sanitizeManualStage(firstNonManual ?? possibleStages[0])
  if (
    fallback === 'FDPF Pending Reason' ||
    fallback === 'FDPF Insufficient Funds' ||
    fallback === 'FDPF Unauthorized Draft' ||
    fallback === 'FDPF Incorrect Banking Info'
  ) {
    if (!fdpfPendingReasonAllowed) return selectPreFdpfStage()
    return sanitizeManualStage('FDPF Pending Reason')
  }
  if (fallback === 'Pending Approval') {
    if (pendingOlderThan30Days) {
      return sanitizeManualStage('Application Withdrawn')
    }
    return sanitizeManualStage('Pending Approval')
  }
  return fallback
}
