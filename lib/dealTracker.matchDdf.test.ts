require('dotenv').config({ path: require('path').join(__dirname, '../.env') })
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchDdfNamesToRecords, normalizeNameForSearch } from './dealTracker'

type DdfRecord = {
  insured_name?: string | null
  lead_vendor?: string | null
  lead_vendor_name?: string | null
  client_phone_number?: string | null
  phone_number?: string | null
  draft_date?: string | null
  tracking_id?: string | null
  submission_id?: string | null
}

// submission_id is a reliable join key only when the match itself is reliable — see the
// bestScore >= 80 gate in matchDdfNamesToRecords. These tests lock in exactly which match
// tiers do (exact tracking_id, exact name, exact first+last) and don't (fuzzy, single-field)
// propagate it, since getting this wrong either breaks new-lead matching (Madison Garden's
// case: no policy_id/tracking_id yet, name match is the only path) or risks silently moving
// the wrong lead's CRM stage on a bad fuzzy match.

test('matchDdfNamesToRecords: exact policy/tracking_id match propagates submission_id', () => {
  const records: DdfRecord[] = [{ insured_name: 'Someone Else', tracking_id: 'POL-100', submission_id: 'sub-100' }]
  const result = matchDdfNamesToRecords(records, ['Totally Different Name'], ['POL-100'])
  const match = result.get(normalizeNameForSearch('Totally Different Name'))
  assert.ok(match)
  assert.equal(match?.submission_id, 'sub-100')
})

test('matchDdfNamesToRecords: exact full-name match propagates submission_id', () => {
  const records: DdfRecord[] = [{ insured_name: 'Madison Garden', submission_id: 'sub-200' }]
  const result = matchDdfNamesToRecords(records, ['Madison Garden'])
  const match = result.get(normalizeNameForSearch('Madison Garden'))
  assert.ok(match)
  assert.equal(match?.submission_id, 'sub-200')
})

test('matchDdfNamesToRecords: exact first+last match (record has a middle name the query omits) propagates submission_id', () => {
  const records: DdfRecord[] = [{ insured_name: 'John Michael Smith', submission_id: 'sub-300' }]
  const result = matchDdfNamesToRecords(records, ['John Smith'])
  const match = result.get(normalizeNameForSearch('John Smith'))
  assert.ok(match)
  assert.equal(match?.submission_id, 'sub-300')
})

test('matchDdfNamesToRecords: first-name-only match still matches, but does NOT propagate submission_id', () => {
  const records: DdfRecord[] = [{ insured_name: 'Jane Anderson', submission_id: 'sub-400' }]
  const result = matchDdfNamesToRecords(records, ['Jane Zimmerman'])
  const match = result.get(normalizeNameForSearch('Jane Zimmerman'))
  assert.ok(match, 'expected a low-confidence name match for call_center/phone purposes')
  assert.equal(match?.submission_id, null)
})

test('matchDdfNamesToRecords: last-name-only match still matches, but does NOT propagate submission_id', () => {
  const records: DdfRecord[] = [{ insured_name: 'Robert Johnson', submission_id: 'sub-500' }]
  const result = matchDdfNamesToRecords(records, ['Michael Johnson'])
  const match = result.get(normalizeNameForSearch('Michael Johnson'))
  assert.ok(match)
  assert.equal(match?.submission_id, null)
})

test('matchDdfNamesToRecords: no match at all', () => {
  const records: DdfRecord[] = [{ insured_name: 'Completely Unrelated', submission_id: 'sub-600' }]
  const result = matchDdfNamesToRecords(records, ['Nobody Here At All'])
  assert.equal(result.size, 0)
})
