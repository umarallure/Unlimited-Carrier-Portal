import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizePolicyKey,
  parsePolicyNumberList,
  findException,
  partitionByException,
  describeSkipped,
  EMPTY_EXCEPTION_INDEX,
  type ExceptionIndex,
  type PolicyException,
} from './policyExceptions'

function exception(policyNumber: string, reason: string | null = null): PolicyException {
  return {
    id: `exc-${policyNumber}`,
    policy_number: policyNumber,
    policy_number_key: normalizePolicyKey(policyNumber),
    carrier: null,
    reason,
    active: true,
    created_at: '2026-08-06T00:00:00.000Z',
    updated_at: '2026-08-06T00:00:00.000Z',
    created_by_email: 'qa@example.com',
  }
}

function indexOf(...rows: PolicyException[]): ExceptionIndex {
  return new Map(rows.map((r) => [r.policy_number_key, r]))
}

// ── normalizePolicyKey ─────────────────────────────────────────────────────
// Must behave identically to normalizePolicyKey in lib/amamCorrespondence.ts.

test('normalizePolicyKey: strips leading zeros on all-numeric policies', () => {
  assert.equal(normalizePolicyKey('0114004010'), '114004010')
  assert.equal(normalizePolicyKey('114004010'), '114004010')
})

test('normalizePolicyKey: strips punctuation and whitespace', () => {
  assert.equal(normalizePolicyKey(' 114-004-010 '), '114004010')
  assert.equal(normalizePolicyKey('114 004 010'), '114004010')
})

test('normalizePolicyKey: uppercases alphanumeric policies without stripping zeros', () => {
  assert.equal(normalizePolicyKey('acc7170502'), 'ACC7170502')
  assert.equal(normalizePolicyKey('0ACC717'), '0ACC717')
})

test('normalizePolicyKey: empty / nullish -> empty string', () => {
  assert.equal(normalizePolicyKey(''), '')
  assert.equal(normalizePolicyKey(null), '')
  assert.equal(normalizePolicyKey(undefined), '')
  assert.equal(normalizePolicyKey('---'), '')
})

test('normalizePolicyKey: all zeros collapses to "0" rather than empty', () => {
  assert.equal(normalizePolicyKey('0000'), '0')
})

// ── parsePolicyNumberList ──────────────────────────────────────────────────

test('parsePolicyNumberList: splits on newlines, commas, spaces and semicolons', () => {
  assert.deepEqual(parsePolicyNumberList('111\n222, 333;444\t555'), ['111', '222', '333', '444', '555'])
})

test('parsePolicyNumberList: dedupes by normalized key, keeping the first spelling', () => {
  assert.deepEqual(parsePolicyNumberList('0114004010\n114004010\n114-004-010'), ['0114004010'])
})

test('parsePolicyNumberList: drops entries with no usable key', () => {
  assert.deepEqual(parsePolicyNumberList('111\n---\n\n222'), ['111', '222'])
})

test('parsePolicyNumberList: empty input -> empty list', () => {
  assert.deepEqual(parsePolicyNumberList(''), [])
})

// ── findException ──────────────────────────────────────────────────────────

test('findException: matches regardless of zero padding', () => {
  const index = indexOf(exception('0114004010'))
  assert.ok(findException(index, '114004010'))
  assert.ok(findException(index, '0114004010'))
  assert.ok(findException(index, '00114004010'))
  assert.ok(findException(index, ' 114-004-010 '))
})

test('findException: unlisted policy -> null', () => {
  const index = indexOf(exception('0114004010'))
  assert.equal(findException(index, '9999999'), null)
})

test('findException: blank policy number -> null', () => {
  const index = indexOf(exception('0114004010'))
  assert.equal(findException(index, ''), null)
  assert.equal(findException(index, null), null)
})

// ── partitionByException ───────────────────────────────────────────────────

const rows = [
  { policy_number: '0114004010', ghl_stage: 'Pending Approval' },
  { policy_number: '0114364910', ghl_stage: 'Declined Underwriting' },
  { policy_number: '114388630', ghl_stage: 'Pending Approval' },
]

test('partitionByException: frozen rows are separated from writable rows', () => {
  const index = indexOf(exception('114004010', 'manually corrected'))
  const { kept, skipped } = partitionByException(index, rows, (r) => r.policy_number)
  assert.deepEqual(
    kept.map((r) => r.policy_number),
    ['0114364910', '114388630']
  )
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].row.policy_number, '0114004010')
  assert.equal(skipped[0].exception.reason, 'manually corrected')
})

test('partitionByException: an unpadded exception still freezes a padded upload row', () => {
  const index = indexOf(exception('114364910'))
  const { kept, skipped } = partitionByException(index, rows, (r) => r.policy_number)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].row.policy_number, '0114364910')
  assert.equal(kept.length, 2)
})

test('partitionByException: empty index keeps every row (and returns the same array)', () => {
  const { kept, skipped } = partitionByException(EMPTY_EXCEPTION_INDEX, rows, (r) => r.policy_number)
  assert.equal(kept, rows)
  assert.deepEqual(skipped, [])
})

test('partitionByException: every row frozen -> nothing kept', () => {
  const index = indexOf(exception('114004010'), exception('114364910'), exception('114388630'))
  const { kept, skipped } = partitionByException(index, rows, (r) => r.policy_number)
  assert.deepEqual(kept, [])
  assert.equal(skipped.length, 3)
})

test('partitionByException: rows with a blank policy number are never frozen', () => {
  const index = indexOf(exception('114004010'))
  const blank = [{ policy_number: '' }]
  const { kept, skipped } = partitionByException(index, blank, (r) => r.policy_number)
  assert.equal(kept.length, 1)
  assert.equal(skipped.length, 0)
})

// ── describeSkipped ────────────────────────────────────────────────────────

test('describeSkipped: null when nothing was skipped', () => {
  assert.equal(describeSkipped([], (r: { policy_number: string }) => r.policy_number), null)
})

test('describeSkipped: names the policy and its reason', () => {
  const index = indexOf(exception('114004010', 'carrier file is wrong'))
  const { skipped } = partitionByException(index, rows, (r) => r.policy_number)
  const msg = describeSkipped(skipped, (r) => r.policy_number)!
  assert.match(msg, /Skipped 1 policy on the exception list/)
  assert.match(msg, /0114004010 \(carrier file is wrong\)/)
})

test('describeSkipped: truncates after five and reports the remainder', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ policy_number: `10${i}` }))
  const index = indexOf(...many.map((r) => exception(r.policy_number)))
  const { skipped } = partitionByException(index, many, (r) => r.policy_number)
  const msg = describeSkipped(skipped, (r) => r.policy_number)!
  assert.match(msg, /Skipped 8 policies/)
  assert.match(msg, /\+3 more/)
})
