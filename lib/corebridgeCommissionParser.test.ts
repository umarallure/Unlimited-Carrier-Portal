import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractCorebridgeStatementDate,
  parseCorebridgeCommissionPdfText,
  dedupeCorebridgeCommissionRows,
  type CorebridgeCommissionRow,
} from './corebridgeCommissionParser'

const ctx = { agencyCarrierId: 'agency-1', fileId: 'file-1', storagePath: 'path/to/statement.pdf' }

test('extractCorebridgeStatementDate: parses "AS OF <Month> <DD>, <YYYY>"', () => {
  const text = 'THE UNITED STATES LIFE INSURANCE COMPANY IN THE CITY OF NEW YORK AS OF SEPTEMBER 04, 2026'
  assert.equal(extractCorebridgeStatementDate(text), '2026-09-04')
})

test('extractCorebridgeStatementDate: returns null when the header is missing', () => {
  assert.equal(extractCorebridgeStatementDate('no date header here'), null)
})

// Real statement structure (American General Life / US Life "AGL" statement, the
// carrier whose bare AD/AE column format originally triggered the bug): standard
// AD/AE rows for several policies, several of which have both an AD (advance) and
// an AE (recovered) row for the same policy — only AD should ever be captured in
// the standard block — plus an OVERRIDE block that should always be captured
// regardless of comm type.
const realStatementText = `
 AMERICAN GENERAL LIFE INSURANCE COMPANY DETAIL STATEMENT
 THE UNITED STATES LIFE INSURANCE COMPANY IN THE CITY OF NEW YORK AS OF SEPTEMBER 04, 2026
 ________________________________________________________________________________________________________________________________________________________________
 NAME: COLEMAN, AIDAN ID: AGL-1J44T
 TRANSACTION DETAIL
 ________________________________________________________________________________________________________________________________________________________________
 ANNUALIZATION

 CO POLICY INSURED EFF AGENT # BGA # COMM ANNUAL PREMIUM SPLIT SPLIT PREM ANNZ COMM OUTSTANDING COMM
 NAME NUMBER NAME DATE TYPE PREM PAID RATE RATE ADV BALANCE ACTIVITY
 AGL 7260138949 CAMPO 06/12/26 1K73M AD $0.00 $0.00 100% $1.00 75 $638.31 $638.31
 AGL 7260147120 GIVENS 06/04/26 1K73M AE $87.54 $87.54 100% $87.54 75 102% $446.46 $89.29
 AGL 7260229742 BABIAK 09/03/26 1K73M AD $894.36 $74.53 100% $894.36 75 102% $608.17 $684.19
 AGL 7260229742 BABIAK 09/03/26 1K73M AE $74.53 $74.53 100% $74.53 75 102% $608.17 $76.02
 AGL 7260239026 LEWIS 09/03/26 1K73M AD $753.84 $62.82 100% $753.84 75 147% $738.76 $831.11
 AGL 7260239026 LEWIS 09/03/26 1K73M AE $62.82 $62.82 100% $62.82 75 147% $738.76 $92.35
 SUB TOTAL PAID BY FLINCHUM, BRANDON/1K73M $2,153.61
 SUB TOTAL RECOVERED BY FLINCHUM, BRANDON/1K73M $356.57
 AGL 7260237181 SMITH 08/19/26 1N9UK AD $566.28 $47.19 100% $566.28 75 102% $385.07 $433.20
 AGL 7260237181 SMITH 08/19/26 1N9UK AE $47.19 $47.19 100% $47.19 75 102% $385.07 $48.13
 SUB TOTAL PAID BY NICHOLS, AUBREY/1N9UK $433.20
 AGL 7260227740 WARD 08/04/26 1NC72 AE $50.00 $50.00 100% $50.00 75 102% $357.00 $51.00
 TOTAL ADVANCES PAID $2,586.81

 OVERRIDE
 CO POLICY PRODUCT INSURED EFF TRX MODE AGENT # UPLINE # PREMIUM COMM SPLIT OVERRIDE
 NAME NUMBER NAME DATE DATE TYPE AMOUNT RATE COMM
 AGL 7260138949 SIMPLINOW LEGACY CAMPO 06/12/26 07/12/26FY 12 1K73M 1J44T ($89.40) 102% 100% ($91.19)
 SUB TOTAL BY FLINCHUM, BRANDON/1K73M ($178.80) ($182.38)
 TOTAL ($178.80) ($182.38)
`

test('parseCorebridgeCommissionPdfText: extracts the statement date', () => {
  const { statementDate } = parseCorebridgeCommissionPdfText(realStatementText, ctx)
  assert.equal(statementDate, '2026-09-04')
})

test('parseCorebridgeCommissionPdfText: captures every AD row with a bare (non-fused) comm-type token — the original bug', () => {
  // Before the fix, the comm-type detector required the token to be >= 4 chars
  // (assuming it was fused onto a product code like "GENERICATTAD"). This
  // statement's comm type is its own bare 2-letter column ("AD"/"AE"), which the
  // old code silently skipped entirely — zero premium rows, no error.
  const { rows } = parseCorebridgeCommissionPdfText(realStatementText, ctx)
  const standardRows = rows.filter(r => r.comm_type !== 'OVERRIDE')
  const byPolicy = new Map(standardRows.map(r => [r.policy_number, r]))

  assert.equal(standardRows.length, 4, `expected 4 AD rows, got ${standardRows.length}: ${JSON.stringify(standardRows.map(r => r.policy_number))}`)
  assert.equal(byPolicy.get('7260138949')?.commission_amount, 638.31) // CAMPO
  assert.equal(byPolicy.get('7260229742')?.commission_amount, 684.19) // BABIAK
  assert.equal(byPolicy.get('7260239026')?.commission_amount, 831.11) // LEWIS
  assert.equal(byPolicy.get('7260237181')?.commission_amount, 433.2) // SMITH
})

test('parseCorebridgeCommissionPdfText: skips AE rows in the standard block, including AE rows for a policy that also has an AD row', () => {
  const { rows } = parseCorebridgeCommissionPdfText(realStatementText, ctx)
  const standardRows = rows.filter(r => r.comm_type !== 'OVERRIDE')
  // GIVENS, GRAZIANO, HARRIS, WARD are AE-only and must never appear.
  assert.ok(!standardRows.some(r => r.insured_name === 'GIVENS'))
  assert.ok(!standardRows.some(r => r.insured_name === 'WARD'))
  // BABIAK/LEWIS/SMITH each have both an AD and an AE line for the same policy —
  // only one row per policy should survive (the AD one).
  const babiakRows = standardRows.filter(r => r.policy_number === '7260229742')
  assert.equal(babiakRows.length, 1)
  assert.equal(babiakRows[0].comm_type, 'AD')
})

test('parseCorebridgeCommissionPdfText: OVERRIDE block rows are captured regardless of comm type, with the negative override commission', () => {
  const { rows } = parseCorebridgeCommissionPdfText(realStatementText, ctx)
  const overrideRows = rows.filter(r => r.comm_type === 'OVERRIDE')
  assert.equal(overrideRows.length, 1)
  assert.equal(overrideRows[0].policy_number, '7260138949')
  assert.equal(overrideRows[0].commission_amount, -91.19)
})

test('parseCorebridgeCommissionPdfText: SUB TOTAL / TOTAL summary lines are never parsed as data rows', () => {
  const { rows } = parseCorebridgeCommissionPdfText(realStatementText, ctx)
  assert.ok(!rows.some(r => (r.insured_name ?? '').toUpperCase().includes('SUB TOTAL')))
  assert.ok(!rows.some(r => (r.insured_name ?? '').toUpperCase().includes('TOTAL')))
})

test('parseCorebridgeCommissionPdfText: a comm-type token fused onto a longer product code (legacy format) still works', () => {
  const text = `
 AS OF FEBRUARY 06, 2026
 CO NAME POLICY NUMBER COMM RATE
 AGL 6250123368 DUCKNEY 07/04/25 18AG5 GENERICATTAD $50.00 $50.00 100% $50.00 75 102% $300.00 $51.00
 AGL 6250123369 OTHER 07/05/25 18AG5 GENERICATTAE $20.00 $20.00 100% $20.00 75 102% $100.00 $20.40
`
  const { rows } = parseCorebridgeCommissionPdfText(text, ctx)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].policy_number, '6250123368')
  assert.equal(rows[0].comm_type, 'GENERICATTAD')
})

test('parseCorebridgeCommissionPdfText: no rows and no throw on text with no matching lines', () => {
  const { rows, statementDate } = parseCorebridgeCommissionPdfText('nothing here', ctx)
  assert.deepEqual(rows, [])
  assert.equal(statementDate, null)
})

test('dedupeCorebridgeCommissionRows: keeps one row per (agency_carrier_id, policy_number), last one wins', () => {
  const base = (overrides: Partial<CorebridgeCommissionRow>): CorebridgeCommissionRow => ({
    agency_carrier_id: 'agency-1',
    file_id: 'file-1',
    row_number: 1,
    policy_number: 'P1',
    statement_date: null,
    co_name: 'AGL',
    insured_name: null,
    issue_date: null,
    agent_code: null,
    bga_code: null,
    comm_type: 'AD',
    annual_premium: null,
    premium: null,
    split_pct: null,
    split_premium: null,
    annual_comm_rate: null,
    comm_pct: null,
    advance_balance: null,
    commission_amount: null,
    source_file: 'x.pdf',
    source_format: 'COREBRIDGE_COMMISSION_PDF',
    ...overrides,
  })
  const rows = [
    base({ commission_amount: 100 }),
    base({ commission_amount: 200 }), // same agency+policy — should win
    base({ policy_number: 'P2', commission_amount: 50 }),
  ]
  const deduped = dedupeCorebridgeCommissionRows(rows)
  assert.equal(deduped.length, 2)
  const p1 = deduped.find(r => r.policy_number === 'P1')
  assert.equal(p1?.commission_amount, 200)
})
