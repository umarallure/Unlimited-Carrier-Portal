import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Americo commission PDF ingestion (portal.americoagent.com "Commission Statement",
// downloaded via browser Print-to-PDF since the site's own "Export to PDF" button
// errors out client-side).
//
// Each policy prints as TWO rows under a per-agent group:
//   ADVNCE9 row - the actual new advance paid this period (annualized premium x
//                 rate x 9/12). Sums to the statement's own
//                 "AMOUNT PAID TO AGENT VIA EFT" total - confirmed against a real
//                 statement, not assumed.
//   PAID1 row   - an earned/offset entry against the outstanding advance balance
//                 (modal premium x rate). Not new cash paid this period.
// Both are stored for record-keeping; Deal Tracker uses ADVNCE9 rows only for
// deal_value (see lib/dealTracker.americo.ts).
//
// Example source line (as extracted by pdf-parse):
//   AM03545642 SHIROMA 66 080526 ES4130 080926 0807 ADVNCE9 01 UTR 12 679.08 IA-NA .75000 100 381.98 - A 381.98
//   AM03545642 SHIROMA 66 080526 ES4130 080926 0809 PAID1   01 UTR 12  56.59 AO-NA .75000 100  42.44   A

export async function POST(req: NextRequest) {
  try {
    const { fileId, agencyCarrierId, carrierCode, storagePath, deferWrite } = await req.json()

    if (!fileId || !agencyCarrierId || !carrierCode || !storagePath) {
      return NextResponse.json({ error: 'Missing required parameters.' }, { status: 400 })
    }

    if (carrierCode !== 'AMERICO') {
      return NextResponse.json({ error: 'Only AMERICO commission PDFs are supported here.' }, { status: 400 })
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

    const { data, error } = await supabase.storage.from('uic-documents').download(storagePath)
    if (error || !data) {
      return NextResponse.json({ error: error?.message || 'Failed to download PDF from storage.' }, { status: 500 })
    }

    const arrayBuffer = await data.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const pdfParseModule: any = await import('pdf-parse')
    const pdfParseFn =
      typeof pdfParseModule === 'function'
        ? pdfParseModule
        : typeof pdfParseModule.default === 'function'
          ? pdfParseModule.default
          : null

    if (!pdfParseFn) {
      console.error('[Americo PDF] pdf-parse did not export a function. Got:', pdfParseModule)
      return NextResponse.json({ error: 'pdf-parse module not available on server.' }, { status: 500 })
    }

    const parsed = await pdfParseFn(buffer)
    const text: string = parsed.text || ''

    if (!text.trim()) {
      console.warn('[Americo PDF] No text extracted from PDF:', storagePath)
      return NextResponse.json({ rowsInserted: 0 })
    }

    let statementDate: string | null = null
    const statementMatch = text.match(/Commission Report as of\s*(\d{2})\/(\d{2})\/(\d{4})/i)
    if (statementMatch) {
      const [, mm, dd, yyyy] = statementMatch
      statementDate = `${yyyy}-${mm}-${dd}`
    }

    const parseMoney = (s: string | undefined | null): number | null => {
      if (!s) return null
      const raw = s.trim()
      const isParenNegative = /^\(.*\)$/.test(raw) || /-\s*$/.test(raw)
      const cleaned = raw.replace(/[()$,\-\s]/g, '')
      if (!cleaned) return null
      const n = Number(cleaned)
      if (Number.isNaN(n)) return null
      return isParenNegative ? -n : n
    }

    const parseMmDdYy = (s: string | undefined | null): string | null => {
      if (!s || !/^\d{6}$/.test(s)) return null
      const mm = s.slice(0, 2)
      const dd = s.slice(2, 4)
      const yy = s.slice(4, 6)
      return `20${yy}-${mm}-${dd}`
    }

    // pdf-parse extracts this report with almost NO whitespace between adjacent
    // columns (it's a fixed-width mainframe-style report; visual column gaps in
    // the PDF didn't survive text extraction) - e.g. a real extracted line looks
    // like "AM03545642SHIROMA66080526ES41300809260807ADVNCE901UTR12679.08IA-NA
    // .75000100381.98- A381.98" with zero separators for most fields. A single
    // whitespace-delimited regex cannot parse this; instead we match in two
    // stages:
    //   Stage 1 (headRe): fixed-shape head fields up through the TRX code
    //     (Policy#, Name, Age+EffDate, Plan, TRDT, PRDT, TransType, DU, PRO, LV,
    //     BaseAmount, TrxCode), capturing everything after as one "tail" blob.
    //   Stage 2 (tailRe): the tail blob (e.g. ".75000100381.98- A381.98") is
    //     decoded right-to-left-anchored: Rate has an unambiguous fixed shape
    //     (`\d?\.\d{5}`, e.g. ".75000" or "1.20000") so it anchors the split
    //     between Rate and Split; Split is assumed fixed-width 3 digits (every
    //     row in the one real statement we've parsed uses "100" - revisit this
    //     if a future statement shows a different split % with a different
    //     digit count); Amt/Acct/PrimaryBalance follow with the "- A" vs "A"
    //     (ADVNCE9 vs PAID1) difference handled by making the dash and Primary
    //     Balance optional.
    const headRe =
      /^([A-Z]{2}\d{6,10})([A-Z]+)(\d{1,2})(\d{6})([A-Z]{1,2}\d{2,4})(\d{6})(\d{3,4})([A-Z]+\d)(\d{2})([A-Z]{2,4})(\d{1,2})([\d,]+\.\d{2})([A-Z]{1,2}-[A-Z]{2})\s*(.+)$/
    const tailRe = /^(\d?\.\d{5})(\d{3})([\d,]+\.\d{2})-?\s*([A-Z])\s*([\d,]+\.\d{2})?$/

    // Per-agent subtotal/group header row, e.g. "MML03TFLINCHUM BRANDON      2,084.161,335.36-..."
    // (agent code and name are glued together with no separator, same as the
    // data rows; a wider run of spaces separates the name from the totals).
    const agentGroupRe = /^\s*([A-Z]{2,4}\d{1,3}[A-Z]?)([A-Z][A-Z\s]*?)\s{2,}[\d,]+\.\d{2}/

    const lines = text.split(/\r?\n/)
    const rows: any[] = []
    let rowNumber = 0
    let currentAgentNumber: string | null = null
    let currentAgentName: string | null = null

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      const headMatch = line.match(headRe)
      const tailMatch = headMatch ? headMatch[14].match(tailRe) : null
      if (headMatch && tailMatch) {
        const [
          ,
          policyNumber,
          nameDesc,
          issueAge,
          effDate,
          plan,
          trdt,
          prdt,
          transactionType,
          du,
          pro,
          lv,
          baseAmount,
          trxCode,
        ] = headMatch
        const [, rate, split, amt, , primaryBalance] = tailMatch

        rowNumber += 1
        rows.push({
          agency_carrier_id: agencyCarrierId,
          file_id: fileId,
          row_number: rowNumber,
          policy_number: policyNumber,
          name_desc: nameDesc.trim(),
          issue_age: Number(issueAge),
          eff_date: parseMmDdYy(effDate),
          plan,
          transaction_date: parseMmDdYy(trdt),
          process_date: prdt,
          transaction_type: transactionType,
          du,
          pro,
          lv,
          base_amount: parseMoney(baseAmount),
          trx_code: trxCode,
          rate: Number(rate),
          split_pct: Number(split),
          amt: parseMoney(amt),
          primary_balance: parseMoney(primaryBalance),
          agent_number: currentAgentNumber,
          agent_name: currentAgentName,
          statement_date: statementDate,
          source_file: storagePath,
          source_format: 'AMERICO_COMMISSION_PDF',
        })
        continue
      }

      // Not a data row - check if it's a new agent group header (updates context
      // for subsequent data rows) before moving on.
      const groupMatch = line.match(agentGroupRe)
      if (groupMatch) {
        currentAgentNumber = groupMatch[1]
        currentAgentName = groupMatch[2].trim()
      }
    }

    if (!rows.length) {
      console.warn('[Americo PDF] No policy rows detected for file:', storagePath)
      return NextResponse.json({ rowsInserted: 0, rows: [] })
    }

    if (deferWrite === true) {
      console.log('[Americo PDF] deferWrite: returning rows without DB insert')
      return NextResponse.json({
        rowsInserted: 0,
        rows,
        deferred: true,
      })
    }

    console.log('[Americo PDF] Parse stats:', { totalRows: rows.length })

    const { error: insertError } = await supabase.from('americo_commissions').insert(rows)

    if (insertError) {
      console.error('[Americo PDF] Insert error:', insertError.message)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    console.log('[Americo PDF] Inserted americo_commissions rows:', rows.length)
    return NextResponse.json({ rowsInserted: rows.length })
  } catch (e: any) {
    console.error('[Americo PDF] Error handling request:', e)
    return NextResponse.json({ error: 'Failed to parse Americo commission PDF.' }, { status: 500 })
  }
}
