import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCenterDetails,
  centerDetailsToCsv,
  cycleRouteKey,
  parseCycleRouteKey,
  policyMatchKey,
  ESCROW_DETAIL_HEADERS,
  type EscrowPolicyLine,
  type EscrowWorkChestDeal,
} from './escrowCycleDetail'

function line(partial: Partial<EscrowPolicyLine> = {}): EscrowPolicyLine {
  return {
    batch_id: 'b1',
    call_center: 'INB',
    agency_carrier_id: 'ac1',
    carrier: 'AMAM (American Amicable)',
    policy_number: '0057246840',
    gross_amount: 36,
    final_cc_amount: 18,
    latest_invoicing_status: 'new_sale',
    ...partial,
  }
}

function deal(partial: Partial<EscrowWorkChestDeal> = {}): EscrowWorkChestDeal {
  return {
    call_center: 'INB',
    policy_number: '0057214790',
    customer_name: 'KEVIN J WATSON',
    carrier: 'AMAM (American Amicable)',
    commission_date: '2026-09-30',
    center_amount: 22.78,
    released_batch_id: 'b1',
    ...partial,
  }
}

// ─────────────────────────── keys and routes ───────────────────────────

test('policy numbers match regardless of how the carrier padded them', () => {
  assert.equal(policyMatchKey('0057214790'), policyMatchKey('57214790'))
  assert.equal(policyMatchKey('AMH-6356364'), 'AMH6356364')
  assert.equal(policyMatchKey('  amh6356364 '), 'AMH6356364')
  assert.equal(policyMatchKey('000'), '0', 'an all-zero number does not become empty')
  assert.equal(policyMatchKey(null), '')
})

test('a cycle round-trips through its route key', () => {
  const key = cycleRouteKey('2026-09-30', '2026-10-13')
  assert.equal(key, '2026-09-30_2026-10-13')
  assert.deepEqual(parseCycleRouteKey(key), { start: '2026-09-30', end: '2026-10-13' })
})

test('an undated cycle and a malformed key both come back as unassigned', () => {
  assert.equal(cycleRouteKey(null, null), 'unassigned')
  assert.deepEqual(parseCycleRouteKey('unassigned'), { start: null, end: null })
  assert.deepEqual(parseCycleRouteKey('../../etc/passwd'), { start: null, end: null })
})

// ─────────────────────────── merging the sources ───────────────────────────

test('a work chest deal is marked held and keeps its customer and date', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: '0057214790', final_cc_amount: 22.78 })],
    workChestDeals: [deal()],
  })
  assert.equal(center.deals.length, 1, 'the policy line and the held deal are the same policy')
  assert.equal(center.deals[0].held, true)
  assert.equal(center.deals[0].customerName, 'KEVIN J WATSON')
  assert.equal(center.deals[0].commissionDate, '2026-09-30')
  assert.equal(center.deals[0].centerAmount, 22.78)
  assert.equal(center.heldCount, 1)
  assert.equal(center.heldTotal, 22.78)
})

test('padding differences do not duplicate a policy', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: '57214790' })],
    workChestDeals: [deal({ policy_number: '0057214790' })],
  })
  assert.equal(center.deals.length, 1)
  assert.equal(center.deals[0].held, true)
})

test('a line that was invoiced but not held is listed, and not marked held', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: 'AAA111', final_cc_amount: 500 })],
    workChestDeals: [],
  })
  assert.equal(center.deals[0].held, false)
  assert.equal(center.deals[0].source, 'cycle_line')
  assert.equal(center.heldTotal, 0)
  assert.equal(center.cycleTotal, 500)
})

test('a held deal with no matching policy line is still listed', () => {
  // Money held by hand must not vanish because the line was never invoiced.
  const [center] = buildCenterDetails({
    policyLines: [],
    workChestDeals: [deal({ policy_number: 'ORPHAN1', center_amount: 99.5 })],
  })
  assert.equal(center.deals.length, 1)
  assert.equal(center.deals[0].held, true)
  assert.equal(center.heldTotal, 99.5)
})

test('insured names fall back to deal tracker when the work chest has none', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: 'AAA111' })],
    workChestDeals: [],
    namesByPolicy: new Map([[policyMatchKey('AAA111'), 'Jane Doe']]),
  })
  assert.equal(center.deals[0].customerName, 'Jane Doe')
})

test('held deals sort to the top, largest first', () => {
  const [center] = buildCenterDetails({
    policyLines: [
      line({ policy_number: 'P1', final_cc_amount: 900 }),
      line({ policy_number: 'P2', final_cc_amount: 100 }),
    ],
    workChestDeals: [deal({ policy_number: 'P3', center_amount: 50 })],
  })
  assert.deepEqual(center.deals.map((d) => d.policyNumber), ['P3', 'P1', 'P2'])
})

test('centers are separated, biggest held total first', () => {
  const details = buildCenterDetails({
    policyLines: [
      line({ call_center: 'INB', policy_number: 'A1' }),
      line({ call_center: 'Orbit IQ', policy_number: 'B1' }),
    ],
    workChestDeals: [
      deal({ call_center: 'INB', policy_number: 'A1', center_amount: 10 }),
      deal({ call_center: 'Orbit IQ', policy_number: 'B1', center_amount: 900 }),
    ],
  })
  assert.deepEqual(details.map((d) => d.callCenter), ['Orbit IQ', 'INB'])
})

// ──────────────── saying honestly what the holdback is ────────────────

test('a percentage holdback with no named deals is flagged as proportional', () => {
  // The right answer to "which deals are held" is "a share of all of them".
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: 'P1', final_cc_amount: 1000 })],
    workChestDeals: [],
    escrowByCenter: new Map([['INB', { openingTransfer: 0, hold: 200 }]]),
  })
  assert.equal(center.holdIsProportional, true)
  assert.equal(center.heldCount, 0)
})

test('named held deals are not described as proportional', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: '0057214790' })],
    workChestDeals: [deal()],
    escrowByCenter: new Map([['INB', { openingTransfer: 0, hold: 22.78 }]]),
  })
  assert.equal(center.holdIsProportional, false)
})

test('a cycle with nothing held at all is not flagged either', () => {
  const [center] = buildCenterDetails({
    policyLines: [line({ policy_number: 'P1' })],
    workChestDeals: [],
    escrowByCenter: new Map([['INB', { openingTransfer: 0, hold: 0 }]]),
  })
  assert.equal(center.holdIsProportional, false)
})

// ─────────────────────────────── export ───────────────────────────────

test('the CSV lists every deal and says which were held', () => {
  const details = buildCenterDetails({
    policyLines: [line({ policy_number: 'P1', final_cc_amount: 500 })],
    workChestDeals: [deal({ policy_number: 'P2', center_amount: 25 })],
  })
  const lines = centerDetailsToCsv(details, 'Sep 30 – Oct 13, 2026').split('\r\n')
  assert.equal(lines[0], ESCROW_DETAIL_HEADERS.join(','))
  assert.equal(lines.length, 3)
  assert.ok(lines.some((l) => l.includes('P2') && l.endsWith(',Yes')))
  assert.ok(lines.some((l) => l.includes('P1') && l.endsWith(',No')))
})

test('an empty cycle exports just the header', () => {
  assert.equal(centerDetailsToCsv([], 'x'), ESCROW_DETAIL_HEADERS.join(','))
  assert.deepEqual(buildCenterDetails({ policyLines: [], workChestDeals: [] }), [])
})
