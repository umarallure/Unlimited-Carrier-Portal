import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildCenterRows,
  buildCycleRows,
  buildTotals,
  cycleRowsToCsv,
  formatCycleLabel,
  ESCROW_EXPORT_HEADERS,
  type EscrowLedgerEntry,
} from './escrowLedgerReport'

let seq = 0
function entry(partial: Partial<EscrowLedgerEntry> = {}): EscrowLedgerEntry {
  seq += 1
  return {
    id: `e${seq}`,
    call_center: 'Orbit IQ',
    entry_type: 'hold',
    amount: 100,
    balance_after: 100,
    cycle_start_date: '2026-09-30',
    cycle_end_date: '2026-10-13',
    invoicing_batch_id: 'b1',
    reverses_entry_id: null,
    basis: 'lead_value',
    memo: null,
    created_by_email: 'admin@insurvas.com',
    created_at: `2026-10-20T10:00:0${seq % 10}Z`,
    ...partial,
  }
}

// ───────────────────────────── cycle labels ─────────────────────────────

test('a cycle inside one year reads as a single range', () => {
  assert.equal(formatCycleLabel('2026-09-30', '2026-10-13'), 'Sep 30 – Oct 13, 2026')
})

test('a cycle spanning new year names both years', () => {
  assert.equal(formatCycleLabel('2026-12-23', '2027-01-05'), 'Dec 23, 2026 – Jan 5, 2027')
})

test('an entry with no cycle says so rather than printing nulls', () => {
  assert.equal(formatCycleLabel(null, null), 'No cycle recorded')
})

// ───────────────────────── the real migrated data ─────────────────────────

test('the two migrated work-chest holds summarise as one cycle', () => {
  const rows = buildCycleRows([
    entry({ call_center: 'Orbit IQ', amount: 8528.55, entry_type: 'hold' }),
    entry({ call_center: 'INB', amount: 2729.91, entry_type: 'hold' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].hold, 11258.46)
  assert.equal(rows[0].net, 11258.46)
  assert.equal(rows[0].runningTotal, 11258.46)
  assert.deepEqual(rows[0].centers.map((c) => c.callCenter), ['Orbit IQ', 'INB'], 'largest first')
  assert.equal(rows[0].centers[0].hold, 8528.55)
  assert.equal(rows[0].centers[1].hold, 2729.91)
})

test('the total held matches the sum of the centers', () => {
  const entries = [
    entry({ call_center: 'Orbit IQ', amount: 8528.55 }),
    entry({ call_center: 'INB', amount: 2729.91 }),
  ]
  const totals = buildTotals(entries)
  const centers = buildCenterRows(entries)
  assert.equal(totals.heldNow, 11258.46)
  assert.equal(totals.centersWithBalance, 2)
  assert.equal(Math.round(centers.reduce((s, c) => s + c.balance, 0) * 100) / 100, totals.heldNow)
})

// ───────────────────── the running total across cycles ─────────────────────

test('each cycle carries the total held as at the end of it, newest first', () => {
  const rows = buildCycleRows([
    entry({ amount: 1000, cycle_start_date: '2026-09-30', cycle_end_date: '2026-10-13' }),
    entry({ amount: 500, cycle_start_date: '2026-10-14', cycle_end_date: '2026-10-27' }),
    entry({ amount: 250, cycle_start_date: '2026-10-28', cycle_end_date: '2026-11-10' }),
  ])
  assert.deepEqual(rows.map((r) => r.cycleEnd), ['2026-11-10', '2026-10-27', '2026-10-13'])
  assert.deepEqual(rows.map((r) => r.runningTotal), [1750, 1500, 1000])
})

test('money taken out lowers the running total', () => {
  const rows = buildCycleRows([
    entry({ amount: 1000, cycle_start_date: '2026-09-30', cycle_end_date: '2026-10-13' }),
    entry({ amount: -400, entry_type: 'draw', cycle_start_date: '2026-10-14', cycle_end_date: '2026-10-27' }),
  ])
  assert.equal(rows[0].outflow, -400)
  assert.equal(rows[0].net, -400)
  assert.equal(rows[0].runningTotal, 600)
})

// ──────────────────────── un-paying an invoice ────────────────────────

test('a reversed cycle nets to zero but still shows what happened', () => {
  // The ledger is append-only: un-paying adds a reversal rather than deleting.
  const rows = buildCycleRows([
    entry({ id: 'h1', amount: 8528.55, entry_type: 'hold' }),
    entry({ amount: -8528.55, entry_type: 'reversal', reverses_entry_id: 'h1', invoicing_batch_id: null }),
  ])
  assert.equal(rows[0].hold, 8528.55, 'the hold is still visible')
  assert.equal(rows[0].reversed, -8528.55, 'and so is its cancellation')
  assert.equal(rows[0].net, 0)
  assert.equal(rows[0].runningTotal, 0)
  assert.equal(buildTotals(rows.length ? [] : []).heldNow, 0)
})

test('a center whose balance has returned to zero is not counted as holding', () => {
  const totals = buildTotals([
    entry({ id: 'h1', call_center: 'INB', amount: 2729.91, entry_type: 'hold' }),
    entry({ call_center: 'INB', amount: -2729.91, entry_type: 'reversal', reverses_entry_id: 'h1' }),
    entry({ call_center: 'Orbit IQ', amount: 100, entry_type: 'hold' }),
  ])
  assert.equal(totals.heldNow, 100)
  assert.equal(totals.centersWithBalance, 1)
  assert.equal(totals.everIn, 2829.91, 'what went in is still reported')
  assert.equal(totals.everReversed, -2729.91)
})

// ─────────────────────── entries with no cycle ───────────────────────

test('an entry with no cycle is kept in its own row, not dropped', () => {
  const rows = buildCycleRows([
    entry({ amount: 1000 }),
    entry({ amount: 50, entry_type: 'adjustment', cycle_start_date: null, cycle_end_date: null, invoicing_batch_id: null }),
  ])
  assert.equal(rows.length, 2)
  const unassigned = rows.find((r) => r.key === 'unassigned')
  assert.ok(unassigned)
  assert.equal(unassigned.net, 50)
  // The rows must still account for every cent of the balance.
  assert.equal(
    Math.round(rows.reduce((s, r) => s + r.net, 0) * 100) / 100,
    buildTotals([entry({ amount: 1000 }), entry({ amount: 50 })]).heldNow,
  )
})

test('an undated entry never disturbs a dated cycle running total', () => {
  const rows = buildCycleRows([
    entry({ amount: 1000, cycle_start_date: '2026-09-30', cycle_end_date: '2026-10-13' }),
    entry({ amount: 999, cycle_start_date: null, cycle_end_date: null }),
  ])
  const dated = rows.find((r) => r.cycleEnd === '2026-10-13')
  assert.equal(dated?.runningTotal, 1000, 'the dated cycle is unaffected by the undated entry')
})

// ─────────────────────────── per center ───────────────────────────

test('a center row adds up how its balance was reached', () => {
  const rows = buildCenterRows([
    entry({ call_center: 'INB', amount: 2729.91, entry_type: 'opening_transfer' }),
    entry({ call_center: 'INB', amount: 500, entry_type: 'hold', cycle_end_date: '2026-10-27' }),
    entry({ call_center: 'INB', amount: -200, entry_type: 'draw', cycle_end_date: '2026-10-27' }),
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].openingTransfer, 2729.91)
  assert.equal(rows[0].hold, 500)
  assert.equal(rows[0].outflow, -200)
  assert.equal(rows[0].balance, 3029.91)
  assert.equal(rows[0].cyclesContributed, 2)
  assert.equal(rows[0].entryCount, 3)
})

test('centers are listed with the biggest balance first', () => {
  const rows = buildCenterRows([
    entry({ call_center: 'INB', amount: 2729.91 }),
    entry({ call_center: 'Orbit IQ', amount: 8528.55 }),
    entry({ call_center: 'Plexi', amount: 100 }),
  ])
  assert.deepEqual(rows.map((r) => r.callCenter), ['Orbit IQ', 'INB', 'Plexi'])
})

// ─────────────────────────────── export ───────────────────────────────

test('the CSV has one line per center per cycle', () => {
  const rows = buildCycleRows([
    entry({ call_center: 'Orbit IQ', amount: 8528.55 }),
    entry({ call_center: 'INB', amount: 2729.91 }),
    entry({ call_center: 'INB', amount: 300, cycle_start_date: '2026-10-14', cycle_end_date: '2026-10-27' }),
  ])
  const lines = cycleRowsToCsv(rows).split('\r\n')
  assert.equal(lines[0], ESCROW_EXPORT_HEADERS.join(','))
  assert.equal(lines.length, 4, 'header plus three center-cycle rows')
  assert.ok(lines.some((l) => l.includes('Orbit IQ') && l.includes('8528.55')))
})

/** Split one CSV line, honouring quoted fields. */
function csvFields(line: string): string[] {
  const out: string[] = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i += 1 }
      else if (ch === '"') inQuotes = false
      else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out
}

test('a center name containing a comma cannot split the row', () => {
  const rows = buildCycleRows([entry({ call_center: 'Smith, Jones BPO', amount: 10 })])
  const line = cycleRowsToCsv(rows).split('\r\n')[1]
  assert.ok(line.includes('"Smith, Jones BPO"'), 'the name is quoted')
  // The cycle label carries a comma of its own ("Sep 30 – Oct 13, 2026"), so the
  // row only parses back to the right width when quoting is handled properly.
  const fields = csvFields(line)
  assert.equal(fields.length, ESCROW_EXPORT_HEADERS.length)
  assert.equal(fields[3], 'Smith, Jones BPO')
  assert.equal(fields[2], 'Sep 30 – Oct 13, 2026')
})

test('an empty ledger produces a header and nothing else', () => {
  assert.equal(cycleRowsToCsv([]), ESCROW_EXPORT_HEADERS.join(','))
  assert.deepEqual(buildCycleRows([]), [])
  assert.equal(buildTotals([]).heldNow, 0)
})
