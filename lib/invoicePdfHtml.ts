/**
 * The BPO invoice PDF, as one HTML document.
 *
 * This layout used to exist in three near-copies — the puppeteer route, the
 * client-side fallback the invoice page opens when that route fails, and the
 * merged-slab preview — and they had already drifted apart (one printed a
 * ten-column empty state into a nine-column table). Adding the escrow section
 * to three copies would have been the likeliest way for this work to go wrong,
 * so they all call this now.
 *
 * Pure: no imports, no DOM, no Supabase. The caller passes a plain payload, so
 * the same function runs on the server under puppeteer and in the browser.
 */

export type InvoicePdfLine = {
  insuredName: string
  leadValue: number
  carrier: string
  product: string | null
  agentAccount: string
  draftDate: string
  monthlyPremium: number | null
  coverageAmount: number | null
  comPct: string | null
  comType: string
  /** Shown in the Escrow Deals section; the date the carrier actually paid. */
  commissionDate?: string | null
}

export type InvoicePdfEscrow = {
  /** Earlier unpaid commissions moving into escrow this cycle. */
  dealsToEscrow: number
  /** Any part of those over the cap, which is paid now instead. */
  dealsExcessToPayout: number
  hold: number
  holdRatePct: number
  negativeBalanceApplied: number
  payoutAfterEscrow: number
  balanceAfter: number
  cap: number
  /** The earlier unpaid deals themselves, for the Escrow Deals table. */
  dealLines: InvoicePdfLine[]
}

export type InvoicePdfPayload = {
  callCenter: string
  rangeLabel: string
  fileName: string
  salesLines: InvoicePdfLine[]
  chargebackLines: InvoicePdfLine[]
  newBusinessTotal: number
  chargebacksTotal: number
  previousNegativeBalance: number
  balanceDue: number
  /**
   * 'holdback' is the center-facing invoice: the deduction is named Holdback and
   * the escrow balance and cap are not shown. 'escrow' is the internal view with
   * the full box. Omit `escrow` entirely and neither is printed.
   */
  variant?: 'holdback' | 'escrow'
  escrow?: InvoicePdfEscrow | null
}

const COLUMNS = [
  'Lead value (50%)',
  'Carrier',
  'Product Type',
  'Agent Account',
  'Draft Date',
  'Monthly Premium',
  'Coverage Amount',
  'Com %',
  'Com Type',
]
/** First column is the section's own label, so the count is COLUMNS + 1. */
const COLUMN_COUNT = COLUMNS.length + 1

export function escapeHtml(value: string): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function formatPdfMoney(value: number): string {
  const n = Number.isFinite(value) ? value : 0
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function renderRows(lines: InvoicePdfLine[], extraCell?: (line: InvoicePdfLine) => string): string {
  const span = COLUMN_COUNT + (extraCell ? 1 : 0)
  if (!lines.length) return `<tr><td colspan="${span}">No rows in this section.</td></tr>`
  return lines
    .map(
      (line) => `<tr>
        <td>${escapeHtml(line.insuredName)}</td>
        ${extraCell ? extraCell(line) : ''}
        <td style="text-align:right;">${formatPdfMoney(line.leadValue)}</td>
        <td>${escapeHtml(line.carrier)}</td>
        <td>${escapeHtml(line.product || '—')}</td>
        <td>${escapeHtml(line.agentAccount)}</td>
        <td>${escapeHtml(line.draftDate)}</td>
        <td style="text-align:right;">${line.monthlyPremium != null ? formatPdfMoney(line.monthlyPremium) : '—'}</td>
        <td style="text-align:right;">${line.coverageAmount != null ? formatPdfMoney(line.coverageAmount) : '—'}</td>
        <td style="text-align:right;">${escapeHtml(line.comPct ?? '—')}</td>
        <td>${escapeHtml(line.comType)}</td>
      </tr>`,
    )
    .join('')
}

function renderHead(label: string, extraHeader?: string): string {
  return `<thead>
      <tr>
        <th>${escapeHtml(label)}</th>
        ${extraHeader ? `<th>${escapeHtml(extraHeader)}</th>` : ''}
        ${COLUMNS.map((c) => `<th${c === 'Carrier' || c === 'Product Type' || c === 'Agent Account' || c === 'Draft Date' || c === 'Com Type' ? '' : ' style="text-align:right;"'}>${escapeHtml(c)}</th>`).join('')}
      </tr>
    </thead>`
}

function renderSection(kind: 'sales' | 'chargebacks' | 'escrow', label: string, lines: InvoicePdfLine[], extraHeader?: string): string {
  const extraCell =
    extraHeader != null
      ? (line: InvoicePdfLine) => `<td>${escapeHtml(line.commissionDate || '—')}</td>`
      : undefined
  return `  <div class="section-title ${kind}">${escapeHtml(label)}</div>
  <table>
    ${renderHead(label, extraHeader)}
    <tbody>${renderRows(lines, extraCell)}</tbody>
  </table>`
}

function renderSummary(p: InvoicePdfPayload): string {
  const prevNegativeBalance = Math.abs(p.previousNegativeBalance || 0)
  const rows: string[] = [
    `<tr><td>New Business Total</td><td style="text-align:right;">${formatPdfMoney(p.newBusinessTotal)}</td></tr>`,
    `<tr><td>Chargebacks Total</td><td style="text-align:right;">${formatPdfMoney(p.chargebacksTotal)}</td></tr>`,
    `<tr><td>Negative Balance From Last Week</td><td style="text-align:right;">-${formatPdfMoney(prevNegativeBalance)}</td></tr>`,
    `<tr><td>Balance Due</td><td style="text-align:right;">${formatPdfMoney(p.balanceDue)}</td></tr>`,
  ]

  const e = p.escrow
  if (e) {
    if (e.dealsToEscrow > 0) {
      rows.push(
        `<tr><td>${p.variant === 'escrow' ? 'Earlier Deals To Escrow' : 'Earlier Deals Held'}</td>` +
          `<td style="text-align:right;">-${formatPdfMoney(e.dealsToEscrow)}</td></tr>`,
      )
    }
    rows.push(
      `<tr><td>Holdback (${Math.round(e.holdRatePct)}%)</td>` +
        `<td style="text-align:right;">-${formatPdfMoney(e.hold)}</td></tr>`,
    )
    rows.push(
      `<tr><td>Payout After Holdback</td><td style="text-align:right;">${formatPdfMoney(e.payoutAfterEscrow)}</td></tr>`,
    )
  }

  return `  <table class="summary">
    <tbody>
      ${rows.join('\n      ')}
    </tbody>
  </table>`
}

function renderEscrowBox(p: InvoicePdfPayload): string {
  const e = p.escrow
  // The center-facing invoice names the deduction "Holdback" and never shows the
  // balance or the cap; only the internal copy carries the box.
  if (!e || p.variant !== 'escrow') return ''
  return `  <table class="summary escrow-box">
    <tbody>
      <tr><td>Escrow Deals This Cycle</td><td style="text-align:right;">${formatPdfMoney(e.dealsToEscrow)}</td></tr>
      ${e.dealsExcessToPayout > 0 ? `<tr><td>Over The Cap, Paid Now</td><td style="text-align:right;">${formatPdfMoney(e.dealsExcessToPayout)}</td></tr>` : ''}
      <tr><td>Holdback This Cycle</td><td style="text-align:right;">${formatPdfMoney(e.hold)}</td></tr>
      <tr><td>Escrow Balance After This Invoice</td><td style="text-align:right;">${formatPdfMoney(e.balanceAfter)}</td></tr>
      <tr><td>Cap</td><td style="text-align:right;">${formatPdfMoney(e.cap)}</td></tr>
    </tbody>
  </table>`
}

export function renderInvoicePdfHtml(p: InvoicePdfPayload): string {
  const escrowSection =
    p.escrow && p.escrow.dealLines.length > 0
      ? renderSection('escrow', 'Escrow Deals', p.escrow.dealLines, 'Commission Received')
      : ''

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(p.fileName)}</title>
  <style>
    :root {
      --bg: #020922;
      --panel: #071638;
      --text: #e5ecff;
      --muted: #9fb2de;
      --line: #1f376f;
      --sales: #00c2b2;
      --chargebacks: #ff5a1f;
      --escrow: #c89b2a;
      --summary: #2f3f76;
    }
    body {
      font-family: Arial, sans-serif;
      margin: 18px;
      color: var(--text);
      background: var(--bg);
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header-wrap {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px 16px;
      background: linear-gradient(180deg, #071c47 0%, #051433 100%);
    }
    h1 { margin: 0; font-size: 20px; color: #ffffff; }
    .sub { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
    .section-title {
      margin: 16px 0 0;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      padding: 7px 10px;
      border-radius: 6px 6px 0 0;
    }
    .section-title.sales { background: var(--sales); }
    .section-title.chargebacks { background: var(--chargebacks); }
    .section-title.escrow { background: var(--escrow); }
    table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; table-layout: fixed; }
    th, td { border: 1px solid var(--line); padding: 6px 7px; text-align: left; }
    thead th {
      background: #0a204f;
      color: #cfe0ff;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    tbody td { background: var(--panel); }
    .summary {
      margin-top: 12px;
      width: 360px;
      margin-left: auto;
      border-collapse: collapse;
    }
    .summary td {
      border: 1px solid var(--line);
      padding: 8px;
      background: var(--panel);
    }
    .summary td:first-child {
      background: var(--summary);
      font-weight: 600;
    }
    .summary.escrow-box td:first-child { background: #6b5415; }
    @page { size: A4 landscape; margin: 8mm; }
    @media print {
      body {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }
  </style>
</head>
<body>
  <div class="header-wrap">
    <h1>${escapeHtml(p.callCenter)}</h1>
    <div class="sub">${escapeHtml(p.rangeLabel)}</div>
  </div>

${renderSection('sales', 'Sales', p.salesLines)}

${renderSection('chargebacks', 'Chargebacks', p.chargebackLines)}
${escrowSection ? `\n${escrowSection}\n` : ''}
${renderSummary(p)}
${renderEscrowBox(p)}
</body>
</html>`
}
