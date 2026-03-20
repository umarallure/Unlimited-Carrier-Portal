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
])

const ISSUED_STAGES = new Set([
  'Issued - Pending First Draft',
  'FDPF Pending Reason',
  'FDPF Insufficient Funds',
  'FDPF Incorrect Banking Info',
])

const PENDING_LAPSE_STAGES = new Set([
  'Pending Lapse',
  'Pending Lapse Insufficient Funds',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Unauthorized Draft',
  'Pending Lapse Pending Reason',
])

/**
 * Stages that require manual auditing/approval.
 * During auto-mapping we must never overwrite an existing manual stage,
 * and we must not auto-set a record into these manual stages.
 */
const MANUAL_APPROVAL_STAGES = new Set([
  'Pending Manual Action',
  'FDPF Insufficient Funds',
  'FDPF Incorrect Banking Info',
])

const MANUAL_STAGE_SAFE_PARENT: Record<string, string> = {
  'Pending Manual Action': 'Pending Approval',
  'FDPF Insufficient Funds': 'FDPF Pending Reason',
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
  'Premium Paid - Commission Pending',
  'Active Placed - Paid as Advanced',
  'Active Placed - Paid as Earned',
  'ACTIVE - 3 Months +',
  'Pending Lapse',
  'Pending Lapse Insufficient Funds',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Unauthorized Draft',
  'Pending Lapse Pending Reason',
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
    ],
  },
  {
    key: 'pendingLapse',
    label: 'Pending Lapse',
    color: '#f97316',
    stages: [
      'Pending Lapse',
      'Pending Lapse Insufficient Funds',
      'Pending Lapse Incorrect Banking Info',
      'Pending Lapse Unauthorized Draft',
      'Pending Lapse Pending Reason',
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
  if (!dateStr) return null
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? null : d
}

function monthsBetween(d1: Date, d2: Date): number {
  return (d2.getFullYear() - d1.getFullYear()) * 12 + (d2.getMonth() - d1.getMonth())
}

export interface GhlStageResolutionContext {
  carrierStatus: string | null
  allMappings: Map<string, string[]>
  effectiveDate: string | null
  dealValue: number | null
  commissionType: string | null
  existingGhlStage: string | null
  carrierCode: string | null
}

/**
 * Resolve the correct GHL stage from multiple possible mappings using
 * time, commission, previous-stage, and grace-period conditions.
 */
export function resolveGhlStage(ctx: GhlStageResolutionContext): string | null {
  const {
    carrierStatus,
    allMappings,
    effectiveDate,
    dealValue,
    commissionType,
    existingGhlStage,
    carrierCode,
  } = ctx

  if (!carrierStatus) return null
  let possibleStages = allMappings.get(carrierStatus)
  if (!possibleStages || possibleStages.length === 0) return null
  const sanitizeManualStage = (stage: string): string => {
    if (!MANUAL_APPROVAL_STAGES.has(stage)) return stage
    return MANUAL_STAGE_SAFE_PARENT[stage] ?? stage
  }
  const addStageIfMissing = (stage: string) => {
    if (!possibleStages) return
    if (!possibleStages.includes(stage)) possibleStages.push(stage)
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
    } else {
      return sanitizeManualStage(only)
    }
  }

  const stageOrderIndex = (stage: string): number => {
    const idx = GHL_STAGE_ORDER.findIndex(s => s.toLowerCase() === stage.toLowerCase())
    return idx
  }

  const today = new Date()
  const effDate = parseDate(effectiveDate)
  const grace = CARRIER_GRACE_PERIODS[(carrierCode || '').toUpperCase()] ?? 31
  const statusLower = carrierStatus.toLowerCase()
  const looksLikeInitiatedCancellation =
    statusLower.includes('terminat') ||
    statusLower.includes('cancel') ||
    statusLower.includes('surrender') ||
    statusLower.includes('free look')

  // If already in a manual stage, preserve it and do not overwrite.
  if (existingGhlStage && MANUAL_APPROVAL_STAGES.has(existingGhlStage)) {
    return existingGhlStage
  }

  // When financial signals are missing (dealValue null/0), avoid "downgrades"
  // to earlier stages. This prevents Active -> Premium Paid flips on runs
  // that didn't include commission amounts.
  const missingFinancialSignals = dealValue == null || dealValue === 0
  if (missingFinancialSignals && existingGhlStage) {
    const existingIdx = stageOrderIndex(existingGhlStage)
    if (existingIdx >= 0) {
      const filtered = possibleStages.filter(s => stageOrderIndex(s) >= existingIdx)
      if (filtered.length > 0) possibleStages = filtered
    }
  }

  const stageSet = new Set(possibleStages)

  // Prevent backward transitions:
  // If the deal is already in an Active stage, don't auto-downgrade it to
  // "Premium Paid - Commission Pending" just because the current import run
  // didn't include commission/financial signals (dealValue null/<=0).
  // Manual forward moves should still work via the Kanban "Move" action.
  if (
    existingGhlStage &&
    ACTIVE_STAGES.has(existingGhlStage) &&
    stageSet.has('Premium Paid - Commission Pending')
  ) {
    // Only protect when we actually have missing/zero financial signals.
    // If deal_value just became positive (commission paid), we must allow
    // promotion to Earned/Advanced.
    if (dealValue == null || dealValue <= 0) return existingGhlStage
  }

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

  // ── Rule 1: Issued - Pending First Draft vs FDPF Pending Reason ────
  if (stageSet.has('Issued - Pending First Draft') && stageSet.has('FDPF Pending Reason')) {
    if (effDate && today > effDate) return sanitizeManualStage('FDPF Pending Reason')
    return sanitizeManualStage('Issued - Pending First Draft')
  }

  // ── Rule 2: Active / Premium Paid / Advanced / Earned / 3M+ ────────
  const hasAdvanced =
    stageSet.has('Active Placed - Paid as Advanced') ||
    stageSet.has('ACTIVE PLACED - Paid as Advanced')
  const hasEarned = stageSet.has('Active Placed - Paid as Earned')
  const has3M = stageSet.has('ACTIVE - 3 Months +')
  const hasPremPaid = stageSet.has('Premium Paid - Commission Pending')
  const hasAnyActive = hasAdvanced || hasEarned || has3M || hasPremPaid

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
      if (existingGhlStage && ACTIVE_STAGES.has(existingGhlStage)) return existingGhlStage
    }

    if (dealValue != null && dealValue > 0) {
      if (has3M && effDate && monthsBetween(effDate, today) >= 3) return sanitizeManualStage('ACTIVE - 3 Months +')

      if (commissionType) {
        const ct = commissionType.toLowerCase()
        if (ct.includes('advance') && hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
        if (ct.includes('earn') && hasEarned) return sanitizeManualStage('Active Placed - Paid as Earned')
      }

      // Business rule: paid amount under 300 = earned, otherwise advanced.
      // Apply even when a carrier mapping only exposes a subset of active stages.
      if (dealValue < 300) {
        if (hasEarned) return sanitizeManualStage('Active Placed - Paid as Earned')
        return sanitizeManualStage('Active Placed - Paid as Earned')
      }
      if (dealValue >= 300) {
        if (hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
        return sanitizeManualStage('Active Placed - Paid as Advanced')
      }

      if (hasAdvanced) return sanitizeManualStage('Active Placed - Paid as Advanced')
      if (hasEarned) return sanitizeManualStage('Active Placed - Paid as Earned')
      if (has3M) return sanitizeManualStage('ACTIVE - 3 Months +')
      if (hasPremPaid) return sanitizeManualStage('Premium Paid - Commission Pending')
    }

    if (hasPremPaid) return sanitizeManualStage('Premium Paid - Commission Pending')
  }

  // ── Rule 3: Chargeback Failed Payment vs Chargeback Cancellation ───
  if (stageSet.has('Chargeback Failed Payment') && stageSet.has('Chargeback Cancellation')) {
    if (
      statusLower.includes('not taken') ||
      statusLower.includes('nottaken') ||
      statusLower.includes('non-take') ||
      statusLower.includes('nt no pay') ||
      statusLower.includes('not issued')
    ) {
      if (effDate) {
        const cutoff = new Date(effDate)
        cutoff.setDate(cutoff.getDate() + grace)
        return today <= cutoff
          ? sanitizeManualStage('Chargeback Cancellation')
          : sanitizeManualStage('Chargeback Failed Payment')
      }
      return sanitizeManualStage('Chargeback Failed Payment')
    }

    if (statusLower.includes('lapse')) return sanitizeManualStage('Chargeback Failed Payment')

    if (
      looksLikeInitiatedCancellation
    ) {
      return sanitizeManualStage('Chargeback Cancellation')
    }

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
    (stageSet.has('FDPF Insufficient Funds') || stageSet.has('FDPF Incorrect Banking Info'))
  ) {
    return sanitizeManualStage('FDPF Pending Reason')
  }

  // ── Rule 10: Pending Approval vs Pending Lapse ─────────────────────
  if (stageSet.has('Pending Approval') && stageSet.has('Pending Lapse')) {
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
    if (existingGhlStage && ISSUED_STAGES.has(existingGhlStage)) return sanitizeManualStage('FDPF Pending Reason')
    if (existingGhlStage && PENDING_LAPSE_STAGES.has(existingGhlStage))
      return sanitizeManualStage('Chargeback Failed Payment')
    return sanitizeManualStage('FDPF Pending Reason')
  }

  // ── Fallback: first mapping ────────────────────────────────────────
  const firstNonManual = possibleStages.find(s => !MANUAL_APPROVAL_STAGES.has(s))
  return sanitizeManualStage(firstNonManual ?? possibleStages[0])
}
