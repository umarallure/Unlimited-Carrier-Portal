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
  const oldDate = '2020-01-01'
  const result = resolveGhlStage(
    baseCtx({
      existingGhlStage: 'Pending Manual Action',
      allMappings: new Map([['Pending', ['Pending Approval', 'Pending Manual Action']]]),
      dealCreationDate: oldDate,
    })
  )
  assert.equal(result, 'Pending Manual Action')
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
})
