import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AMAM_ISSUED_CARRIER_STATUSES,
  ISSUE_DATE_CARRIER_CODES,
  MISSING_COMMISSION_UNCOVERED_CARRIER_CODES,
  findIssuedDatesFromHistory,
  isAmamIssuedCarrierStatus,
  isDueForCommissionCheck,
  isUncoveredCarrier,
  mergeCandidatesDeduped,
  resolveCarrierCode,
  ymdFromDate,
} from './missingCommission'

// ─── resolveCarrierCode ──────────────────────────────────────────────────────

test('resolveCarrierCode: prefers the joined carriers.code when present', () => {
  assert.equal(resolveCarrierCode({ carrier: 'garbage text', carriers: { code: 'AETNA' } }), 'AETNA')
})

test('resolveCarrierCode: falls back to free-text carrier when carriers.code is missing (broken carrier_id)', () => {
  assert.equal(resolveCarrierCode({ carrier: 'Sentinel Security Life', carriers: null }), 'SENTINEL')
  assert.equal(resolveCarrierCode({ carrier: 'Mutual of Omaha', carriers: null }), 'MOH')
  assert.equal(resolveCarrierCode({ carrier: 'AMAM (American Amicable)', carriers: null }), 'AMAM')
  assert.equal(resolveCarrierCode({ carrier: 'American Amicable Life', carriers: null }), 'AMAM')
  assert.equal(resolveCarrierCode({ carrier: 'Royal Neighbors of America', carriers: null }), 'RNA')
  assert.equal(resolveCarrierCode({ carrier: 'American Home Life', carriers: null }), 'AHL')
})

test('resolveCarrierCode: null/empty carrier with no join -> null', () => {
  assert.equal(resolveCarrierCode({ carrier: null, carriers: null }), null)
  assert.equal(resolveCarrierCode({ carrier: '', carriers: null }), null)
})

test('resolveCarrierCode: unrecognized free-text carrier is returned as-is (uppercased), not silently dropped', () => {
  assert.equal(resolveCarrierCode({ carrier: 'Some New Carrier', carriers: null }), 'SOME NEW CARRIER')
})

// ─── isDueForCommissionCheck ─────────────────────────────────────────────────

test('isDueForCommissionCheck: issue-date carriers are always due, regardless of effective_date', () => {
  const today = '2026-09-22'
  for (const code of ISSUE_DATE_CARRIER_CODES) {
    assert.equal(
      isDueForCommissionCheck({ carrier: null, carriers: { code }, effective_date: null }, today),
      true,
      `${code} should be due with no effective_date`
    )
    assert.equal(
      isDueForCommissionCheck({ carrier: null, carriers: { code }, effective_date: '2099-01-01' }, today),
      true,
      `${code} should be due even with a future effective_date`
    )
  }
})

test('isDueForCommissionCheck: only AMAM is an issue-date carrier — MOH, Sentinel, and Americo are effective-date now', () => {
  assert.deepEqual([...ISSUE_DATE_CARRIER_CODES], ['AMAM'])
  const today = '2026-09-22'
  for (const code of ['MOH', 'SENTINEL', 'AMERICO']) {
    assert.equal(
      isDueForCommissionCheck({ carrier: null, carriers: { code }, effective_date: '2099-01-01' }, today),
      false,
      `${code} should NOT be due with a future effective_date (moved off issue-date group deliberately, safer default)`
    )
    assert.equal(
      isDueForCommissionCheck({ carrier: null, carriers: { code }, effective_date: '2026-09-15' }, today),
      true,
      `${code} should be due once its effective_date has passed, same as any other effective-date carrier`
    )
  }
})

test('isDueForCommissionCheck: effective-date carriers are due only once effective_date has strictly passed', () => {
  const today = '2026-09-22'
  const row = (effective_date: string | null) => ({ carrier: null, carriers: { code: 'AETNA' }, effective_date })
  assert.equal(isDueForCommissionCheck(row('2026-09-21'), today), true, 'yesterday -> due')
  assert.equal(isDueForCommissionCheck(row('2026-09-22'), today), false, 'today -> not due yet (carrier has not had time to process)')
  assert.equal(isDueForCommissionCheck(row('2026-09-23'), today), false, 'future -> not due')
  assert.equal(isDueForCommissionCheck(row(null), today), false, 'no effective_date -> not due')
})

test('isDueForCommissionCheck: a legacy row with broken carrier_id still resolves via free-text fallback', () => {
  const today = '2026-09-22'
  // AMAM via free text only, no carriers join -> still treated as issue-date carrier
  assert.equal(
    isDueForCommissionCheck({ carrier: 'AMAM (American Amicable)', carriers: null, effective_date: '2099-01-01' }, today),
    true
  )
})

// ─── isUncoveredCarrier ───────────────────────────────────────────────────────

test('isUncoveredCarrier: RNA and Liberty are uncovered', () => {
  for (const code of MISSING_COMMISSION_UNCOVERED_CARRIER_CODES) {
    assert.equal(isUncoveredCarrier({ carrier: null, carriers: { code } }), true)
  }
})

test('isUncoveredCarrier: a covered carrier is not flagged uncovered', () => {
  assert.equal(isUncoveredCarrier({ carrier: null, carriers: { code: 'AMAM' } }), false)
  assert.equal(isUncoveredCarrier({ carrier: null, carriers: null }), false)
})

// ─── isAmamIssuedCarrierStatus ────────────────────────────────────────────────

test('isAmamIssuedCarrierStatus: statuses AMAM has actually issued are included', () => {
  for (const status of AMAM_ISSUED_CARRIER_STATUSES) {
    assert.equal(isAmamIssuedCarrierStatus(status), true, `${status} should count as issued`)
  }
})

test('isAmamIssuedCarrierStatus: pre-issue or never-issued statuses are excluded', () => {
  const excluded = ['Pending', 'Declined', 'Withdrawn', 'NotTaken', 'Incomplete', 'InfNotTaken', 'NeedReqmnt']
  for (const status of excluded) {
    assert.equal(isAmamIssuedCarrierStatus(status), false, `${status} should NOT count as issued`)
  }
})

test('isAmamIssuedCarrierStatus: null/unknown status is not treated as issued', () => {
  assert.equal(isAmamIssuedCarrierStatus(null), false)
  assert.equal(isAmamIssuedCarrierStatus('SomeBrandNewCarrierStatus'), false)
})

// ─── mergeCandidatesDeduped ───────────────────────────────────────────────────

test('mergeCandidatesDeduped: keeps every row when there is no overlap', () => {
  const main = [{ id: 'a' }, { id: 'b' }]
  const extra = [{ id: 'c' }, { id: 'd' }]
  const merged = mergeCandidatesDeduped(main, extra)
  assert.deepEqual(merged.map((r) => r.id).sort(), ['a', 'b', 'c', 'd'])
})

test('mergeCandidatesDeduped: a row present in both queries appears exactly once', () => {
  const main = [{ id: 'a' }, { id: 'shared' }]
  const extra = [{ id: 'shared' }, { id: 'z' }]
  const merged = mergeCandidatesDeduped(main, extra)
  assert.deepEqual(merged.map((r) => r.id).sort(), ['a', 'shared', 'z'])
  assert.equal(merged.filter((r) => r.id === 'shared').length, 1)
})

test('mergeCandidatesDeduped: empty extra list is a no-op', () => {
  const main = [{ id: 'a' }]
  assert.deepEqual(mergeCandidatesDeduped(main, []), main)
})

test('mergeCandidatesDeduped: empty main list keeps everything from extra', () => {
  const extra = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(mergeCandidatesDeduped([], extra), extra)
})

// ─── ymdFromDate ──────────────────────────────────────────────────────────────

test('ymdFromDate: truncates a full ISO timestamp down to the date portion', () => {
  assert.equal(ymdFromDate('2026-09-22T14:03:00.000Z'), '2026-09-22')
})

test('ymdFromDate: null/empty -> empty string', () => {
  assert.equal(ymdFromDate(null), '')
  assert.equal(ymdFromDate(''), '')
})

// ─── End-to-end scenario matching the transcript's business rule ────────────
// "For an issue-date carrier: issue date reached/passed -> check Commission
// Tracker -> no positive commission entry = potential missing commission.
// For an effective-date carrier: effective date reached/passed -> same check."

test('scenario: AMAM policy reported IssNotPaid is due for a commission check even while sitting pre-active', () => {
  const today = '2026-09-22'
  const amamRow = { carrier: 'AMAM (American Amicable)', carriers: null, effective_date: '2026-10-01' }
  assert.equal(isAmamIssuedCarrierStatus('IssNotPaid'), true)
  assert.equal(isDueForCommissionCheck(amamRow, today), true, 'AMAM is issue-date -> due even with a future effective_date')
})

test('scenario: an Aetna policy whose effective date is next week is NOT yet due', () => {
  const today = '2026-09-22'
  const aetnaRow = { carrier: null, carriers: { code: 'AETNA' }, effective_date: '2026-09-29' }
  assert.equal(isDueForCommissionCheck(aetnaRow, today), false)
})

test('scenario: an Aetna policy whose effective date passed last week IS due', () => {
  const today = '2026-09-22'
  const aetnaRow = { carrier: null, carriers: { code: 'AETNA' }, effective_date: '2026-09-15' }
  assert.equal(isDueForCommissionCheck(aetnaRow, today), true)
})

// ─── findIssuedDatesFromHistory ───────────────────────────────────────────────

test('findIssuedDatesFromHistory: a transition past a pre-issue stage counts as proof of issuance', () => {
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Pending Approval', created_at: '2026-08-01T00:00:00Z' },
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Issued - Pending First Draft', created_at: '2026-08-05T00:00:00Z' },
  ])
  assert.equal(result['row-1'], '2026-08-05T00:00:00Z')
})

test('findIssuedDatesFromHistory: only pre-issue transitions -> no issue date recorded', () => {
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Pending Approval', created_at: '2026-08-01T00:00:00Z' },
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Application Withdrawn', created_at: '2026-08-03T00:00:00Z' },
  ])
  assert.equal(result['row-1'], undefined)
})

test('findIssuedDatesFromHistory: takes the EARLIEST issued transition, not the latest', () => {
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: 'FDPF Pending Reason', created_at: '2026-09-01T00:00:00Z' },
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Issued - Pending First Draft', created_at: '2026-08-05T00:00:00Z' },
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Active Placed - Paid as Advanced', created_at: '2026-09-10T00:00:00Z' },
  ])
  assert.equal(result['row-1'], '2026-08-05T00:00:00Z')
})

test('findIssuedDatesFromHistory: a policy later declined still counts as issued if it passed through an issued stage first', () => {
  // Matches the case the history-first design is actually for: today's raw
  // carrier_status might say something unhelpful, but a real recorded
  // transition is authoritative regardless.
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Issued - Pending First Draft', created_at: '2026-08-05T00:00:00Z' },
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Chargeback Cancellation', created_at: '2026-09-01T00:00:00Z' },
  ])
  assert.equal(result['row-1'], '2026-08-05T00:00:00Z')
})

test('findIssuedDatesFromHistory: tracks multiple policies independently', () => {
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: 'Issued - Pending First Draft', created_at: '2026-08-05T00:00:00Z' },
    { deal_tracker_id: 'row-2', new_ghl_stage: 'Pending Approval', created_at: '2026-08-06T00:00:00Z' },
  ])
  assert.equal(result['row-1'], '2026-08-05T00:00:00Z')
  assert.equal(result['row-2'], undefined)
})

test('findIssuedDatesFromHistory: empty history -> empty result, no crash', () => {
  assert.deepEqual(findIssuedDatesFromHistory([]), {})
})

test('findIssuedDatesFromHistory: null new_ghl_stage is ignored, not treated as issued', () => {
  const result = findIssuedDatesFromHistory([
    { deal_tracker_id: 'row-1', new_ghl_stage: null, created_at: '2026-08-05T00:00:00Z' },
  ])
  assert.deepEqual(result, {})
})
