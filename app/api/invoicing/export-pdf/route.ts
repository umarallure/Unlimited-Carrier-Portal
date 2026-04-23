import { NextRequest } from 'next/server'
import puppeteer from 'puppeteer'

type ExportLine = {
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
}

type ExportPayload = {
  callCenter: string
  rangeLabel: string
  fileName: string
  salesLines: ExportLine[]
  chargebackLines: ExportLine[]
  newBusinessTotal: number
  chargebacksTotal: number
  previousNegativeBalance: number
  balanceDue: number
}

function esc(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function renderRows(lines: ExportLine[]): string {
  if (!lines.length) return '<tr><td colspan="9">No rows in this section.</td></tr>'
  return lines
    .map(
      (line) => `<tr>
        <td>${esc(line.insuredName)}</td>
        <td style="text-align:right;">${fmtMoney(line.leadValue)}</td>
        <td>${esc(line.carrier)}</td>
        <td>${esc(line.product || '—')}</td>
        <td>${esc(line.agentAccount)}</td>
        <td>${esc(line.draftDate)}</td>
        <td style="text-align:right;">${line.monthlyPremium != null ? fmtMoney(line.monthlyPremium) : '—'}</td>
        <td style="text-align:right;">${line.coverageAmount != null ? fmtMoney(line.coverageAmount) : '—'}</td>
        <td style="text-align:right;">${esc(line.comPct ?? '—')}</td>
        <td>${esc(line.comType)}</td>
      </tr>`,
    )
    .join('')
}

function renderHtml(p: ExportPayload): string {
  const prevNegativeBalance = Math.abs(p.previousNegativeBalance || 0)
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(p.fileName)}</title>
  <style>
    :root {
      --bg: #020922;
      --panel: #071638;
      --text: #e5ecff;
      --muted: #9fb2de;
      --line: #1f376f;
      --sales: #00c2b2;
      --chargebacks: #ff5a1f;
      --summary: #2f3f76;
    }
    body {
      font-family: Arial, sans-serif;
      margin: 18px;
      color: var(--text);
      background: var(--bg);
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
    table { width: 100%; border-collapse: collapse; font-size: 11px; margin-bottom: 10px; }
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
  </style>
</head>
<body>
  <div class="header-wrap">
    <h1>${esc(p.callCenter)}</h1>
    <div class="sub">${esc(p.rangeLabel)}</div>
  </div>

  <div class="section-title sales">Sales</div>
  <table>
    <thead>
      <tr>
        <th>Sales</th>
        <th style="text-align:right;">Lead value (50%)</th>
        <th>Carrier</th>
        <th>Product Type</th>
        <th>Agent Account</th>
        <th>Draft Date</th>
        <th style="text-align:right;">Monthly Premium</th>
        <th style="text-align:right;">Coverage Amount</th>
        <th style="text-align:right;">Com %</th>
        <th>Com Type</th>
      </tr>
    </thead>
    <tbody>${renderRows(p.salesLines)}</tbody>
  </table>

  <div class="section-title chargebacks">Chargebacks</div>
  <table>
    <thead>
      <tr>
        <th>Chargebacks</th>
        <th style="text-align:right;">Lead value (50%)</th>
        <th>Carrier</th>
        <th>Product Type</th>
        <th>Agent Account</th>
        <th>Draft Date</th>
        <th style="text-align:right;">Monthly Premium</th>
        <th style="text-align:right;">Coverage Amount</th>
        <th style="text-align:right;">Com %</th>
        <th>Com Type</th>
      </tr>
    </thead>
    <tbody>${renderRows(p.chargebackLines)}</tbody>
  </table>

  <table class="summary">
    <tbody>
      <tr><td>New Business Total</td><td style="text-align:right;">${fmtMoney(p.newBusinessTotal)}</td></tr>
      <tr><td>Chargebacks Total</td><td style="text-align:right;">${fmtMoney(p.chargebacksTotal)}</td></tr>
      <tr><td>Negative Balance From Last Week</td><td style="text-align:right;">-${fmtMoney(prevNegativeBalance)}</td></tr>
      <tr><td>Balance Due</td><td style="text-align:right;">${fmtMoney(p.balanceDue)}</td></tr>
    </tbody>
  </table>
</body>
</html>`
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as ExportPayload
    const html = renderHtml(payload)
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', right: '10mm', bottom: '12mm', left: '10mm' } })
      const pdfBody = Uint8Array.from(pdf)
      return new Response(pdfBody, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${payload.fileName}"`,
        },
      })
    } finally {
      await browser.close()
    }
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Failed to export PDF' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

