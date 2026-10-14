import test from 'node:test'
import assert from 'node:assert/strict'

import {
  escapeHtml,
  formatPdfMoney,
  renderInvoicePdfHtml,
  type InvoicePdfLine,
  type InvoicePdfPayload,
} from './invoicePdfHtml'

function line(partial: Partial<InvoicePdfLine> = {}): InvoicePdfLine {
  return {
    insuredName: 'Jane Doe',
    leadValue: 500,
    carrier: 'Aetna',
    product: 'Final Exp',
    agentAccount: 'Isaac Reed',
    draftDate: '3/4/2026',
    monthlyPremium: 61.2,
    coverageAmount: 10000,
    comPct: '137%',
    comType: 'Advance',
    commissionDate: null,
    ...partial,
  }
}

function payload(partial: Partial<InvoicePdfPayload> = {}): InvoicePdfPayload {
  return {
    callCenter: 'Connect X',
    rangeLabel: 'Sep 30 – Oct 13, 2026',
    fileName: 'ConnectX.pdf',
    salesLines: [line()],
    chargebackLines: [],
    newBusinessTotal: 7595.11,
    chargebacksTotal: 0,
    previousNegativeBalance: 0,
    balanceDue: 8545.27,
    ...partial,
  }
}

const ESCROW = {
  dealsToEscrow: 950.16,
  dealsExcessToPayout: 0,
  hold: 1519.02,
  holdRatePct: 20,
  negativeBalanceApplied: 0,
  payoutAfterEscrow: 6076.09,
  balanceAfter: 2469.18,
  cap: 10000,
  dealLines: [
    line({ insuredName: 'Paul Genereau', leadValue: 590.79, commissionDate: '2026-09-24' }),
    line({ insuredName: 'Ginger Church', leadValue: 359.37, commissionDate: '2026-09-26' }),
  ],
}

/** Column count of a <tr>, counting a colspan as the number of columns it covers. */
function cellsInRow(row: string): number {
  let total = 0
  for (const cell of row.match(/<t[dh][^>]*>/g) ?? []) {
    const span = cell.match(/colspan="(\d+)"/)
    total += span ? Number(span[1]) : 1
  }
  return total
}

function rowsOf(html: string): string[] {
  return html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []
}

// ───────────────────────── the drift this module exists to stop ─────────────────────────

test('every row in a table has the same number of columns as its header', () => {
  // The three old copies of this layout disagreed: one printed a nine-column
  // empty state into a ten-column table.
  for (const p of [payload(), payload({ salesLines: [], chargebackLines: [] })]) {
    const tables = renderInvoicePdfHtml(p).match(/<table>[\s\S]*?<\/table>/g) ?? []
    assert.ok(tables.length >= 2, 'expected the Sales and Chargebacks tables')
    for (const table of tables) {
      const rows = rowsOf(table)
      const widths = new Set(rows.map(cellsInRow))
      assert.equal(widths.size, 1, `ragged table, widths ${[...widths].join('/')}`)
    }
  }
})

test('an empty section says so rather than rendering nothing', () => {
  const html = renderInvoicePdfHtml(payload({ salesLines: [], chargebackLines: [] }))
  assert.equal((html.match(/No rows in this section\./g) ?? []).length, 2)
})

// ───────────────────────────── the two variants ─────────────────────────────

test('without escrow the document is the invoice as it has always been', () => {
  const html = renderInvoicePdfHtml(payload())
  assert.ok(html.includes('>Sales<'))
  assert.ok(html.includes('>Chargebacks<'))
  assert.ok(html.includes('Balance Due'))
  assert.ok(!html.includes('Escrow'), 'no escrow wording when there is no escrow')
  assert.ok(!html.includes('Holdback'))
})

test('the center-facing copy says Holdback and never shows the balance or cap', () => {
  const html = renderInvoicePdfHtml(payload({ variant: 'holdback', escrow: ESCROW }))
  assert.ok(html.includes('Holdback (20%)'))
  assert.ok(html.includes('Payout After Holdback'))
  assert.ok(!html.includes('Escrow Balance After This Invoice'))
  assert.ok(!html.includes('>Cap<'))
  // The deals themselves are still listed, so the deduction can be checked.
  assert.ok(html.includes('Paul Genereau'))
  assert.ok(html.includes('2026-09-24'))
})

test('the internal copy adds the escrow box with the balance and the cap', () => {
  const html = renderInvoicePdfHtml(payload({ variant: 'escrow', escrow: ESCROW }))
  assert.ok(html.includes('Escrow Deals'))
  assert.ok(html.includes('Escrow Balance After This Invoice'))
  assert.ok(html.includes(formatPdfMoney(2469.18)))
  assert.ok(html.includes(formatPdfMoney(10000)))
  assert.ok(html.includes('Earlier Deals To Escrow'))
})

test('the Escrow Deals table carries the original commission date column', () => {
  const html = renderInvoicePdfHtml(payload({ variant: 'escrow', escrow: ESCROW }))
  assert.ok(html.includes('Commission Received'))
  assert.ok(html.includes('2026-09-26'))
  // And it stays rectangular despite the extra column.
  const escrowTable = (html.match(/<div class="section-title escrow">[\s\S]*?<\/table>/) ?? [''])[0]
  const widths = new Set(rowsOf(escrowTable).map(cellsInRow))
  assert.equal(widths.size, 1, `ragged escrow table, widths ${[...widths].join('/')}`)
})

test('no escrow section when the center has no earlier unpaid deals', () => {
  const html = renderInvoicePdfHtml(payload({ variant: 'escrow', escrow: { ...ESCROW, dealLines: [] } }))
  assert.ok(!html.includes('section-title escrow'))
  // The holdback still appears in the totals — it is the deals table that is absent.
  assert.ok(html.includes('Holdback (20%)'))
})

test('cap overflow is shown as paid now rather than silently dropped', () => {
  const html = renderInvoicePdfHtml(
    payload({ variant: 'escrow', escrow: { ...ESCROW, dealsExcessToPayout: 4000 } })
  )
  assert.ok(html.includes('Over The Cap, Paid Now'))
  assert.ok(html.includes(formatPdfMoney(4000)))
})

// ───────────────────────────────── escaping ─────────────────────────────────

test('names and carriers are escaped, so a quote cannot break the document', () => {
  const html = renderInvoicePdfHtml(
    payload({ callCenter: 'A & B "BPO"', salesLines: [line({ insuredName: "O'Brien <script>" })] })
  )
  assert.ok(html.includes('A &amp; B &quot;BPO&quot;'))
  assert.ok(html.includes('O&#39;Brien &lt;script&gt;'))
  assert.ok(!html.includes('<script>'))
})

test('escapeHtml and formatPdfMoney behave', () => {
  assert.equal(escapeHtml('a<b>&"c"'), 'a&lt;b&gt;&amp;&quot;c&quot;')
  assert.equal(formatPdfMoney(1234.5), '$1,234.50')
  // Kept as it has always printed on these invoices: the sign goes inside, after
  // the dollar. Changing it would change every invoice already issued.
  assert.equal(formatPdfMoney(-646.4), '$-646.40')
  assert.equal(formatPdfMoney(Number.NaN), '$0.00')
})
