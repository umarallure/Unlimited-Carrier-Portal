import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ADVANCE_CHARGEBACK_HEADERS,
  applyFilters,
  buildAdvanceChargebackRows,
  displayCarrier,
  exportFileName,
  formatRate,
  formatUsDate,
  normalizeAgentName,
  normalizeCommissionRate,
  normalizePersonName,
  policyLast3,
  rowToCsvValues,
  rowsToCsv,
  toTitleCase,
  type CommissionTxn,
  type DealInfo,
  type ReportContext,
} from './commissionAdvanceChargebackReport'

const CTX: ReportContext = {
  carrierNameByCode: new Map([
    ['AETNA', 'Aetna'],
    ['AFLAC', 'Aflac'],
    ['AHL', 'AHL'],
    ['AMAM', 'AMAM (American Amicable)'],
    ['AMERICO', 'Americo'],
    ['COREBRIDGE', 'CoreBridge'],
    ['MOH', 'Mutual of Omaha'],
    ['SENTINEL', 'Sentinel'],
  ]),
  carrierNames: ['Aetna', 'Aflac', 'AHL', 'AMAM (American Amicable)', 'Americo', 'CoreBridge', 'Mutual of Omaha', 'Sentinel'],
  agencyByAcId: new Map([['ac-1', 'Unlimited']]),
}

function txn(partial: Partial<CommissionTxn> & Pick<CommissionTxn, 'policy_number' | 'date'>): CommissionTxn {
  return { agency_carrier_id: 'ac-1', ...partial }
}

function deal(partial: Partial<DealInfo> & Pick<DealInfo, 'policy_number'>): DealInfo {
  return { agency_carrier_id: 'ac-1', ...partial }
}

// ───────────────────────────── value helpers ─────────────────────────────

test('policyLast3 takes the trailing three characters', () => {
  assert.equal(policyLast3('AMH6304968'), '968')
  assert.equal(policyLast3('0114280680'), '680')
  assert.equal(policyLast3('ACC7162949'), '949')
  assert.equal(policyLast3('0112650500'), '500')
  assert.equal(policyLast3('12'), '12')
  assert.equal(policyLast3(''), '')
})

test('formatUsDate converts stored dates without shifting the calendar day', () => {
  assert.equal(formatUsDate('2026-04-04'), '04/04/2026')
  assert.equal(formatUsDate('2025-11-05'), '11/05/2025')
  assert.equal(formatUsDate(''), '')
  assert.equal(formatUsDate('not-a-date'), '')
})

test('normalizeCommissionRate scales the multiplier form up to a percentage', () => {
  assert.equal(normalizeCommissionRate(1.45), 145)
  assert.equal(normalizeCommissionRate('145.00'), 145)
  assert.equal(normalizeCommissionRate(137), 137)
  assert.equal(normalizeCommissionRate(0.85), 85)
  assert.equal(normalizeCommissionRate(0), null, 'a zero rate means "not stated", not 0%')
  assert.equal(normalizeCommissionRate(null), null)
  assert.equal(normalizeCommissionRate(''), null)
})

test('formatRate drops trailing zeros but keeps real decimals', () => {
  assert.equal(formatRate(145), '145')
  assert.equal(formatRate(137.5), '137.5')
  assert.equal(formatRate(null), '')
})

test('toTitleCase tidies shouted carrier-file names', () => {
  assert.equal(toTitleCase('CARLA JEFFERSON'), 'Carla Jefferson')
  assert.equal(toTitleCase('BERENISE C GOMEZ'), 'Berenise C Gomez')
  assert.equal(toTitleCase('Joyce Rittenhouse'), 'Joyce Rittenhouse')
  assert.equal(toTitleCase('  diana   mercedes  campo '), 'Diana Mercedes Campo')
})

test('normalizePersonName puts the first name first but keeps middle names', () => {
  assert.equal(normalizePersonName('CAMPO,DIANA MERCEDES'), 'Diana Mercedes Campo')
  assert.equal(normalizePersonName('RITTENHOUSE,JOYCE'), 'Joyce Rittenhouse')
  assert.equal(normalizePersonName('CARLA JEFFERSON'), 'Carla Jefferson')
  assert.equal(normalizePersonName('BERENISE C GOMEZ'), 'Berenise C Gomez', 'a customer keeps their middle initial')
  assert.equal(normalizePersonName('Joseph A Lovecchio'), 'Joseph A Lovecchio')
  assert.equal(normalizePersonName(null), '')
})

test('the fullest spelling of a customer name wins across transactions', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({ id: '1', policy_number: 'N1', carrier: 'Aetna', name: 'JOSEPH LOVECCHIO', date: '2025-11-05', commission_rate: 144, advance_amount: 309.12 }),
      txn({ id: '2', policy_number: 'N1', carrier: 'Aetna', name: 'Joseph A Lovecchio', date: '2026-09-12', charge_back_amount: -180.32 }),
    ],
    [deal({ policy_number: 'N1', call_center: 'Plexi', policy_type: 'Final Exp' })],
    {},
    CTX
  )
  assert.equal(rows[0].customerName, 'Joseph A Lovecchio')
})

test('name, agent, product and call center fall back to the deal tracker row', () => {
  // CoreBridge statements arrive with no insured name or agent on the line.
  const rows = buildAdvanceChargebackRows(
    [
      txn({ id: '1', policy_number: '7260138949', carrier: 'COREBRIDGE', name: null, sales_agent: null, date: '2026-06-12', advance_amount: 820.69 }),
      txn({ id: '2', policy_number: '7260138949', carrier: 'COREBRIDGE', name: null, sales_agent: null, date: '2026-08-14', charge_back_amount: -638.31 }),
    ],
    [deal({
      policy_number: '7260138949',
      name: 'CAMPO,DIANA MERCEDES',
      sales_agent: 'FLINCHUM, BRANDON',
      call_center: 'NextPoint BPO',
      policy_type: 'Whole Life Insurance',
    })],
    {},
    CTX
  )
  assert.deepEqual(rowToCsvValues(rows[0]), [
    '06/12/2026',
    '949',
    'Diana Mercedes Campo',
    'CoreBridge',
    'Brandon Flinchum',
    '',
    'Whole Life Insurance',
    '820.69',
    '-638.31',
    'NextPoint BPO',
    '08/14/2026',
    '',
    '',
    '',
    '',
    '',
    'Missing commission rate; Generic product - no plan code on file',
  ])
})

test('double spaces inside a stored product name are collapsed', () => {
  const rows = buildAdvanceChargebackRows(
    [txn({ id: '1', policy_number: 'M1', carrier: 'MOH', name: 'Carol Sue Brooks', date: '2026-01-07', commission_rate: 125, advance_amount: 968.4 })],
    [deal({ policy_number: 'M1', call_center: 'Plexi', policy_type: 'Living Promise - Level  Benefit' })],
    {},
    CTX
  )
  assert.equal(rows[0].productCode, 'Living Promise - Level Benefit')
  assert.equal(rows[0].carrier, 'Mutual of Omaha')
})

test('normalizeAgentName folds every carrier spelling into one display name', () => {
  // "Last/ First" and "Last, First"
  assert.equal(normalizeAgentName('FLINCHUM/ BRANDON'), 'Brandon Flinchum')
  assert.equal(normalizeAgentName('FLINCHUM, BRANDON'), 'Brandon Flinchum')
  assert.equal(normalizeAgentName('Flinchum,Brandon'), 'Brandon Flinchum')
  assert.equal(normalizeAgentName('BRANDON FLINCHUM'), 'Brandon Flinchum')
  // middle initials are dropped
  assert.equal(normalizeAgentName('REED/ ISAAC J'), 'Isaac Reed')
  assert.equal(normalizeAgentName('SUTTON/ LYDIA R'), 'Lydia Sutton')
  assert.equal(normalizeAgentName('WUNDER/ BENJAMIN M'), 'Benjamin Wunder')
  assert.equal(normalizeAgentName('HICKS/ ERICA L'), 'Erica Hicks')
  // compound surnames survive the reorder
  assert.equal(normalizeAgentName('MUNOZ BONILLA/ ANDREA'), 'Andrea Munoz Bonilla')
  assert.equal(normalizeAgentName('VARGAS/ DANIEL'), 'Daniel Vargas')
  // aliases for the spellings the generic rules cannot repair
  assert.equal(normalizeAgentName('TRADARDI NAPOLETANO/ CLAU'), 'Claudia Tradardi')
  assert.equal(normalizeAgentName('TRADARDI NAPOLETANO, CLAUDIA'), 'Claudia Tradardi')
  assert.equal(normalizeAgentName('SUTTON, LYDIA ROSE'), 'Lydia Sutton')
  assert.equal(normalizeAgentName('Vargas,Daniel Albert'), 'Daniel Vargas')
  assert.equal(normalizeAgentName('SANCHEZ SANTIAGO/ MARIA'), 'Maria Sanchez')
  assert.equal(normalizeAgentName('Brandom Flinchum'), 'Brandon Flinchum')
  assert.equal(normalizeAgentName('FLINCHUM BRANDON'), 'Brandon Flinchum')
  // writing numbers are not names
  assert.equal(normalizeAgentName('0001172685'), '')
  assert.equal(normalizeAgentName('1227642'), '')
  assert.equal(normalizeAgentName(null), '')
})

test('displayCarrier resolves codes and strips the parenthetical long name', () => {
  assert.equal(displayCarrier('AMAM (American Amicable)', CTX), 'AMAM')
  assert.equal(displayCarrier('AMAM', CTX), 'AMAM')
  assert.equal(displayCarrier('AETNA', CTX), 'Aetna')
  assert.equal(displayCarrier('Aetna', CTX), 'Aetna')
  assert.equal(displayCarrier('MOH', CTX), 'Mutual of Omaha')
  assert.equal(displayCarrier('COREBRIDGE', CTX), 'CoreBridge')
  assert.equal(displayCarrier('AHL', CTX), 'AHL')
  assert.equal(displayCarrier('', CTX), '')
})

// ───────────────────────── row shape, against the sample ─────────────────────────

test('header row matches the finance spreadsheet column order exactly', () => {
  assert.deepEqual(ADVANCE_CHARGEBACK_HEADERS.slice(), [
    'Date',
    'Policy Last 3 Digits',
    'Customer Name',
    'Carrier',
    'Sales Agent',
    'Commission Rate',
    'Product Code',
    'Advance',
    'Chargeback',
    'Call Center Name',
    'Chargeback Date',
    'Advance 2 Date',
    'Advance 2',
    'Commission Rate 2',
    'Chargeback 2',
    'Chargeback 2 Date',
    'Data Check',
  ])
})

test('an advance plus a later chargeback reproduces the sample AHL row', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({
        id: '1',
        policy_number: 'AMH6304968',
        carrier: 'AHL',
        name: 'CARLA JEFFERSON',
        sales_agent: 'Brandon Flinchum',
        date: '2026-04-04',
        commission_rate: 120,
        advance_amount: 547.74,
      }),
      // A zero-dollar statement line: carried in the tracker, never in the report.
      txn({ id: '2', policy_number: 'AMH6304968', carrier: 'AHL', date: '2026-05-06', commission_rate: 120, advance_amount: 0 }),
      txn({
        id: '3',
        policy_number: 'AMH6304968',
        carrier: 'AHL',
        name: 'Carla Jefferson',
        sales_agent: 'Brandon Flinchum',
        date: '2026-08-19',
        commission_rate: 0,
        charge_back_amount: -365.16,
      }),
    ],
    [deal({ policy_number: 'AMH6304968', call_center: 'Win BPO', policy_type: 'Final Exp' })],
    {},
    CTX
  )

  assert.equal(rows.length, 1)
  assert.deepEqual(rowToCsvValues(rows[0]), [
    '04/04/2026',
    '968',
    'Carla Jefferson',
    'AHL',
    'Brandon Flinchum',
    '120',
    'Final Exp',
    '547.74',
    '-365.16',
    'Win BPO',
    '08/19/2026',
    '',
    '',
    '',
    '',
    '',
    'Generic product - no plan code on file',
  ])
})

test('two advances fill the Advance 2 columns and leave the chargeback columns empty', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({
        id: '1',
        policy_number: '0114280680',
        carrier: 'AMAM (American Amicable)',
        name: 'BERENISE C GOMEZ',
        sales_agent: 'VARGAS/ DANIEL',
        date: '2026-07-31',
        commission_rate: 1.45,
        advance_amount: 43.5,
      }),
      txn({
        id: '2',
        policy_number: '0114280680',
        carrier: 'AMAM (American Amicable)',
        name: 'BERENISE C GOMEZ',
        sales_agent: 'VARGAS/ DANIEL',
        date: '2026-08-09',
        commission_rate: '145.00',
        advance_amount: 391.5,
      }),
    ],
    [deal({ policy_number: '0114280680', call_center: 'TIC Service', policy_type: 'CCI3NFL' })],
    {},
    CTX
  )

  assert.deepEqual(rowToCsvValues(rows[0]), [
    '07/31/2026',
    '680',
    'Berenise C Gomez',
    'AMAM',
    'Daniel Vargas',
    '145',
    'CCI3NFL',
    '43.50',
    '',
    'TIC Service',
    '',
    '08/09/2026',
    '391.50',
    '145',
    '',
    '',
    '',
  ])
})

test('a repeated chargeback lands in the Chargeback 2 columns', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({
        id: '1',
        policy_number: 'ACC7162949',
        carrier: 'Aetna',
        name: 'LEAH KEYES',
        sales_agent: 'Isaac Reed',
        date: '2026-03-04',
        commission_rate: 137,
        advance_amount: 969.6,
      }),
      txn({ id: '2', policy_number: 'ACC7162949', carrier: 'Aetna', name: 'Leah Keyes', date: '2026-08-12', charge_back_amount: -646.4 }),
      txn({ id: '3', policy_number: 'ACC7162949', carrier: 'Aetna', name: 'Leah Keyes', date: '2026-08-15', charge_back_amount: -646.4 }),
    ],
    [deal({ policy_number: 'ACC7162949', call_center: 'Everest BPO', policy_type: 'Final Exp' })],
    {},
    CTX
  )

  const values = rowToCsvValues(rows[0])
  assert.equal(values[8], '-646.40', 'first chargeback')
  assert.equal(values[10], '08/12/2026')
  assert.equal(values[14], '-646.40', 'second chargeback')
  assert.equal(values[15], '08/15/2026')
  assert.equal(values[16], 'Generic product - no plan code on file')
})

test('a missing commission rate is reported before the product note', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({
        id: '1',
        policy_number: 'U10034949',
        carrier: 'CoreBridge',
        name: 'Diana Mercedes Campo',
        sales_agent: 'Brandon Flinchum',
        date: '2026-06-12',
        commission_rate: null,
        advance_amount: 820.69,
      }),
      txn({ id: '2', policy_number: 'U10034949', carrier: 'CoreBridge', date: '2026-08-14', charge_back_amount: -638.31 }),
    ],
    [deal({ policy_number: 'U10034949', call_center: 'NextPoint BPO', policy_type: 'Whole Life Insurance' })],
    {},
    CTX
  )

  assert.equal(rows[0].commissionRate, '')
  assert.equal(rows[0].dataCheck, 'Missing commission rate; Generic product - no plan code on file')
})

test('a specific plan code produces no data-check note', () => {
  const rows = buildAdvanceChargebackRows(
    [txn({ id: '1', policy_number: 'NV0000669', carrier: 'Sentinel', date: '2026-07-06', commission_rate: 85, advance_amount: 173.08 })],
    [deal({ policy_number: 'NV0000669', call_center: 'CrossNotch', policy_type: 'New Vantage III' })],
    {},
    CTX
  )
  assert.equal(rows[0].dataCheck, '')
})

test('a policy with no deal tracker row says so instead of silently blanking two columns', () => {
  const rows = buildAdvanceChargebackRows(
    [txn({ id: '1', policy_number: 'X999', carrier: 'Aetna', date: '2026-01-02', commission_rate: 120, advance_amount: 100 })],
    [],
    {},
    CTX
  )
  assert.equal(rows[0].productCode, '')
  assert.equal(rows[0].callCenter, '')
  assert.equal(rows[0].dataCheck, 'No deal tracker match - product code and call center unavailable')
})

test('a third advance or chargeback is flagged rather than dropped silently', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({ id: '1', policy_number: 'P1', carrier: 'Aetna', date: '2026-01-01', commission_rate: 120, advance_amount: 100 }),
      txn({ id: '2', policy_number: 'P1', carrier: 'Aetna', date: '2026-02-01', commission_rate: 120, advance_amount: 200 }),
      txn({ id: '3', policy_number: 'P1', carrier: 'Aetna', date: '2026-03-01', commission_rate: 120, advance_amount: 300 }),
      txn({ id: '4', policy_number: 'P1', carrier: 'Aetna', date: '2026-04-01', charge_back_amount: -10 }),
      txn({ id: '5', policy_number: 'P1', carrier: 'Aetna', date: '2026-05-01', charge_back_amount: -20 }),
      txn({ id: '6', policy_number: 'P1', carrier: 'Aetna', date: '2026-06-01', charge_back_amount: -30 }),
      txn({ id: '7', policy_number: 'P1', carrier: 'Aetna', date: '2026-07-01', charge_back_amount: -40 }),
    ],
    [deal({ policy_number: 'P1', call_center: 'Plexi', policy_type: 'CCI3N' })],
    {},
    CTX
  )
  assert.equal(rows[0].dataCheck, '1 more advance not shown; 2 more chargebacks not shown')
  assert.equal(rows[0].advanceTotal, 600)
  assert.equal(rows[0].chargebackTotal, -100)
})

test('duplicate statement lines for the same day and amount are counted once', () => {
  const rows = buildAdvanceChargebackRows(
    [
      txn({ id: '1', policy_number: 'P2', carrier: 'Aetna', date: '2026-01-01', commission_rate: 120, advance_amount: 500 }),
      txn({ id: '2', policy_number: 'P2', carrier: 'Aetna', date: '2026-01-01', commission_rate: 120, advance_amount: 500 }),
    ],
    [deal({ policy_number: 'P2', call_center: 'Plexi', policy_type: 'CCI3N' })],
    {},
    CTX
  )
  assert.equal(rows[0].advance, '500.00')
  assert.equal(rows[0].advance2, '', 'the duplicate must not become a second advance')
})

test('a chargeback-only policy anchors Date on the chargeback', () => {
  const rows = buildAdvanceChargebackRows(
    [txn({ id: '1', policy_number: '0112650500', carrier: 'AMAM (American Amicable)', name: 'JOYCE RITTENHOUSE', sales_agent: 'FLINCHUM/ BRANDON', date: '2026-08-11', charge_back_amount: -222.08 })],
    [deal({ policy_number: '0112650500', call_center: 'CrossNotch', policy_type: 'CCI3N' })],
    {},
    CTX
  )
  assert.equal(rows[0].date, '08/11/2026')
  assert.equal(rows[0].advance, '')
  assert.equal(rows[0].chargeback, '-222.08')
  assert.equal(rows[0].dataCheck, '', 'no advance means no "missing commission rate" note')
})

// ───────────────────────────────── filters ─────────────────────────────────

const FILTER_FIXTURE = () =>
  buildAdvanceChargebackRows(
    [
      txn({ id: '1', policy_number: 'A1', carrier: 'Aetna', name: 'Ann Advance', sales_agent: 'Isaac Reed', date: '2026-03-04', commission_rate: 137, advance_amount: 900 }),
      txn({ id: '2', policy_number: 'A1', carrier: 'Aetna', date: '2026-09-12', charge_back_amount: -600 }),
      txn({ id: '3', policy_number: 'B2', carrier: 'AHL', name: 'Bob Only', sales_agent: 'Lydia Sutton', date: '2026-08-20', commission_rate: 120, advance_amount: 300 }),
      txn({ id: '4', policy_number: 'C3', carrier: 'AHL', name: 'Cal Back', sales_agent: 'Lydia Sutton', date: '2026-08-25', charge_back_amount: -75 }),
    ],
    [
      deal({ policy_number: 'A1', call_center: 'Everest BPO', policy_type: 'Final Exp' }),
      deal({ policy_number: 'B2', call_center: 'Win BPO', policy_type: 'Final Exp' }),
      deal({ policy_number: 'C3', call_center: 'Win BPO', policy_type: 'Final Exp' }),
    ],
    {},
    CTX
  )

test('the date range selects policies but still shows their whole history', () => {
  // A1 qualifies on its September chargeback; its March advance must survive.
  const [selected] = applyFilters(FILTER_FIXTURE(), { dateFrom: '2026-09-01', dateTo: '2026-09-30' })
  assert.equal(selected.policyNumber, 'A1')
  assert.equal(selected.date, '03/04/2026')
  assert.equal(selected.advance, '900.00')
  assert.equal(selected.chargebackDate, '09/12/2026')
})

test('dateBasis picks which side of the policy has to land in the range', () => {
  const all = FILTER_FIXTURE()
  const only = (filters: Parameters<typeof buildAdvanceChargebackRows>[2]) =>
    buildAdvanceChargebackRows(
      [
        txn({ id: '1', policy_number: 'A1', carrier: 'Aetna', date: '2026-03-04', commission_rate: 137, advance_amount: 900 }),
        txn({ id: '2', policy_number: 'A1', carrier: 'Aetna', date: '2026-09-12', charge_back_amount: -600 }),
      ],
      [deal({ policy_number: 'A1', call_center: 'Everest BPO', policy_type: 'Final Exp' })],
      filters,
      CTX
    )

  assert.equal(all.length, 3)
  assert.equal(only({ dateFrom: '2026-09-01', dateTo: '2026-09-30', dateBasis: 'chargeback' }).length, 1)
  assert.equal(only({ dateFrom: '2026-09-01', dateTo: '2026-09-30', dateBasis: 'advance' }).length, 0)
  assert.equal(only({ dateFrom: '2026-09-01', dateTo: '2026-09-30', dateBasis: 'any' }).length, 1)
  assert.equal(only({ dateFrom: '2026-03-01', dateTo: '2026-03-31', dateBasis: 'advance' }).length, 1)
  assert.equal(only({ dateFrom: '2026-01-01', dateTo: '2026-01-31', dateBasis: 'any' }).length, 0)
})

test('carrier, call centre, agent and product filters narrow the export', () => {
  const build = (filters: Parameters<typeof buildAdvanceChargebackRows>[2]) =>
    buildAdvanceChargebackRows(
      [
        txn({ id: '1', policy_number: 'A1', carrier: 'Aetna', sales_agent: 'Isaac Reed', date: '2026-03-04', commission_rate: 137, advance_amount: 900 }),
        txn({ id: '3', policy_number: 'B2', carrier: 'AHL', sales_agent: 'Lydia Sutton', date: '2026-08-20', commission_rate: 120, advance_amount: 300 }),
      ],
      [
        deal({ policy_number: 'A1', call_center: 'Everest BPO', policy_type: 'Final Exp' }),
        deal({ policy_number: 'B2', call_center: 'Win BPO', policy_type: 'CCI3N' }),
      ],
      filters,
      CTX
    )

  assert.deepEqual(build({ carriers: ['AHL'] }).map((r) => r.policyNumber), ['B2'])
  assert.deepEqual(build({ callCenters: ['Everest BPO'] }).map((r) => r.policyNumber), ['A1'])
  assert.deepEqual(build({ salesAgents: ['Lydia Sutton'] }).map((r) => r.policyNumber), ['B2'])
  assert.deepEqual(build({ productCodes: ['CCI3N'] }).map((r) => r.policyNumber), ['B2'])
  assert.deepEqual(build({ agencies: ['Unlimited'] }).map((r) => r.policyNumber).sort(), ['A1', 'B2'])
  assert.deepEqual(build({ agencies: ['Someone Else'] }), [])
})

test('the activity filter separates advances from chargebacks', () => {
  const rows = FILTER_FIXTURE()

  assert.deepEqual(applyFilters(rows, { activity: 'with_chargeback' }).map((r) => r.policyNumber).sort(), ['A1', 'C3'])
  assert.deepEqual(applyFilters(rows, { activity: 'advance_only' }).map((r) => r.policyNumber), ['B2'])
  assert.deepEqual(applyFilters(rows, { activity: 'chargeback_only' }).map((r) => r.policyNumber), ['C3'])
  assert.equal(applyFilters(rows, { activity: 'all' }).length, 3)
})

test('search matches a name, a policy number, or a comma-separated policy list', () => {
  const rows = FILTER_FIXTURE()

  assert.deepEqual(applyFilters(rows, { search: 'bob' }).map((r) => r.policyNumber), ['B2'])
  assert.deepEqual(applyFilters(rows, { search: 'C3' }).map((r) => r.policyNumber), ['C3'])
  assert.deepEqual(applyFilters(rows, { search: 'A1, C3' }).map((r) => r.policyNumber).sort(), ['A1', 'C3'])
  assert.deepEqual(applyFilters(rows, { search: 'nothing here' }), [])
})

test('rows come back newest anchor date first', () => {
  const rows = FILTER_FIXTURE()
  assert.deepEqual(rows.map((r) => r.policyNumber), ['C3', 'B2', 'A1'])
})

// ─────────────────────────────────── CSV ───────────────────────────────────

test('rowsToCsv writes the header plus one line per policy', () => {
  const rows = FILTER_FIXTURE()
  const csv = rowsToCsv(rows)
  const lines = csv.split('\r\n')
  assert.equal(lines[0], ADVANCE_CHARGEBACK_HEADERS.join(','))
  assert.equal(lines.length, rows.length + 1)
})

test('values containing a comma or quote are escaped', () => {
  const rows = buildAdvanceChargebackRows(
    [txn({ id: '1', policy_number: 'Q1', carrier: 'Aetna', name: 'John "JJ" Smith', date: '2026-01-01', commission_rate: 120, advance_amount: 10 })],
    // A product description with a comma in it would otherwise split the row.
    [deal({ policy_number: 'Q1', call_center: 'Win BPO', policy_type: 'Whole Life, Level' })],
    {},
    CTX
  )
  const line = rowsToCsv(rows).split('\r\n')[1]
  assert.ok(line.includes('"John ""Jj"" Smith"'), `quote escaping: ${line}`)
  assert.ok(line.includes('"Whole Life, Level"'), `comma escaping: ${line}`)
  assert.equal(line.split(',').length, ADVANCE_CHARGEBACK_HEADERS.length + 1, 'the escaped comma stays inside its quoted field')
})

test('an empty result still writes the header so the file opens cleanly', () => {
  assert.equal(rowsToCsv([]), ADVANCE_CHARGEBACK_HEADERS.join(','))
})

test('the file name carries the selected range and the generation date', () => {
  const today = new Date('2026-10-06T12:00:00Z')
  assert.equal(
    exportFileName({ dateFrom: '2026-08-19', dateTo: '2026-09-15' }, today),
    'commission-advance-chargeback_20260819-20260915_2026-10-06.csv'
  )
  assert.equal(exportFileName({}, today), 'commission-advance-chargeback_2026-10-06.csv')
})
