import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDdfNamesToRecords } from './dealTracker'

type DdfRecord = {
  insured_name?: string | null
  lead_vendor?: string | null
  client_phone_number?: string | null
  draft_date?: string | null
  tracking_id?: string | null
}

function record(overrides: Partial<DdfRecord>): DdfRecord {
  return {
    insured_name: null,
    lead_vendor: null,
    client_phone_number: null,
    draft_date: null,
    tracking_id: null,
    ...overrides,
  }
}

test('matchDdfNamesToRecords: exact name match', () => {
  const records = [record({ insured_name: 'Diane Walker', lead_vendor: 'Downtown BPO', client_phone_number: '5550001111' })]
  const result = matchDdfNamesToRecords(records, ['Diane Walker'])
  const match = result.get('Diane Walker')
  assert.equal(match?.call_center, 'Downtown BPO')
  assert.equal(match?.phone_number, '5550001111')
})

test('matchDdfNamesToRecords: first+last order-invariant ("Walker, Diane" matches "Diane Walker")', () => {
  const records = [record({ insured_name: 'Diane Walker', lead_vendor: 'Downtown BPO', client_phone_number: '5550001111' })]
  const result = matchDdfNamesToRecords(records, ['Walker, Diane'])
  assert.ok(result.get('Walker Diane')?.call_center === 'Downtown BPO')
})

test('matchDdfNamesToRecords: same last name with a fuzzy first name (typo) still matches', () => {
  const records = [record({ insured_name: 'Lekeysha Jones', lead_vendor: 'Sunrise BPO', client_phone_number: '5550002222' })]
  const result = matchDdfNamesToRecords(records, ['Lakeysha Jones'])
  assert.equal(result.get('Lakeysha Jones')?.call_center, 'Sunrise BPO')
})

test('matchDdfNamesToRecords: both names fuzzy (small typos in first and last) still matches', () => {
  const records = [record({ insured_name: 'John Smith', lead_vendor: 'Coastal BPO', client_phone_number: '5550003333' })]
  const result = matchDdfNamesToRecords(records, ['Jon Smyth'])
  assert.equal(result.get('Jon Smyth')?.call_center, 'Coastal BPO')
})

test('matchDdfNamesToRecords: policy-number match wins over any name signal (Strategy 0)', () => {
  const records = [
    record({ insured_name: 'Someone Else', lead_vendor: 'Wrong BPO', client_phone_number: '0000000000', tracking_id: 'POL-100' }),
  ]
  const result = matchDdfNamesToRecords(records, ['Totally Unrelated Name'], ['POL-100'])
  assert.equal(result.get('Totally Unrelated Name')?.call_center, 'Wrong BPO')
})

// ── Regression coverage: the two fallback tiers this fix removed ──────────────
// Found via a real test upload: a fictional "Marcus Delgado" policy got enriched
// with a real "Marcus Wheeler" DDF record's call_center/phone because the matcher
// used to accept a shared first name alone, with zero check on the last name.

test('matchDdfNamesToRecords: sharing only a first name is no longer a match', () => {
  const records = [record({ insured_name: 'Marcus Wheeler', lead_vendor: 'Downtown BPO', client_phone_number: '6622160721' })]
  const result = matchDdfNamesToRecords(records, ['Marcus Delgado'])
  assert.equal(result.has('Marcus Delgado'), false)
})

test('matchDdfNamesToRecords: sharing only a last name (very different first names) is no longer a match', () => {
  const records = [record({ insured_name: 'John Delgado', lead_vendor: 'Downtown BPO', client_phone_number: '6622160721' })]
  const result = matchDdfNamesToRecords(records, ['Alice Delgado'])
  assert.equal(result.has('Alice Delgado'), false)
})

test('matchDdfNamesToRecords: no matching record at all returns nothing', () => {
  const records = [record({ insured_name: 'Diane Walker', lead_vendor: 'Downtown BPO' })]
  const result = matchDdfNamesToRecords(records, ['Zachary Nguyen'])
  assert.equal(result.size, 0)
})
