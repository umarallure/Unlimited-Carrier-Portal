import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ESCROW_DEFAULT_CAP,
  ESCROW_DEFAULT_HOLD_RATE,
  ESCROW_DEFAULT_POST_DRAW_HOLD_RATE,
  classifyEscrowLine,
  computeEscrow,
  round2,
  type EscrowAccountState,
  type EscrowInputLine,
  type EscrowSettings,
} from './bpoEscrow'

const CYCLE_START = '2026-09-30'
const CYCLE_END = '2026-10-13'

const SETTINGS: EscrowSettings = {
  enabled: true,
  exempt: false,
  capAmount: ESCROW_DEFAULT_CAP,
  holdRate: ESCROW_DEFAULT_HOLD_RATE,
  postDrawHoldRate: ESCROW_DEFAULT_POST_DRAW_HOLD_RATE,
}

const FRESH: EscrowAccountState = { balance: 0, preDrawBalance: null, negativeBalance: 0 }

/** A normal sale commissioned inside the cycle. */
function sale(id: string, leadValue: number, commissionDate = '2026-10-02'): EscrowInputLine {
  return { id, leadValue, kind: 'sale', isRepay: false, commissionDate, amountBasis: 'commission_statement' }
}

/** A catch-up line for a commission the carrier paid before the cycle started. */
function escrowDeal(id: string, leadValue: number, commissionDate: string): EscrowInputLine {
  return { id, leadValue, kind: 'sale', isRepay: false, commissionDate, amountBasis: 'commission_statement' }
}

function chargeback(id: string, leadValue: number): EscrowInputLine {
  return {
    id,
    leadValue: -Math.abs(leadValue),
    kind: 'chargeback',
    isRepay: false,
    commissionDate: '2026-10-05',
    amountBasis: 'commission_statement',
  }
}

function run(
  lines: EscrowInputLine[],
  account: Partial<EscrowAccountState> = {},
  settings: Partial<EscrowSettings> = {}
) {
  return computeEscrow({
    lines,
    cycleStart: CYCLE_START,
    cycleEnd: CYCLE_END,
    settings: { ...SETTINGS, ...settings },
    account: { ...FRESH, ...account },
  })
}

// ───────────────────────── classification ─────────────────────────

test('a commission paid before the cycle started is an escrow deal', () => {
  const { klass } = classifyEscrowLine(escrowDeal('a', 590.79, '2026-09-24'), CYCLE_START, CYCLE_END)
  assert.equal(klass, 'escrow_deal')
})

test('a commission paid inside the cycle is current, never an escrow deal', () => {
  // Real commission lines are fetched with a date filter of [start, end], so this
  // is the only thing they can ever be.
  assert.equal(classifyEscrowLine(sale('a', 100, '2026-09-30'), CYCLE_START, CYCLE_END).klass, 'current')
  assert.equal(classifyEscrowLine(sale('b', 100, '2026-10-13'), CYCLE_START, CYCLE_END).klass, 'current')
})

test('a pro-rated estimate is never an escrow deal, whatever date it carries', () => {
  const prorated: EscrowInputLine = {
    id: 'cp-deal-x',
    leadValue: 400,
    kind: 'sale',
    isRepay: false,
    commissionDate: '2026-01-01',
    amountBasis: 'prorated_estimate',
  }
  assert.equal(classifyEscrowLine(prorated, CYCLE_START, CYCLE_END).klass, 'current')
})

test('a line with no commission date is current, not escrow', () => {
  const noDate: EscrowInputLine = {
    id: 'stage-cb-x',
    leadValue: 250,
    kind: 'sale',
    isRepay: false,
    commissionDate: null,
    amountBasis: 'deal_value',
  }
  assert.equal(classifyEscrowLine(noDate, CYCLE_START, CYCLE_END).klass, 'current')
})

test('a repay is current even though it carries a real earlier statement', () => {
  // It repays a prior chargeback; it is not an uninvoiced past sale.
  const repay: EscrowInputLine = {
    id: 'cp-deal-r',
    leadValue: 300,
    kind: 'sale',
    isRepay: true,
    commissionDate: '2026-08-01',
    amountBasis: 'commission_statement',
  }
  assert.equal(classifyEscrowLine(repay, CYCLE_START, CYCLE_END).klass, 'current')
})

test('a commission dated after the cycle ends is current, and says so', () => {
  const future = escrowDeal('a', 500, '2026-11-20')
  const { klass, warning } = classifyEscrowLine(future, CYCLE_START, CYCLE_END)
  assert.equal(klass, 'current')
  assert.match(String(warning), /after the cycle ends/)
})

test('a zero-value line takes no part in the split', () => {
  assert.equal(classifyEscrowLine(sale('a', 0), CYCLE_START, CYCLE_END).klass, 'ineligible')
})

// ───────────────── worked examples from the specification ─────────────────

test('example 1 — normal cycle: net 6,000, no debt, escrow 0', () => {
  const r = run([sale('a', 6000)])
  assert.equal(r.status, 'applied')
  assert.equal(r.hold, 1200)
  assert.equal(r.payout, 4800)
  assert.equal(r.closingBalance, 1200)
  assert.equal(r.reconciles, true)
})

test('example 2 — center owes 2,000: net 5,000 pays the debt first', () => {
  const r = run([sale('a', 5000)], { negativeBalance: 2000 })
  assert.equal(r.negativeBalanceApplied, 2000)
  assert.equal(r.negativeBalanceRemaining, 0)
  assert.equal(r.positiveRemainder, 3000)
  assert.equal(r.hold, 600)
  assert.equal(r.payout, 2400)
  assert.equal(r.reconciles, true)
})

test('example 3 — close to the cap: escrow 9,500, net 6,000 holds only 500', () => {
  const r = run([sale('a', 6000)], { balance: 9500 })
  assert.equal(r.hold, 500, 'the hold stops at the cap, not at 20%')
  assert.equal(r.payout, 5500)
  assert.equal(r.closingBalance, 10000)
  assert.equal(r.capRemaining, 0)
  assert.equal(r.reconciles, true)
})

test('example 3 continued — at the cap, nothing more is held', () => {
  const r = run([sale('a', 6000)], { balance: 10000 })
  assert.equal(r.hold, 0)
  assert.equal(r.payout, 6000)
  assert.equal(r.closingBalance, 10000)
})

test('example 4 — replenishing a draw holds 30% instead of 20%', () => {
  const r = run([sale('a', 6000)], { balance: 6000, preDrawBalance: 10000 })
  assert.equal(r.holdRateUsed, 0.3)
  assert.equal(r.hold, 1800)
  assert.equal(r.payout, 4200)
  assert.equal(r.closingBalance, 7800)
})

test('example 5 — 14,000 earlier unpaid: 10,000 to escrow, 4,000 paid now', () => {
  const r = run([escrowDeal('a', 14000, '2026-09-10')])
  assert.equal(r.escrowDealsCenterShare, 14000)
  assert.equal(r.escrowDealsToEscrow, 10000)
  assert.equal(r.escrowDealsExcessToPayout, 4000)
  assert.equal(r.payout, 4000)
  assert.equal(r.hold, 0, 'the excess is paid out, it is not held again')
  assert.equal(r.closingBalance, 10000)
  assert.equal(r.reconciles, true)
})

test('example 5 continued — 3,000 earlier unpaid all goes to escrow and the hold continues', () => {
  const r = run([escrowDeal('a', 3000, '2026-09-10'), sale('b', 1000)])
  assert.equal(r.escrowDealsToEscrow, 3000)
  assert.equal(r.escrowDealsExcessToPayout, 0)
  assert.equal(r.hold, 200, '20% of the current 1,000 is still held')
  assert.equal(r.payout, 800)
  assert.equal(r.closingBalance, 3200)
  assert.equal(r.reconciles, true)
})

// ───────────────────── the Connect X cycle, end to end ─────────────────────

test('Connect X, Sep 30 - Oct 13 2026, reproduces the spec to the cent', () => {
  const r = run([
    // Commissioned before the cycle, never invoiced.
    escrowDeal('cp-deal-genereau', 590.79, '2026-09-24'),
    escrowDeal('cp-deal-church', 359.37, '2026-09-26'),
    // The 17 current deals, as one line of the same total.
    sale('current-17', 7595.11),
  ])

  assert.equal(r.draftCenterShare, 8545.27)
  assert.equal(r.escrowDealsCenterShare, 950.16)
  assert.equal(r.escrowDealsToEscrow, 950.16)
  assert.equal(r.currentCommissions, 7595.11)
  assert.equal(r.chargebacks, 0)
  assert.equal(r.negativeBalanceApplied, 0)
  assert.equal(r.hold, 1519.02)
  assert.equal(r.payout, 6076.09)
  assert.equal(r.closingBalance, 2469.18)
  assert.equal(r.capRemaining, 7530.82)
  assert.equal(r.reconciles, true)
  assert.deepEqual(r.warnings, [])

  // The whole point: nothing is lost between the draft and the split.
  assert.equal(round2(r.payout + r.closingBalance), r.draftCenterShare)
})

// ───────────────────────── edges that move money ─────────────────────────

test('escrow deals consume cap room before the hold is worked out', () => {
  // 600 of room: the deals take 400, leaving 200 for the hold even though 20%
  // of the current 5,000 would otherwise be 1,000.
  const r = run([escrowDeal('a', 400, '2026-09-15'), sale('b', 5000)], { balance: 9400 })
  assert.equal(r.escrowDealsToEscrow, 400)
  assert.equal(r.hold, 200)
  assert.equal(r.payout, 4800)
  assert.equal(r.closingBalance, 10000)
  assert.equal(r.reconciles, true)
})

test('a cycle with more chargebacks than commissions holds nothing and pays nothing', () => {
  const r = run([sale('a', 1000), chargeback('b', 1500)])
  assert.equal(r.netCommissions, -500)
  assert.equal(r.hold, 0, 'a negative remainder must never release escrow')
  assert.equal(r.payout, 0)
  assert.equal(r.closingBalance, 0)
  assert.equal(r.negativeBalanceRemaining, 500, 'the shortfall carries forward')
  assert.equal(r.reconciles, true)
})

test('an existing debt grows when the cycle is itself negative', () => {
  const r = run([chargeback('a', 300)], { negativeBalance: 700 })
  assert.equal(r.negativeBalanceApplied, 0)
  assert.equal(r.negativeBalanceRemaining, 1000)
  assert.equal(r.payout, 0)
  assert.equal(r.reconciles, true)
})

test('a debt larger than the cycle is only partly paid down', () => {
  const r = run([sale('a', 1000)], { negativeBalance: 2500 })
  assert.equal(r.negativeBalanceApplied, 1000)
  assert.equal(r.negativeBalanceRemaining, 1500)
  assert.equal(r.positiveRemainder, 0)
  assert.equal(r.hold, 0, 'holding only starts once the balance is cleared')
  assert.equal(r.payout, 0)
  assert.equal(r.reconciles, true)
})

test('the parts account for every cent, which is what the posting function re-checks', () => {
  // post_invoice_with_escrow recomputes exactly this before writing anything and
  // aborts the whole transaction if it does not hold, so a UI bug cannot quietly
  // post a wrong liability. Keep the two in step.
  const cases = [
    run([escrowDeal('a', 950.16, '2026-09-24'), sale('b', 7595.11)]),
    run([sale('a', 5000)], { negativeBalance: 2000 }),
    run([sale('a', 6000)], { balance: 9500 }),
    run([escrowDeal('a', 14000, '2026-09-10')]),
    run([sale('a', 1000), chargeback('b', 1500)]),
    run([sale('a', 1234.57), chargeback('b', 99.99)], { balance: 123.45, negativeBalance: 50 }),
  ]
  for (const r of cases) {
    const accounted = round2(
      r.payout + r.hold + r.escrowDealsToEscrow + r.negativeBalanceApplied - r.shortfall
    )
    assert.equal(accounted, r.draftCenterShare, `split does not balance: ${JSON.stringify(r)}`)
    assert.equal(r.reconciles, true)
  }
})

test('shortfall is non-zero only when the cycle itself went backwards', () => {
  assert.equal(run([sale('a', 1000)]).shortfall, 0)
  assert.equal(run([sale('a', 1000), chargeback('b', 1500)]).shortfall, 500)
  assert.equal(run([chargeback('a', 300)], { negativeBalance: 700 }).shortfall, 300)
})

test('the closing balance is the opening balance plus everything that went in', () => {
  const r = run([escrowDeal('a', 400, '2026-09-15'), sale('b', 5000)], { balance: 1000 })
  assert.equal(round2(r.openingBalance + r.escrowDealsToEscrow + r.hold), r.closingBalance)
})

test('chargebacks net against current commissions before the hold', () => {
  const r = run([sale('a', 5000), chargeback('b', 1000)])
  assert.equal(r.netCommissions, 4000)
  assert.equal(r.hold, 800)
  assert.equal(r.payout, 3200)
  assert.equal(r.reconciles, true)
})

test('the hold is rounded and the payout derived, so the parts sum to the whole', () => {
  // 20% of 7,595.11 is 1,519.022 — rounding both sides independently would lose a cent.
  const r = run([sale('a', 7595.11)])
  assert.equal(r.hold, 1519.02)
  assert.equal(r.payout, 6076.09)
  assert.equal(round2(r.hold + r.payout), 7595.11)
})

// ─────────────────────────── the switch ───────────────────────────

test('the global switch off leaves the invoice exactly as today', () => {
  const r = run([escrowDeal('a', 950.16, '2026-09-24'), sale('b', 7595.11)], {}, { enabled: false })
  assert.equal(r.status, 'disabled')
  assert.equal(r.hold, 0)
  assert.equal(r.escrowDealsToEscrow, 0)
  assert.equal(r.payout, 0)
  assert.deepEqual(r.lines, [])
})

test('an exempt center is calculated as today', () => {
  const r = run([escrowDeal('a', 950.16, '2026-09-24'), sale('b', 7595.11)], {}, { exempt: true })
  assert.equal(r.status, 'exempt')
  assert.equal(r.hold, 0)
  assert.equal(r.escrowDealsToEscrow, 0)
})

test('a center with no lines reports no_lines rather than a zeroed split', () => {
  assert.equal(run([]).status, 'no_lines')
})

test('an exempt or disabled center still reports its balance untouched', () => {
  const r = run([sale('a', 1000)], { balance: 4321.5 }, { enabled: false })
  assert.equal(r.openingBalance, 4321.5)
  assert.equal(r.closingBalance, 4321.5)
})
