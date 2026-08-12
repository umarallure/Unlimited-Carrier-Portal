import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toYmd,
  toNumber,
  daysBetween,
  addMonths,
  isInstallmentPayer,
  resolveCycleDays,
  deriveGraceByCompany,
  resolveTier,
  dedupeByLatestPaidTo,
  detectLapseRisk,
  mapSheetRows,
  type PolicyRow,
} from './lapseRisk'

/**
 * Fixtures are dated against this snapshot. The real policySummary export this
 * was built from (Aug 12 2026: 217 active, grace 45 from 68/69 lapsed rows,
 * 24 at-risk = 20 CRITICAL / 0 HIGH / 4 EARLY, $15,806.29, 0 NSF, 6 pending
 * first draft) cannot be committed — it is customer data — so the spec's rules
 * are pinned here with synthetic rows instead.
 */
const TODAY = '2026-08-12'

function policy(overrides: Partial<PolicyRow>): PolicyRow {
  return {
    company_code: 'AMH',
    policy_number: 'AMH0000001',
    status_category: 'Active',
    insured: 'Test Insured',
    phone: '(555) 555-5555',
    state: 'TX',
    agent: 'Test Agent',
    pay_mode: 'M',
    effective_date: '2026-01-01',
    paid_to_date: '2026-09-01',
    term_date: null,
    last_payment: '2026-08-03',
    last_pay_amount: 100,
    modal_premium: 100,
    annual_premium: 1200,
    ...overrides,
  }
}

// ── coercion ───────────────────────────────────────────────────────────────

test('toYmd: ISO strings, US dates, Date objects, junk', () => {
  assert.equal(toYmd('2026-07-22'), '2026-07-22')
  assert.equal(toYmd('2026-7-2'), '2026-07-02')
  assert.equal(toYmd('7/22/2026'), '2026-07-22')
  assert.equal(toYmd(new Date(Date.UTC(2026, 6, 22))), '2026-07-22')
  assert.equal(toYmd(''), null)
  assert.equal(toYmd(null), null)
  assert.equal(toYmd('not a date'), null)
})

test('toYmd: Excel serial numbers', () => {
  // 1900 date system: serial 44927 = 2023-01-01, so 45000 = 2023-03-15.
  assert.equal(toYmd(45000), '2023-03-15')
  assert.equal(toYmd(46246), '2026-08-12')
  // Out-of-range numbers are not dates (e.g. a stray premium value).
  assert.equal(toYmd(100), null)
})

test('toNumber: currency, parens negatives, junk', () => {
  assert.equal(toNumber('$1,234.56'), 1234.56)
  assert.equal(toNumber('(12.00)'), -12)
  assert.equal(toNumber(29.37), 29.37)
  assert.equal(toNumber(''), null)
  assert.equal(toNumber('n/a'), null)
})

test('daysBetween: whole days, date-only (no DST drift)', () => {
  assert.equal(daysBetween('2026-08-01', '2026-08-12'), 11)
  assert.equal(daysBetween('2026-05-01', '2026-08-12'), 103)
  assert.equal(daysBetween('2026-09-01', '2026-08-12'), -20)
  assert.equal(daysBetween(null, '2026-08-12'), null)
})

test('addMonths: clamps to month end', () => {
  assert.equal(addMonths('2026-07-03', 1), '2026-08-03')
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28')
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15')
  assert.equal(addMonths(null, 1), null)
})

// ── billing model (spec §2) ────────────────────────────────────────────────

test('isInstallmentPayer: ~0.33 of modal premium is an installment, ~1.0 is not', () => {
  assert.equal(isInstallmentPayer(35, 105), true)
  assert.equal(isInstallmentPayer(100, 100), false)
  assert.equal(isInstallmentPayer(null, 100), false)
  assert.equal(isInstallmentPayer(35, 0), false)
})

test('resolveCycleDays: M and Q-installment are monthly; true Q/SA/A are not', () => {
  assert.deepEqual(resolveCycleDays('M', 100, 100), { cycleDays: 31, assumed: false })
  assert.deepEqual(resolveCycleDays('Q', 35, 105), { cycleDays: 31, assumed: false })
  assert.deepEqual(resolveCycleDays('Q', 105, 105), { cycleDays: 92, assumed: false })
  assert.deepEqual(resolveCycleDays('SA', 600, 600), { cycleDays: 182, assumed: false })
  assert.deepEqual(resolveCycleDays('A', 1200, 1200), { cycleDays: 365, assumed: false })
})

test('resolveCycleDays: unknown mode assumes monthly but flags the guess (spec §5)', () => {
  assert.deepEqual(resolveCycleDays('DIRECT BILL', 100, 100), { cycleDays: 31, assumed: true })
  assert.deepEqual(resolveCycleDays(null, 100, 100), { cycleDays: 31, assumed: true })
})

// ── Step A: derive the grace period ───────────────────────────────────────

test('deriveGraceByCompany: modal TERMDATE - PAIDTODATE over Lapsed rows', () => {
  const rows = [
    policy({ status_category: 'Lapsed', paid_to_date: '2026-01-01', term_date: '2026-02-15' }), // 45
    policy({ policy_number: 'B', status_category: 'Lapsed', paid_to_date: '2026-03-01', term_date: '2026-04-15' }), // 45
    policy({ policy_number: 'C', status_category: 'Lapsed', paid_to_date: '2026-05-01', term_date: '2026-06-27' }), // 57
    policy({ policy_number: 'D', status_category: 'Active' }),
  ]
  const grace = deriveGraceByCompany(rows)
  assert.equal(grace.AMH.grace_days, 45)
  assert.equal(grace.AMH.sample, 3)
  assert.equal(grace.AMH.confidence, 2)
})

test('deriveGraceByCompany: keyed per COMPANYCODE', () => {
  const rows = [
    policy({ status_category: 'Lapsed', paid_to_date: '2026-01-01', term_date: '2026-02-15' }),
    policy({ policy_number: 'X', company_code: 'OTHER', status_category: 'Lapsed', paid_to_date: '2026-01-01', term_date: '2026-01-31' }),
  ]
  const grace = deriveGraceByCompany(rows)
  assert.equal(grace.AMH.grace_days, 45)
  assert.equal(grace.OTHER.grace_days, 30)
})

test('deriveGraceByCompany: no Lapsed rows -> company absent, caller falls back to 45', () => {
  const grace = deriveGraceByCompany([policy({ status_category: 'Active' })])
  assert.deepEqual(grace, {})
  // A policy 46 days past paid-to is CRITICAL only if the 45-day default applied.
  const r = detectLapseRisk(
    [policy({ last_payment: '2026-06-01', paid_to_date: '2026-06-27' })],
    TODAY
  )
  assert.equal(r.flagged[0].days_until_lapse, 45 - 46)
})

// ── Step D: tier boundaries ───────────────────────────────────────────────

test('resolveTier: boundaries at 7/8 and 21/22', () => {
  assert.equal(resolveTier(7), 'CRITICAL')
  assert.equal(resolveTier(8), 'HIGH')
  assert.equal(resolveTier(21), 'HIGH')
  assert.equal(resolveTier(22), 'EARLY')
  assert.equal(resolveTier(-30), 'CRITICAL')
  assert.equal(resolveTier(null), 'CRITICAL')
})

// ── §5: dedupe ────────────────────────────────────────────────────────────

test('dedupeByLatestPaidTo: duplicate policy keeps the latest PAIDTODATE', () => {
  const rows = [
    policy({ policy_number: 'DUP', paid_to_date: '2026-06-01', annual_premium: 111 }),
    policy({ policy_number: 'DUP', paid_to_date: '2026-09-01', annual_premium: 222 }),
  ]
  const out = dedupeByLatestPaidTo(rows)
  assert.equal(out.length, 1)
  assert.equal(out[0].annual_premium, 222)
})

// ── Step B: the primary trigger, and the v1 false positive it fixes ───────

test('healthy monthly payer is not flagged', () => {
  const r = detectLapseRisk([policy({ last_payment: '2026-08-03', paid_to_date: '2026-09-03' })], TODAY)
  assert.equal(r.atRiskCount, 0)
  assert.equal(r.flagged.length, 0)
})

test('REGRESSION: healthy Q-mode installment payer with a TRAILING paid-to date is NOT flagged', () => {
  // This is the v1 bug: PAIDTODATE < today is normal for installment payers.
  const r = detectLapseRisk(
    [
      policy({
        pay_mode: 'Q',
        last_pay_amount: 35,
        modal_premium: 105,
        last_payment: '2026-07-20', // 23 days ago -> within the 36-day tolerance
        paid_to_date: '2026-07-15', // trails the calendar, legitimately
      }),
    ],
    TODAY
  )
  assert.equal(r.atRiskCount, 0)
  assert.equal(r.nsfSuspectCount, 0)
})

test('missed draft: 72 days since payment is flagged, tier from the lapse clock', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-07-05' })],
    TODAY
  )
  assert.equal(r.atRiskCount, 1)
  const f = r.flagged[0]
  assert.equal(f.bucket, 'AT_RISK')
  assert.equal(f.days_since_pay, 72)
  assert.equal(f.days_until_lapse, 7) // 45 - 38
  assert.equal(f.tier, 'CRITICAL')
  assert.equal(f.failure_type, 'PAYMENT_STOPPED')
  assert.equal(f.payments_made, 6)
  assert.equal(f.expected_next_draft, '2026-07-01')
})

test('tier tracks days_until_lapse: HIGH and EARLY', () => {
  const high = detectLapseRisk(
    [policy({ effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-07-15' })],
    TODAY
  )
  assert.equal(high.flagged[0].days_until_lapse, 17)
  assert.equal(high.flagged[0].tier, 'HIGH')

  const early = detectLapseRisk(
    [policy({ effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-08-01' })],
    TODAY
  )
  assert.equal(early.flagged[0].days_until_lapse, 34)
  assert.equal(early.flagged[0].tier, 'EARLY')
})

test('exactly at tolerance (36 days) is not flagged; 37 is', () => {
  const at = detectLapseRisk([policy({ last_payment: '2026-07-07', paid_to_date: '2026-08-20' })], TODAY)
  assert.equal(at.atRiskCount, 0)
  const over = detectLapseRisk([policy({ last_payment: '2026-07-06', paid_to_date: '2026-08-20' })], TODAY)
  assert.equal(over.atRiskCount, 1)
  assert.equal(over.flagged[0].days_since_pay, 37)
})

test('§5: null LASTPAYMENTDATE on an active policy is measured from ORIGEFFDATE', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-05-01', last_payment: null, paid_to_date: '2026-05-01' })],
    TODAY
  )
  assert.equal(r.atRiskCount, 1)
  const f = r.flagged[0]
  assert.equal(f.days_since_pay, 103)
  assert.equal(f.payments_made, 0)
  assert.equal(f.failure_type, 'NEVER_STARTED')
  assert.match(f.logic_one_liner, /No payment has ever been recorded/)
})

test('NEVER_STARTED when only one payment ever posted', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-06-01', last_payment: '2026-06-05', paid_to_date: '2026-07-01' })],
    TODAY
  )
  assert.equal(r.flagged[0].payments_made, 1)
  assert.equal(r.flagged[0].failure_type, 'NEVER_STARTED')
})

test('§5: past grace but still Active -> termination pending, CRITICAL', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-06-01' })],
    TODAY
  )
  const f = r.flagged[0]
  assert.equal(f.days_until_lapse, -27) // 45 - 72
  assert.equal(f.tier, 'CRITICAL')
  assert.match(f.logic_one_liner, /grace already expired — termination pending/)
  assert.match(f.action_item, /termination pending/)
})

// ── Step C: NSF verification ──────────────────────────────────────────────

test('Step C: recent payment but paid-to still at effective date -> NSF_SUSPECT', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-04-01', paid_to_date: '2026-04-01', last_payment: '2026-08-01' })],
    TODAY
  )
  assert.equal(r.atRiskCount, 0)
  assert.equal(r.nsfSuspectCount, 1)
  const f = r.flagged[0]
  assert.equal(f.bucket, 'NSF_SUSPECT')
  assert.equal(f.failure_type, 'NSF_SUSPECT')
  assert.equal(f.tier, null)
  assert.match(f.action_item, /verify with the carrier/)
})

test('Step C: policy younger than 60 days is not an NSF suspect yet', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-07-01', paid_to_date: '2026-07-01', last_payment: '2026-08-01' })],
    TODAY
  )
  assert.equal(r.nsfSuspectCount, 0)
  assert.equal(r.flagged.length, 0)
})

test('Step C never competes with Step B: a missed draft is AT_RISK, not NSF', () => {
  const r = detectLapseRisk(
    [policy({ effective_date: '2026-04-01', paid_to_date: '2026-04-01', last_payment: '2026-05-01' })],
    TODAY
  )
  assert.equal(r.atRiskCount, 1)
  assert.equal(r.nsfSuspectCount, 0)
})

// ── §4: secondary bucket ──────────────────────────────────────────────────

test('§4: Issued Not In Force -> PENDING_FIRST_DRAFT, off the grace clock', () => {
  const r = detectLapseRisk(
    [policy({ status_category: 'Issued Not In Force', last_payment: null, last_pay_amount: null })],
    TODAY
  )
  assert.equal(r.pendingFirstDraftCount, 1)
  assert.equal(r.activeCount, 0)
  const f = r.flagged[0]
  assert.equal(f.bucket, 'PENDING_FIRST_DRAFT')
  assert.equal(f.days_until_lapse, null)
  assert.equal(f.tier, null)
  assert.match(f.action_item, /Confirm banking details/)
})

test('non-Active, non-INIF statuses are ignored entirely', () => {
  const r = detectLapseRisk(
    [
      policy({ policy_number: 'A', status_category: 'Decline' }),
      policy({ policy_number: 'B', status_category: 'Closed' }),
      policy({ policy_number: 'C', status_category: 'Terminated' }),
    ],
    TODAY
  )
  assert.equal(r.flagged.length, 0)
  assert.equal(r.activeCount, 0)
})

// ── Step E: ordering and totals ───────────────────────────────────────────

test('Step E: sorted by days_until_lapse ASC then annual_premium DESC', () => {
  const r = detectLapseRisk(
    [
      policy({ policy_number: 'EARLY', effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-08-01', annual_premium: 100 }),
      policy({ policy_number: 'CRIT', effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-07-05', annual_premium: 100 }),
      policy({ policy_number: 'CRIT_RICH', effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-07-05', annual_premium: 9999 }),
    ],
    TODAY
  )
  assert.deepEqual(
    r.flagged.map((f) => f.policy_number),
    ['CRIT_RICH', 'CRIT', 'EARLY']
  )
  assert.equal(r.annualPremiumAtRisk, 10199)
})

test('AT_RISK sorts ahead of NSF_SUSPECT and PENDING_FIRST_DRAFT', () => {
  const r = detectLapseRisk(
    [
      policy({ policy_number: 'INIF', status_category: 'Issued Not In Force' }),
      policy({ policy_number: 'NSF', effective_date: '2026-04-01', paid_to_date: '2026-04-01', last_payment: '2026-08-01' }),
      policy({ policy_number: 'RISK', effective_date: '2026-01-01', last_payment: '2026-06-01', paid_to_date: '2026-07-05' }),
    ],
    TODAY
  )
  assert.deepEqual(
    r.flagged.map((f) => f.bucket),
    ['AT_RISK', 'NSF_SUSPECT', 'PENDING_FIRST_DRAFT']
  )
})

// ── parsing ───────────────────────────────────────────────────────────────

test('mapSheetRows: reads the row-2 header layout and coerces types', () => {
  const header = [
    'COMPANYCODE', 'POLICYNUMBER', 'STATUSCATEGORY', 'ORIGEFFDATE', 'PAIDTODATE', 'TERMDATE',
    'LASTPAYMENTDATE', 'LASTPAYAMT', 'PAYMENTMODEDISPLAYTEXT', 'CURRENTMODALPREMIUM',
    'CURRENTANNUALPREMIUM', 'INSUREDNAME', 'PHONE1', 'STATE', 'AGENTCOMPLETENAME',
  ]
  const rows = mapSheetRows(header, [
    ['AMH', 'AMH1', 'Active', '2026-01-01', '2026-09-01', null, '2026-08-03', '$29.37', 'M', 100, 1200, 'Jane  Doe', '(555) 111-2222', 'TX', 'Agent A'],
    ['AMH', '', 'Active', '2026-01-01', '2026-09-01', null, '2026-08-03', 10, 'M', 100, 1200, 'No Policy', null, null, null],
  ])
  assert.equal(rows.length, 1) // blank policy number dropped
  assert.equal(rows[0].last_pay_amount, 29.37)
  assert.equal(rows[0].insured, 'Jane Doe') // whitespace collapsed
  assert.equal(rows[0].term_date, null)
})

test('mapSheetRows: missing required columns fail loudly', () => {
  assert.throws(
    () => mapSheetRows(['POLICYNUMBER', 'STATUSCATEGORY'], [['A', 'Active']]),
    /missing required column\(s\)[\s\S]*ORIGEFFDATE/
  )
})
