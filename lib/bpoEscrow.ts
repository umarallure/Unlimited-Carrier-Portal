/**
 * BPO Escrow — the calculation, and nothing else.
 *
 * Centers are invoiced every 14 days at 50% of the carrier commission. The escrow
 * holds back a share of each payout, capped per center, so chargebacks can still
 * be recovered after a center stops working with us.
 *
 * This module is deliberately free of any import — no Supabase, no React, no
 * `lib/invoicing`. Everything it needs arrives as arguments, so the whole of the
 * money logic is unit-testable without a database. Settings and balances are
 * loaded by `lib/bpoEscrowAccounts.ts`; invoice lines come from
 * `buildBpoInvoiceLines` in `lib/invoicing.ts`.
 *
 * PHASE 1: the result of `computeEscrow` is displayed only. Nothing is posted to
 * the escrow ledger and the invoice's balance due is unchanged, so a center is
 * still paid in full. See the plan before wiring this to anything that pays out.
 *
 * Rule references (R1, R5, …) are to the BPO Escrow functional specification.
 */

/** Where a line's money came from. Escrow only ever acts on a real statement. */
export type EscrowAmountBasis = 'commission_statement' | 'prorated_estimate' | 'deal_value'

export type EscrowLineClass =
  /** A commission the carrier paid before this cycle that was never invoiced (R5). */
  | 'escrow_deal'
  /** A normal sale line for this cycle. */
  | 'current'
  /** A chargeback; nets against current commissions in step 3. */
  | 'chargeback'
  /** Carries no money, so it takes no part in the split. */
  | 'ineligible'

export type EscrowSettings = {
  /** Global switch AND the center not being exempt — the caller resolves both. */
  enabled: boolean
  exempt: boolean
  capAmount: number
  holdRate: number
  /** Used while a draw is being replenished (R9). Phase 2. */
  postDrawHoldRate: number
}

export type EscrowAccountState = {
  /** Escrow held for this center today. Never negative. */
  balance: number
  /** Balance before the most recent unreplenished draw (R9); null = normal regime. */
  preDrawBalance: number | null
  /** What the center owes us from chargebacks, as a POSITIVE number (R6). */
  negativeBalance: number
}

export type EscrowInputLine = {
  id: string
  /** The center's 50% share. Positive for a sale, negative for a chargeback. */
  leadValue: number
  kind: 'sale' | 'chargeback'
  /**
   * True when this line repays a previous chargeback. A repay carries a real
   * statement amount but is not an uninvoiced past sale, so it must never be
   * treated as an escrow deal.
   */
  isRepay: boolean
  /** Date of the carrier statement this money came from; null when estimated. */
  commissionDate: string | null
  amountBasis: EscrowAmountBasis | null
}

export type EscrowClassifiedLine = {
  id: string
  klass: EscrowLineClass
  amount: number
}

export type EscrowComputation = {
  status: 'applied' | 'disabled' | 'exempt' | 'no_lines'
  lines: EscrowClassifiedLine[]
  warnings: string[]

  capAmount: number
  holdRateUsed: number
  openingBalance: number

  // Steps 1-2 — earlier unpaid commissions (R5)
  escrowDealsCenterShare: number
  escrowDealsToEscrow: number
  escrowDealsExcessToPayout: number

  // Step 3 — this cycle's commissions
  currentCommissions: number
  /** Zero or negative. */
  chargebacks: number
  netCommissions: number

  // Step 4 — the center's debt is paid down first (R6)
  negativeBalanceOpening: number
  negativeBalanceApplied: number
  negativeBalanceRemaining: number
  /**
   * The part of this cycle that went unpaid because chargebacks outran
   * commissions. Carried into negativeBalanceRemaining, and needed to check the
   * split balances: the parts sum to the whole only once it is subtracted.
   */
  shortfall: number

  // Steps 5-6 — hold, then pay
  positiveRemainder: number
  hold: number
  payout: number

  // Step 7
  closingBalance: number
  capRemaining: number

  /** Everything the center earned this cycle, before any escrow treatment. */
  draftCenterShare: number
  /**
   * True when the split accounts for every cent of `draftCenterShare`. The invoice
   * must not show an escrow block when this is false.
   */
  reconciles: boolean
}

export const ESCROW_DEFAULT_CAP = 10000
export const ESCROW_DEFAULT_HOLD_RATE = 0.2
export const ESCROW_DEFAULT_POST_DRAW_HOLD_RATE = 0.3

/** Same half-up rule as `roundMoney` in lib/invoicing.ts — keep the two identical. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function clampAtZero(value: number): number {
  return value > 0 ? value : 0
}

/**
 * Decide what part a line plays in the split.
 *
 * Only a line backed by a real carrier statement dated before the cycle start is
 * an escrow deal. In today's invoice builder that can only ever be a `cp-deal-`
 * catch-up line: real commission lines are fetched with a date filter of
 * `[cycleStart, cycleEnd]`, so by construction none of them predates the cycle.
 *
 * A pro-rated line is explicitly NOT an escrow deal. Its amount is a nine-month
 * estimate from `deal_value`, not money the carrier has paid, and the only date
 * it carries is a policy date that almost always predates the cycle — so trusting
 * it would route nearly every catch-up line into escrow and hold real cash
 * against invented amounts.
 */
export function classifyEscrowLine(
  line: EscrowInputLine,
  cycleStart: string,
  cycleEnd: string
): { klass: EscrowLineClass; warning?: string } {
  if (line.kind === 'chargeback') return { klass: 'chargeback' }
  if (!Number.isFinite(line.leadValue) || line.leadValue === 0) return { klass: 'ineligible' }
  if (line.leadValue < 0) return { klass: 'chargeback' }

  if (line.isRepay) return { klass: 'current' }
  if (line.amountBasis !== 'commission_statement') return { klass: 'current' }
  if (!line.commissionDate) return { klass: 'current' }

  // The commission-facts lookup is not bounded by the cycle, so "latest statement"
  // can post-date it. Those are this cycle's business at the earliest, never an
  // earlier unpaid amount.
  if (line.commissionDate > cycleEnd) {
    return {
      klass: 'current',
      warning: `Line ${line.id} carries a commission date of ${line.commissionDate}, after the cycle ends (${cycleEnd}); treated as current.`,
    }
  }

  if (line.commissionDate < cycleStart) return { klass: 'escrow_deal' }
  return { klass: 'current' }
}

function emptyComputation(
  status: EscrowComputation['status'],
  settings: EscrowSettings,
  account: EscrowAccountState
): EscrowComputation {
  return {
    status,
    lines: [],
    warnings: [],
    capAmount: settings.capAmount,
    holdRateUsed: 0,
    openingBalance: account.balance,
    escrowDealsCenterShare: 0,
    escrowDealsToEscrow: 0,
    escrowDealsExcessToPayout: 0,
    currentCommissions: 0,
    chargebacks: 0,
    netCommissions: 0,
    negativeBalanceOpening: account.negativeBalance,
    negativeBalanceApplied: 0,
    negativeBalanceRemaining: account.negativeBalance,
    shortfall: 0,
    positiveRemainder: 0,
    hold: 0,
    payout: 0,
    closingBalance: account.balance,
    capRemaining: round2(clampAtZero(settings.capAmount - account.balance)),
    draftCenterShare: 0,
    reconciles: true,
  }
}

/**
 * The seven steps from the specification, in order.
 *
 * Two details decide whether the result lands on the right cent:
 *
 *  - Escrow deals consume cap room BEFORE the hold is worked out, so a center near
 *    the cap can take its earlier unpaid money into escrow and still hold nothing.
 *  - The hold is rounded and the payout derived by subtraction. Rounding both
 *    independently breaks the identity that the parts sum to the whole.
 */
export function computeEscrow(input: {
  lines: EscrowInputLine[]
  cycleStart: string
  cycleEnd: string
  settings: EscrowSettings
  account: EscrowAccountState
}): EscrowComputation {
  const { lines, cycleStart, cycleEnd, settings, account } = input

  if (!settings.enabled) return emptyComputation('disabled', settings, account)
  if (settings.exempt) return emptyComputation('exempt', settings, account)
  if (!lines.length) return emptyComputation('no_lines', settings, account)

  // ─── Step 1: split the lines ───
  const classified: EscrowClassifiedLine[] = []
  const warnings: string[] = []
  let escrowDealsCenterShare = 0
  let currentCommissions = 0
  let chargebacks = 0

  for (const line of lines) {
    const { klass, warning } = classifyEscrowLine(line, cycleStart, cycleEnd)
    if (warning) warnings.push(warning)
    classified.push({ id: line.id, klass, amount: line.leadValue })
    if (klass === 'escrow_deal') escrowDealsCenterShare += line.leadValue
    else if (klass === 'current') currentCommissions += line.leadValue
    else if (klass === 'chargeback') chargebacks += line.leadValue
  }

  escrowDealsCenterShare = round2(escrowDealsCenterShare)
  currentCommissions = round2(currentCommissions)
  chargebacks = round2(chargebacks)

  const openingBalance = round2(account.balance)
  const capAmount = round2(settings.capAmount)

  // ─── Step 2: earlier unpaid amounts go to escrow, up to the cap (R2, R5) ───
  const capRoomForDeals = clampAtZero(round2(capAmount - openingBalance))
  const escrowDealsToEscrow = round2(Math.min(clampAtZero(escrowDealsCenterShare), capRoomForDeals))
  // Anything over the cap is paid now, and is NOT subjected to the hold.
  const escrowDealsExcessToPayout = round2(escrowDealsCenterShare - escrowDealsToEscrow)

  // ─── Step 3: net commissions for this cycle ───
  const netCommissions = round2(currentCommissions + chargebacks)

  // ─── Step 4: the center's debt is paid down first (R6) ───
  const negativeBalanceOpening = round2(clampAtZero(account.negativeBalance))
  const negativeBalanceApplied = round2(Math.min(clampAtZero(netCommissions), negativeBalanceOpening))
  const remainderAfterNegative = round2(netCommissions - negativeBalanceApplied)

  // A cycle that is itself negative grows the debt and carries it forward, as today.
  const shortfall = round2(clampAtZero(-remainderAfterNegative))
  const negativeBalanceRemaining = round2(negativeBalanceOpening - negativeBalanceApplied + shortfall)
  const positiveRemainder = round2(clampAtZero(remainderAfterNegative))

  // ─── Step 5: hold, never past the cap (R1, R2, R9) ───
  const balanceAfterDeals = round2(openingBalance + escrowDealsToEscrow)
  const holdRateUsed =
    account.preDrawBalance != null && account.balance < account.preDrawBalance
      ? settings.postDrawHoldRate
      : settings.holdRate
  const capRoomForHold = clampAtZero(round2(capAmount - balanceAfterDeals))
  const hold = round2(clampAtZero(Math.min(holdRateUsed * positiveRemainder, capRoomForHold)))

  // ─── Step 6: the rest is the payout ───
  const payout = round2(clampAtZero(round2(positiveRemainder - hold) + escrowDealsExcessToPayout))

  // ─── Step 7: the new balance ───
  const closingBalance = round2(balanceAfterDeals + hold)
  const capRemaining = round2(clampAtZero(capAmount - closingBalance))

  const draftCenterShare = round2(escrowDealsCenterShare + netCommissions)
  const accountedFor = round2(
    payout + hold + escrowDealsToEscrow + negativeBalanceApplied - shortfall
  )
  const reconciles = Math.abs(accountedFor - draftCenterShare) < 0.005

  if (!reconciles) {
    warnings.push(
      `Escrow split does not balance: ${accountedFor.toFixed(2)} accounted for against a center share of ${draftCenterShare.toFixed(2)}.`
    )
  }

  return {
    status: 'applied',
    lines: classified,
    warnings,
    capAmount,
    holdRateUsed,
    openingBalance,
    escrowDealsCenterShare,
    escrowDealsToEscrow,
    escrowDealsExcessToPayout,
    currentCommissions,
    chargebacks,
    netCommissions,
    negativeBalanceOpening,
    negativeBalanceApplied,
    negativeBalanceRemaining,
    shortfall,
    positiveRemainder,
    hold,
    payout,
    closingBalance,
    capRemaining,
    draftCenterShare,
    reconciles,
  }
}
