import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isKnownCallCenter, normalizeCallCenterName } from './invoicing'
import { isUnrecognisedCallCenter } from './bpoEscrowAccounts'

const ACTIVE_ADDED = [
  'AEQ', 'AES', 'AJ BPO', 'Axeon', 'Boomerang', 'Brix Consultancy', 'Caliber Technologies', 'CN2', 'Connect X',
  'CSS', 'Cutting Edge Solutions', 'Demo BPO', 'Dot BPO', 'Enigma Global Solutions', 'Flex BPO', 'H&A',
  'Index Global Solutions', 'JPS GLOBAL SOLUTIONS', 'LA Referral BPO', 'Next Era BPO', 'Ominix BPO', 'Orbit IQ',
  'Prime Bridge', 'Procure BPO', 'Progressive BPO', 'Retention BPO', 'RevoXa Solutions', 'SmartTel Solutions',
  'Telecom BPO', 'TIC Service', 'V Talks', 'Vize',
]

const ESCROW_ACCOUNT_NAMES = [
  'Nexpoint', 'Win bpo', 'INB', 'Orbit IQ', 'Connect X', 'Caliber Technologies', 'V Talks', 'TIC Service',
  'Procure BPO', 'Enigma Global Solutions', 'Crossnotch', 'Leaders bpo', 'Exito', 'Zupax Marketing', 'Flex BPO',
]

test('every active centre added to the list is known and maps to itself', () => {
  for (const name of ACTIVE_ADDED) {
    assert.equal(isKnownCallCenter(name), true, name)
    assert.equal(normalizeCallCenterName(name), name, name)
  }
})

test('escrow account names normalize to themselves', () => {
  for (const name of ESCROW_ACCOUNT_NAMES) assert.equal(normalizeCallCenterName(name), name, name)
})

test('Vize is listed but Vize BPO is a different centre and is not folded into it', () => {
  assert.equal(isKnownCallCenter('Vize'), true)
  assert.equal(isKnownCallCenter('Vize BPO'), false)
  assert.equal(normalizeCallCenterName('Vize BPO'), 'Vize BPO')
})

test('inactive and test names stay unlisted', () => {
  for (const name of ['Inactive:AJ BPO', 'Inactive:Plexi', 'Insurvas Test Account', '']) {
    assert.equal(isKnownCallCenter(name), false, name)
  }
})

test('case and punctuation variants fold to the canonical name', () => {
  assert.equal(normalizeCallCenterName('orbit iq'), 'Orbit IQ')
  assert.equal(normalizeCallCenterName('V-Talks'), 'V Talks')
})

test('existing aliases are unchanged', () => {
  assert.equal(normalizeCallCenterName('NextPoint BPO'), 'Nexpoint')
  assert.equal(normalizeCallCenterName('INB BPO'), 'INB')
  assert.equal(normalizeCallCenterName('Win BPO'), 'Win bpo')
  assert.equal(normalizeCallCenterName('The Zupax Marketing'), 'Zupax Marketing')
  assert.equal(normalizeCallCenterName('CrossNotchBPO'), 'Crossnotch')
})

test('the escrow name warning fires only for unlisted names', () => {
  for (const name of ['Nexpoint', 'Win bpo', 'INB', 'NextPoint BPO', 'Orbit IQ', '', 'Unassigned']) {
    assert.equal(isUnrecognisedCallCenter(name), false, name)
  }
  assert.equal(isUnrecognisedCallCenter('Some Unlisted Centre'), true)
  assert.equal(isUnrecognisedCallCenter('Vize BPO'), true)
})
