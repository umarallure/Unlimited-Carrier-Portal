import { NextRequest } from 'next/server'
import puppeteer from 'puppeteer'

import { renderInvoicePdfHtml, type InvoicePdfPayload } from '@/lib/invoicePdfHtml'

// The layout lives in lib/invoicePdfHtml.ts so this route, the client-side
// fallback on the invoicing page and the merged-slab preview all print the same
// document. They used to be three near-copies and had already drifted.

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as InvoicePdfPayload
    const html = renderInvoicePdfHtml(payload)
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    try {
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle0' })
      const pdf = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '8mm', right: '8mm', bottom: '8mm', left: '8mm' },
      })
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
