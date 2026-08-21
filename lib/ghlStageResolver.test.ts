import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveGhlStage, isBlockedGhlStageRegression, type GhlStageResolutionContext } from './ghlStageResolver'

function baseCtx(overrides: Partial<GhlStageResolutionContext>): GhlStageResolutionContext {
  return {
    carrierStatus: 'Pending',
    allMappings: new Map([['Pending', ['Pending Approval']]]),
    effectiveDate: null,
    dealValue: null,
    chargeBack: null,
    commissionType: null,
    existingGhlStage: null,
    carrierCode: 'AETNA',
    ...overrides,
  }
}

test('FDPF Pending Reason is not reverted to Pending Approval when carrier re-reports generic Pending', () => {
  const result = resolveGhlStage(
    baseCtx({ existingGhlStage: 'FDPF Pending Reason' })
  )
  assert.equal(result, 'FDPF Pending Reason')
})

for (const sub of ['FDPF Insufficient Funds', 'FDPF Unauthorized Draft', 'FDPF Incorrect Banking Info']) {
  test(`FDPF sub-reason "${sub}" is not reverted to Pending Approval either`, () => {
    const result = resolveGhlStage(baseCtx({ existingGhlStage: sub }))
    assert.equal(result, sub)
  })
}

test('FDPF Pending Reason still updates when the carrier reports a real cross-family status (e.g. Active)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['Premium Paid - Commission Pending']]]),
      dealValue: 100,
      existingGhlStage: 'FDPF Pending Reason',
    })
  )
  assert.notEqual(result, 'Pending Approval')
})

test('Non-FDPF existing stages can still resolve to Pending Approval as before', () => {
  const result = resolveGhlStage(baseCtx({ existingGhlStage: null }))
  assert.equal(result, 'Pending Approval')
})

for (const sub of ['FDPF Insufficient Funds', 'FDPF Unauthorized Draft', 'FDPF Incorrect Banking Info']) {
  test(`FDPF sub-reason "${sub}" is not reverted to generic FDPF Pending Reason`, () => {
    const result = resolveGhlStage(
      baseCtx({
        existingGhlStage: sub,
        allMappings: new Map([['Pending', ['FDPF Pending Reason']]]),
      })
    )
    assert.equal(result, sub)
  })
}

test('Generic FDPF Pending Reason stays put when re-mapped to FDPF Pending Reason again', () => {
  const result = resolveGhlStage(
    baseCtx({
      existingGhlStage: 'FDPF Pending Reason',
      allMappings: new Map([['Pending', ['FDPF Pending Reason']]]),
    })
  )
  assert.equal(result, 'FDPF Pending Reason')
})

test('FDPF Pending Reason still updates on a real cross-family status (e.g. Active)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['Premium Paid - Commission Pending']]]),
      dealValue: 100,
      existingGhlStage: 'FDPF Pending Reason',
    })
  )
  assert.notEqual(result, 'FDPF Pending Reason')
})

test('Pending Manual Action is not reverted to Pending Approval when carrier re-reports generic Pending', () => {
  const result = resolveGhlStage(baseCtx({ existingGhlStage: 'Pending Manual Action' }))
  assert.equal(result, 'Pending Manual Action')
})

test('Pending Manual Action is not reverted to Pending Approval even when both stages are mapped and the deal is old', () => {
  // An old dealCreationDate legitimately triggers the separate pending-aging rule (which can
  // move a stale case to Application Withdrawn) — that's a real cross-family change and is
  // allowed. What must never happen regardless is landing back on generic Pending Approval.
  const oldDate = '2020-01-01'
  const result = resolveGhlStage(
    baseCtx({
      existingGhlStage: 'Pending Manual Action',
      allMappings: new Map([['Pending', ['Pending Approval', 'Pending Manual Action']]]),
      dealCreationDate: oldDate,
    })
  )
  assert.notEqual(result, 'Pending Approval')
})

test('Pending Manual Action updates when the carrier reports a real cross-family status (e.g. Active)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['Premium Paid - Commission Pending']]]),
      dealValue: 100,
      existingGhlStage: 'Pending Manual Action',
    })
  )
  assert.notEqual(result, 'Pending Manual Action')
})

// isBlockedGhlStageRegression is the save-time backstop applied in saveDealTrackerEntries
// right before the deal_tracker upsert — it must catch a disallowed regression regardless
// of whether the candidate came from carrier auto-mapping or a manual edit in the
// verification dialog (e.g. someone typing "Pending Approval" directly into the GHL Stage cell).
for (const sub of ['FDPF Pending Reason', 'FDPF Insufficient Funds', 'FDPF Unauthorized Draft', 'FDPF Incorrect Banking Info']) {
  test(`isBlockedGhlStageRegression: "${sub}" -> Pending Approval is blocked`, () => {
    assert.equal(isBlockedGhlStageRegression(sub, 'Pending Approval'), true)
  })
}

for (const sub of ['FDPF Insufficient Funds', 'FDPF Unauthorized Draft', 'FDPF Incorrect Banking Info']) {
  test(`isBlockedGhlStageRegression: "${sub}" -> FDPF Pending Reason is blocked`, () => {
    assert.equal(isBlockedGhlStageRegression(sub, 'FDPF Pending Reason'), true)
  })
}

test('isBlockedGhlStageRegression: Pending Manual Action -> Pending Approval is blocked', () => {
  assert.equal(isBlockedGhlStageRegression('Pending Manual Action', 'Pending Approval'), true)
})

test('isBlockedGhlStageRegression: FDPF Pending Reason -> Active is allowed (real cross-family change)', () => {
  assert.equal(isBlockedGhlStageRegression('FDPF Pending Reason', 'Active Placed - Paid as Advanced'), false)
})

test('isBlockedGhlStageRegression: Pending Manual Action -> Pending Manual Action (no-op) is allowed', () => {
  assert.equal(isBlockedGhlStageRegression('Pending Manual Action', 'Pending Manual Action'), false)
})

test('isBlockedGhlStageRegression: unrelated stages are allowed', () => {
  assert.equal(isBlockedGhlStageRegression('Pending Approval', 'FDPF Pending Reason'), false)
  assert.equal(isBlockedGhlStageRegression(null, 'Pending Approval'), false)
  assert.equal(isBlockedGhlStageRegression('Pending Approval', null), false)
  assert.equal(isBlockedGhlStageRegression(null, null), false)
})

// ── Exhaustive matrix: isBlockedGhlStageRegression ──────────────────────────
// The two guarded existing-stage groups (FDPF family, Pending Manual Action) each
// have exactly ONE blocked destination apiece — everything else must be allowed,
// including every sibling within the same family. These loops pin that down instead
// of relying on a handful of hand-picked examples.

const FDPF_SUBREASONS = ['FDPF Insufficient Funds', 'FDPF Unauthorized Draft', 'FDPF Incorrect Banking Info']
const FDPF_FAMILY_ALL = ['FDPF Pending Reason', ...FDPF_SUBREASONS]
const CROSS_FAMILY_DESTINATIONS = [
  'Active Placed - Paid as Advanced',
  'ACTIVE - 9 months',
  'Application Withdrawn',
  'Declined Underwriting',
  'CANNOT BE FOUND IN CARRIER',
  'Pending Lapse',
  'Pending Lapse Insufficient Funds',
  'Chargeback Failed Payment',
  'Chargeback Cancellation',
]

test('isBlockedGhlStageRegression: generic FDPF Pending Reason -> itself is blocked (redundant with staying put, but pins the boundary)', () => {
  assert.equal(isBlockedGhlStageRegression('FDPF Pending Reason', 'FDPF Pending Reason'), true)
})

for (const from of FDPF_SUBREASONS) {
  for (const to of FDPF_SUBREASONS) {
    if (from === to) continue
    test(`isBlockedGhlStageRegression: sibling swap "${from}" -> "${to}" is allowed (only the shared parent is protected)`, () => {
      assert.equal(isBlockedGhlStageRegression(from, to), false)
    })
  }
}

for (const from of FDPF_FAMILY_ALL) {
  for (const to of CROSS_FAMILY_DESTINATIONS) {
    test(`isBlockedGhlStageRegression: "${from}" -> "${to}" is allowed (real cross-family change)`, () => {
      assert.equal(isBlockedGhlStageRegression(from, to), false)
    })
  }
}

for (const to of CROSS_FAMILY_DESTINATIONS) {
  test(`isBlockedGhlStageRegression: Pending Manual Action -> "${to}" is allowed`, () => {
    assert.equal(isBlockedGhlStageRegression('Pending Manual Action', to), false)
  })
}

for (const existing of ['Active Placed - Paid as Advanced', 'Pending Lapse', 'Application Withdrawn']) {
  test(`isBlockedGhlStageRegression: "${existing}" is not a guarded existing stage — never blocks any candidate`, () => {
    assert.equal(isBlockedGhlStageRegression(existing, 'Pending Approval'), false)
    assert.equal(isBlockedGhlStageRegression(existing, 'FDPF Pending Reason'), false)
  })
}

// ── Within-family regression clamp (applyNonRegressiveGhlClamp), via resolveGhlStage ───────
// Unlike FDPF/Pending Manual Action, the Active and Pending Lapse families have no named
// "guarded existing stage" in isBlockedGhlStageRegression at all — their only protection is
// this ordering clamp, keyed off stageProgressRank. These contexts each map the carrier
// status to a single specific stage so the raw candidate is deterministic and the clamp is
// the only thing left that could change the outcome.

test('Active milestone never regresses to an earlier milestone in the same family (9M -> 6M blocked)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['ACTIVE - 6 months +']]]),
      dealValue: 100,
      existingGhlStage: 'ACTIVE - 9 months',
    })
  )
  assert.equal(result, 'ACTIVE - 9 months')
})

test('Active milestone never regresses all the way back to Premium Paid - Commission Pending', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['Premium Paid - Commission Pending']]]),
      dealValue: 100,
      existingGhlStage: 'ACTIVE - Past Charge-Back Period',
    })
  )
  assert.equal(result, 'ACTIVE - Past Charge-Back Period')
})

test('Active milestone still advances forward within the family (3M -> 9M allowed)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['ACTIVE - 9 months']]]),
      dealValue: 100,
      existingGhlStage: 'ACTIVE - 3 Months +',
    })
  )
  assert.equal(result, 'ACTIVE - 9 months')
})

test('Active milestone re-mapped to itself is a no-op, not treated as a regression', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['Active Placed - Paid as Advanced']]]),
      dealValue: 100,
      existingGhlStage: 'Active Placed - Paid as Advanced',
    })
  )
  assert.equal(result, 'Active Placed - Paid as Advanced')
})

test('Pending Lapse sub-reason never collapses to generic Pending Lapse on its own', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Lapse',
      allMappings: new Map([['Lapse', ['Pending Lapse']]]),
      existingGhlStage: 'Pending Lapse Insufficient Funds',
    })
  )
  assert.equal(result, 'Pending Lapse Insufficient Funds')
})

test('Generic Pending Lapse still advances to a specific sub-reason (forward move allowed)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Lapse',
      allMappings: new Map([['Lapse', ['Pending Lapse Pending Reason']]]),
      existingGhlStage: 'Pending Lapse',
    })
  )
  assert.equal(result, 'Pending Lapse Pending Reason')
})

// ── Explicit cross-family transitions the docstring calls out by name ──────────────────────

test('Pending Lapse (specific sub-reason) updates to Active on a real status change', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Active',
      allMappings: new Map([['Active', ['ACTIVE - 3 Months +']]]),
      dealValue: 100,
      existingGhlStage: 'Pending Lapse Insufficient Funds',
    })
  )
  assert.equal(result, 'ACTIVE - 3 Months +')
})

test('Active updates to Pending Lapse on a real status change (family rank is irrelevant across families)', () => {
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Lapse',
      allMappings: new Map([['Lapse', ['Pending Lapse']]]),
      existingGhlStage: 'ACTIVE - 9 months',
    })
  )
  assert.equal(result, 'Pending Lapse')
})

test('FDPF sub-reason updates to Chargeback when charge_back goes negative (early-return path is not blocked)', () => {
  // The negative charge_back only disambiguates WHICH chargeback stage to use — the carrier's
  // own status mapping still has to offer a chargeback stage as an option in the first place.
  const result = resolveGhlStage(
    baseCtx({
      carrierStatus: 'Charge Back',
      allMappings: new Map([['Charge Back', ['Chargeback Failed Payment']]]),
      chargeBack: -50,
      existingGhlStage: 'FDPF Insufficient Funds',
    })
  )
  assert.equal(result, 'Chargeback Failed Payment')
})
