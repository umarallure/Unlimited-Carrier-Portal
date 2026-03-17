import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Minimal Corebridge commission PDF ingestion:
// - Uses pdf-parse to extract text from the PDF.
// - Derives a single statement_date from "AS OF <Month> <DD>, <YYYY>".
// - Inserts one row into corebridge_commissions for each policy line.
//
// NOTE: Install pdf-parse in this project:
//   npm install pdf-parse

export async function POST(req: NextRequest) {
  try {
    const { fileId, agencyCarrierId, carrierCode, storagePath } = await req.json()

    if (!fileId || !agencyCarrierId || !carrierCode || !storagePath) {
      return NextResponse.json({ error: 'Missing required parameters.' }, { status: 400 })
    }

    if (carrierCode !== 'COREBRIDGE') {
      return NextResponse.json({ error: 'Only COREBRIDGE commission PDFs are supported here.' }, { status: 400 })
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    if (!url || !key) {
      return NextResponse.json(
        { error: 'Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.' },
        { status: 500 }
      )
    }

    const supabase = createClient(url, key)

    // Download the PDF from storage
    const { data, error } = await supabase.storage.from('uic-documents').download(storagePath)
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Failed to download PDF from storage.' }, { status: 500 })
    }

    const arrayBuffer = await data.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    // Load pdf-parse in a way that works for both CJS and ESM builds.
    const pdfParseModule: any = await import('pdf-parse')
    const pdfParseFn =
      typeof pdfParseModule === 'function'
        ? pdfParseModule
        : typeof pdfParseModule.default === 'function'
          ? pdfParseModule.default
          : null

    if (!pdfParseFn) {
      console.error('[Corebridge PDF] pdf-parse did not export a function. Got:', pdfParseModule)
      return NextResponse.json({ error: 'pdf-parse module not available on server.' }, { status: 500 })
    }

    const parsed = await pdfParseFn(buffer)
    const text: string = parsed.text || ''

    if (!text.trim()) {
      console.warn('[Corebridge PDF] No text extracted from PDF:', storagePath)
      return NextResponse.json({ rowsInserted: 0 })
    }

    // 1) Extract statement date from header: "AS OF FEBRUARY 06, 2026"
    let statementDate: string | null = null
    const asOfMatch = text.match(/AS OF\s+([A-Z]+)\s+(\d{2}),\s+(\d{4})/i)
    if (asOfMatch) {
      const [, monthName, dayStr, yearStr] = asOfMatch
      const monthMap: Record<string, string> = {
        JANUARY: '01',
        FEBRUARY: '02',
        MARCH: '03',
        APRIL: '04',
        MAY: '05',
        JUNE: '06',
        JULY: '07',
        AUGUST: '08',
        SEPTEMBER: '09',
        OCTOBER: '10',
        NOVEMBER: '11',
        DECEMBER: '12',
      }
      const mm = monthMap[monthName.toUpperCase()]
      if (mm) {
        statementDate = `${yearStr}-${mm}-${dayStr}`
      }
    }

    // 2) Scan lines for policy-level commission rows.
    const lines = text.split(/\r?\n/)
    const rows: any[] = []
    let rowNumber = 0

    const parseMoney = (s: string | undefined): number | null => {
      if (!s) return null
      const raw = s.trim()
      const isParenNegative = /^\(.*\)$/.test(raw)
      const cleaned = raw.replace(/[()$,]/g, '').trim()
      if (!cleaned) return null
      const n = Number(cleaned)
      if (Number.isNaN(n)) return null
      return isParenNegative ? -n : n
    }

    const parsePct = (s: string | undefined): number | null => {
      if (!s) return null
      const cleaned = s.replace(/[%(),]/g, '').trim()
      if (!cleaned) return null
      const n = Number(cleaned)
      return Number.isNaN(n) ? null : n
    }

    const parseDateMMDDYY = (s: string | undefined): string | null => {
      if (!s) return null
      const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/)
      if (!m) return null
      const [, mm, dd, yy] = m
      const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`
      return `${year}-${mm}-${dd}`
    }

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      if (line.toUpperCase().startsWith('SUB TOTAL')) continue
      if (line.toUpperCase().startsWith('TOTAL')) continue

      // Typical row begins with: "AGL 6250123368 DUCKNEY 07/04/25 18AG5 GENERICATTAE ..."
      const head = line.match(/^([A-Z]{2,4})\s+([0-9]{7,})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{2})\s+(.*)$/)
      if (!head) continue

      const [, coName, policyNumber, insuredRaw, issueDateRaw, tailRaw] = head
      if (!policyNumber) continue

      // Capture trailing monetary amounts (end of row)
      const moneyMatches = tailRaw.match(/-?\$[\d,]+\.\d{2}|\(\$[\d,]+\.\d{2}\)/g) || []
      const commissionAmount = moneyMatches.length >= 1 ? parseMoney(moneyMatches[moneyMatches.length - 1]) : null
      const advanceBalance = moneyMatches.length >= 2 ? parseMoney(moneyMatches[moneyMatches.length - 2]) : null

      // Capture trailing percent values (before money columns in most layouts)
      const pctMatches = tailRaw.match(/-?\d+(?:\.\d+)?%/g) || []
      const commPct = pctMatches.length >= 1 ? parsePct(pctMatches[pctMatches.length - 1]) : null
      const annualCommRate = pctMatches.length >= 2 ? parsePct(pctMatches[pctMatches.length - 2]) : null
      const splitPct = pctMatches.length >= 3 ? parsePct(pctMatches[pctMatches.length - 3]) : null

      // Strip money + percent chunks out of tail, then split remaining tokens.
      let tail = tailRaw
      for (const m of moneyMatches) tail = tail.replace(m, ' ')
      for (const p of pctMatches) tail = tail.replace(p, ' ')
      tail = tail.replace(/\s+/g, ' ').trim()
      const tokens = tail.split(' ').filter(Boolean)

      const agentCode = tokens[0] ?? null
      const bgaCode = tokens[1] ?? null
      const commType = tokens[2] ?? null

      // Remaining may include annual_premium, premium, split_premium (often look like $ / 0.00)
      const remainingMoney = tokens.slice(3).join(' ').match(/-?\$?[\d,]+\.\d{2}|\(\$[\d,]+\.\d{2}\)/g) || []
      const annualPremium = remainingMoney.length >= 1 ? parseMoney(remainingMoney[0]) : null
      const premium = remainingMoney.length >= 2 ? parseMoney(remainingMoney[1]) : null
      const splitPremium = remainingMoney.length >= 3 ? parseMoney(remainingMoney[2]) : null

      rowNumber += 1
      rows.push({
        agency_carrier_id: agencyCarrierId,
        file_id: fileId,
        row_number: rowNumber,
        policy_number: policyNumber,
        statement_date: statementDate,
        co_name: coName,
        insured_name: insuredRaw?.trim() || null,
        issue_date: parseDateMMDDYY(issueDateRaw),
        agent_code: agentCode,
        bga_code: bgaCode,
        comm_type: commType,
        annual_premium: annualPremium,
        premium,
        split_pct: splitPct,
        split_premium: splitPremium,
        annual_comm_rate: annualCommRate,
        comm_pct: commPct,
        advance_balance: advanceBalance,
        commission_amount: commissionAmount,
        source_file: storagePath,
        source_format: 'COREBRIDGE_COMMISSION_PDF',
      })
    }

    if (!rows.length) {
      console.warn('[Corebridge PDF] No policy rows detected for file:', storagePath)
      return NextResponse.json({ rowsInserted: 0 })
    }

    // Deduplicate by (agency_carrier_id, policy_number) so ON CONFLICT never
    // tries to update the same row twice in one statement.
    const byKey = new Map<string, any>()
    for (const r of rows) {
      const key = `${r.agency_carrier_id}::${r.policy_number}`
      byKey.set(key, r)
    }
    const dedupedRows = Array.from(byKey.values())

    const { error: insertError } = await supabase
      .from('corebridge_commissions')
      .upsert(dedupedRows, {
        // Match the unique index on (agency_carrier_id, policy_number)
        onConflict: 'agency_carrier_id,policy_number',
        ignoreDuplicates: false,
      })

    if (insertError) {
      console.error('[Corebridge PDF] Insert error:', insertError.message)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    console.log('[Corebridge PDF] Inserted corebridge_commissions rows:', dedupedRows.length)
    return NextResponse.json({ rowsInserted: dedupedRows.length })
  } catch (e: any) {
    console.error('[Corebridge PDF] Error handling request:', e)
    return NextResponse.json({ error: 'Failed to parse Corebridge commission PDF.' }, { status: 500 })
  }
}

