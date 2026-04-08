import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

// Sentinel commission PDF ingestion:
// - Uses pdf-parse to extract text from the PDF.
// - Derives commission_period_start / commission_period_end from header.
// - Inserts one row into sentinel_commissions for each policy line, using Payable Comm as the amount.

export async function POST(req: NextRequest) {
  try {
    const { fileId, agencyCarrierId, carrierCode, storagePath } = await req.json()

    if (!fileId || !agencyCarrierId || !carrierCode || !storagePath) {
      return NextResponse.json({ error: 'Missing required parameters.' }, { status: 400 })
    }

    if (carrierCode !== 'SENTINEL') {
      return NextResponse.json({ error: 'Only SENTINEL commission PDFs are supported here.' }, { status: 400 })
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

    const pdfParseModule: any = await import('pdf-parse')
    const pdfParseFn =
      typeof pdfParseModule === 'function'
        ? pdfParseModule
        : typeof pdfParseModule.default === 'function'
          ? pdfParseModule.default
          : null

    if (!pdfParseFn) {
      console.error('[Sentinel PDF] pdf-parse did not export a function. Got:', pdfParseModule)
      return NextResponse.json({ error: 'pdf-parse module not available on server.' }, { status: 500 })
    }

    const parsed = await pdfParseFn(buffer)
    const text: string = parsed.text || ''

    if (!text.trim()) {
      console.warn('[Sentinel PDF] No text extracted from PDF:', storagePath)
      return NextResponse.json({ rowsInserted: 0 })
    }

    // Extract commission period from header, e.g. "Commission Period: 20260305 - 20260305"
    let commissionPeriodStart: string | null = null
    let commissionPeriodEnd: string | null = null
    const periodMatch = text.match(/Commission Period:\s*(\d{8})\s*-\s*(\d{8})/i)
    if (periodMatch) {
      const [, startRaw, endRaw] = periodMatch
      const fmt = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
      commissionPeriodStart = fmt(startRaw)
      commissionPeriodEnd = fmt(endRaw)
    }

    const lines = text.split(/\r?\n/)
    const rows: any[] = []
    let rowNumber = 0

    // Match monetary amounts even when the dollar sign is missing or wrapped in parentheses (negative).
    // Examples matched: "$58.02", "58.02", "($384.70)"
    const moneyRegex = /\(?\$?\d[\d,]*\.\d{2}\)?/g
    const pctRegex = /\d+(?:\.\d+)?%/g

    const parseMoney = (s: string | undefined | null): number | null => {
      if (!s) return null
      const raw = s.trim()
      const isParenNegative = /^\(.*\)$/.test(raw)
      const cleaned = raw.replace(/[()$,]/g, '').trim()
      if (!cleaned) return null
      const n = Number(cleaned)
      if (Number.isNaN(n)) return null
      return isParenNegative ? -n : n
    }

    const normalizeSentinelPolicyNumber = (value: string | null | undefined): string | null => {
      if (!value) return null
      const raw = String(value).trim()
      if (!raw) return null
      if (/^\d+$/.test(raw) && raw.length === 6) return `0${raw}`
      return raw
    }

    let debugLinesEmitted = 0
    const MAX_DEBUG_LINES = 50

    const parseSentinelTableRow = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return null
      if (trimmed.toUpperCase().startsWith('TOTAL')) return null
      if (/^WRITING\s+AGENT/i.test(trimmed)) return null
      if (/^(LIFE|FIRST YEAR)$/i.test(trimmed)) return null

      // Parse from right side because tail columns are fixed:
      // ... AppSt PlanCode EffMo/Yr MthsPaid PaidToDate PolicyDur CommPremium CommRate PayableComm AppliedToAdvance
      const rowRe =
        /^(.+?)\s+([A-Z]{2})\s+(\S+)\s+(\d{2}\/\d{4})\s+(\d+)\s+(\d{2}\/\d{4})\s+(\d+)\s+(\(?\$?\d[\d,]*\.\d{2}\)?)\s+(?:(\d+(?:\.\d+)?\s*%)\s+)?(\(?\$?\d[\d,]*\.\d{2}\)?)\s+(\(?\$?\d[\d,]*\.\d{2}\)?)$/i
      const m = trimmed.match(rowRe)
      if (!m) {
        // Fallback for variable spacing/wrapped rows from pdf text extraction.
        const moneyMatches = trimmed.match(moneyRegex) || []
        const pctMatches = trimmed.match(pctRegex) || []
        if (moneyMatches.length < 2) return null
        if (!/\b\d{2}\/\d{4}\b/.test(trimmed)) return null

        let head = trimmed
        for (const mm of moneyMatches) head = head.replace(mm, ' ')
        for (const pm of pctMatches) head = head.replace(pm, ' ')
        head = head.replace(/\s+/g, ' ').trim()
        const tokens = head.split(' ').filter(Boolean)
        if (tokens.length < 6) return null
        if (!/^[A-Z]?\d{5,}$/i.test(tokens[0])) return null

        let policyIndex = -1
        for (let i = 1; i < tokens.length; i++) {
          if (/^\d{5,}$/.test(tokens[i])) {
            policyIndex = i
            break
          }
        }
        if (policyIndex < 0) return null

        let stateIndex = -1
        for (let i = policyIndex + 1; i < tokens.length; i++) {
          if (/^[A-Z]{2}$/i.test(tokens[i])) {
            stateIndex = i
            break
          }
        }
        if (stateIndex < 0) return null

        const writingAgentNumber = tokens[0] || null
        const writingAgentName = tokens.slice(1, policyIndex).join(' ') || null
        const policyNumber = normalizeSentinelPolicyNumber(tokens[policyIndex]) || null
        const clientName = tokens.slice(policyIndex + 1, stateIndex).join(' ') || null
        const state = tokens[stateIndex] || null
        const remaining = tokens.slice(stateIndex + 1)
        const planCode = remaining[0] ?? null
        const effMonthYear = remaining[1] ?? null
        const monthsPaid = remaining[2] ? Number(remaining[2]) : null
        const paidToDate = remaining[3] ?? null
        const policyDuration = remaining[4] ? Number(remaining[4]) : null
        const commPremiumStr = moneyMatches.length >= 3 ? moneyMatches[moneyMatches.length - 3] : null
        const commissionRateStr = pctMatches.length > 0 ? pctMatches[pctMatches.length - 1] : null
        const payableCommStr = moneyMatches[moneyMatches.length - 2] || null
        const appliedToAdvanceStr = moneyMatches[moneyMatches.length - 1] || null

        return {
          policyNumber,
          writingAgentNumber,
          writingAgentName,
          clientName,
          state,
          planCode,
          effMonthYear,
          monthsPaid,
          paidToDate,
          policyDuration,
          commPremiumStr,
          commissionRateStr,
          payableCommStr,
          appliedToAdvanceStr,
        }
      }

      const left = m[1].trim()
      // Left side: WritingAgent# WritingAgentName Policy# ClientName
      const leftRe = /^([A-Z]?\d{5,})\s+(.+?)\s+(\d{5,})\s+(.+)$/i
      const lm = left.match(leftRe)
      if (!lm) return null

      const writingAgentNumber = lm[1] || null
      const writingAgentName = lm[2]?.trim() || null
      const policyNumber = normalizeSentinelPolicyNumber(lm[3]) || null
      const clientName = lm[4]?.trim() || null
      const state = m[2] || null
      const planCode = m[3] || null
      const effMonthYear = m[4] || null
      const monthsPaid = m[5] ? Number(m[5]) : null
      const paidToDate = m[6] || null
      const policyDuration = m[7] ? Number(m[7]) : null
      const commPremiumStr = m[8] || null
      const commissionRateStr = m[9] || null
      const payableCommStr = m[10] || null
      const appliedToAdvanceStr = m[11] || null

      return {
        policyNumber,
        writingAgentNumber,
        writingAgentName,
        clientName,
        state,
        planCode,
        effMonthYear,
        monthsPaid,
        paidToDate,
        policyDuration,
        commPremiumStr,
        commissionRateStr,
        payableCommStr,
        appliedToAdvanceStr,
      }
    }

    let prevLine: string | null = null
    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      // Some PDFs split a logical row into two lines (text + money). Try combined then current.
      let parsed =
        prevLine != null ? parseSentinelTableRow(`${prevLine} ${line}`) : null
      if (!parsed) {
        parsed = parseSentinelTableRow(line)
      }

      if (parsed) {
        rowNumber += 1
        rows.push({
          agency_carrier_id: agencyCarrierId,
          file_id: fileId,
          row_number: rowNumber,
          policy_number: parsed.policyNumber,
          writing_agent_number: parsed.writingAgentNumber,
          writing_agent_name: parsed.writingAgentName,
          client_name: parsed.clientName,
          state: parsed.state,
          plan_code: parsed.planCode,
          eff_month_year: parsed.effMonthYear,
          months_paid: Number.isNaN(parsed.monthsPaid as number) ? null : parsed.monthsPaid,
          paid_to_date: parsed.paidToDate,
          policy_duration: Number.isNaN(parsed.policyDuration as number) ? null : parsed.policyDuration,
          commission_premium: parseMoney(parsed.commPremiumStr),
          commission_rate_pct: parsed.commissionRateStr
            ? Number(parsed.commissionRateStr.replace(/[%]/g, ''))
            : null,
          payable_commission: parseMoney(parsed.payableCommStr),
          applied_to_advance: parseMoney(parsed.appliedToAdvanceStr),
          statement_date: commissionPeriodStart,
          commission_period_start: commissionPeriodStart,
          commission_period_end: commissionPeriodEnd,
          source_file: storagePath,
          source_format: 'SENTINEL_COMMISSION_PDF',
        })
        prevLine = null
      } else {
        prevLine = line
      }
    }

    // Fallback: vertical layout where each policy appears as a block.
    // IMPORTANT: parse each block in isolation; never scan tail of whole document.
    if (!rows.length) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.trim() !== 'LIFE') continue
        if ((lines[i + 1] || '').trim() !== 'First Year') continue

        const writingAgentNumber = (lines[i + 2] || '').trim()
        const writingAgentName = (lines[i + 3] || '').trim() || null
        const policyNumber = normalizeSentinelPolicyNumber((lines[i + 4] || '').trim())
        const possibleClient = (lines[i + 5] || '').trim()
        const possibleState = (lines[i + 6] || '').trim()

        if (!writingAgentNumber || !policyNumber) continue

        // Heuristic: state is 2-letter code; if the next line isn't, assume client name spans more lines.
        let state = possibleState
        let clientName = possibleClient
        let cursor = i + 7
        if (!/^[A-Z]{2}$/.test(possibleState)) {
          clientName = [possibleClient, possibleState].filter(Boolean).join(' ')
          state = (lines[i + 7] || '').trim()
          cursor = i + 8
        }
        if (!/^[A-Z]{2}$/.test(state)) continue

        const planCode = (lines[cursor++] || '').trim() || null
        const effMonthYear = (lines[cursor++] || '').trim() || null
        const monthsPaidStr = (lines[cursor++] || '').trim()
        const paidToDate = (lines[cursor++] || '').trim() || null
        const policyDurationStr = (lines[cursor++] || '').trim()

        // Determine the end of this block (before next LIFE/First Year or TOTAL).
        let blockEnd = lines.length
        for (let j = cursor; j < lines.length; j++) {
          const cur = (lines[j] || '').trim()
          const next = (lines[j + 1] || '').trim()
          if (cur === 'LIFE' && next === 'First Year') {
            blockEnd = j
            break
          }
          if (/^TOTAL\b/i.test(cur)) {
            blockEnd = j
            break
          }
        }

        const blockText = lines.slice(cursor, blockEnd).join(' ')
        const tailMoney = blockText.match(moneyRegex) || []
        const tailPct = blockText.match(pctRegex) || []

        let commissionPremiumStr: string | undefined
        let commissionRatePctStr: string | undefined
        let payableCommStr: string | undefined
        let appliedToAdvanceStr: string | undefined

        // Map money strings → numeric values so we can choose by magnitude.
        const moneyWithVals = tailMoney
          .map(raw => ({ raw, val: parseMoney(raw) }))
          .filter(m => typeof m.val === 'number' && !Number.isNaN(m.val as number)) as {
            raw: string
            val: number
          }[]

        const positiveMoney = moneyWithVals.filter(m => m.val > 0)

        if (moneyWithVals.length > 0) {
          // Prefer explicit row shape "... <rate> <payable> <applied>" when available.
          const rowTailMatch = blockText.match(
            /(?:\d+(?:\.\d+)?\s*%)\s+(\(?\$?\d[\d,]*\.\d{2}\)?)\s+(\(?\$?\d[\d,]*\.\d{2}\)?)/i
          )
          if (rowTailMatch) {
            payableCommStr = rowTailMatch[1]
            appliedToAdvanceStr = rowTailMatch[2]
          } else {
            // Fallback heuristic within block only.
            const nonZeroByAbs = moneyWithVals
              .filter(m => m.val !== 0)
              .sort((a, b) => Math.abs(b.val) - Math.abs(a.val))
            if (nonZeroByAbs.length > 0) {
              payableCommStr = nonZeroByAbs[0].raw
            } else if (moneyWithVals.length > 0) {
              payableCommStr = moneyWithVals[0].raw
            }
            const afterPayable = moneyWithVals.find(m => m.raw !== payableCommStr)
            if (afterPayable) appliedToAdvanceStr = afterPayable.raw
          }
          const firstMoney = moneyWithVals[0]
          if (firstMoney && firstMoney.raw !== payableCommStr) commissionPremiumStr = firstMoney.raw
        }

        if (tailPct.length >= 1) {
          commissionRatePctStr = tailPct[0]
        }

        if (!payableCommStr) {
          // We at least need payable commission; skip if we truly couldn't infer it.
          continue
        }

        rowNumber += 1
        rows.push({
          agency_carrier_id: agencyCarrierId,
          file_id: fileId,
          row_number: rowNumber,
          policy_number: policyNumber,
          writing_agent_number: writingAgentNumber,
          writing_agent_name: writingAgentName,
          client_name: clientName || null,
          state,
          plan_code: planCode,
          eff_month_year: effMonthYear,
          months_paid: monthsPaidStr ? Number(monthsPaidStr) : null,
          paid_to_date: paidToDate,
          policy_duration: policyDurationStr ? Number(policyDurationStr) : null,
          commission_premium: parseMoney(commissionPremiumStr),
          commission_rate_pct: commissionRatePctStr
            ? Number(commissionRatePctStr.replace(/[%]/g, ''))
            : null,
          payable_commission: parseMoney(payableCommStr),
          applied_to_advance: parseMoney(appliedToAdvanceStr),
          statement_date: commissionPeriodStart,
          commission_period_start: commissionPeriodStart,
          commission_period_end: commissionPeriodEnd,
          source_file: storagePath,
          source_format: 'SENTINEL_COMMISSION_PDF',
        })
        // Move outer index forward to this block end to avoid duplicate parsing.
        i = blockEnd - 1
      }
    }

    if (!rows.length) {
      console.warn('[Sentinel PDF] No policy rows detected for file:', storagePath)
      // Log a sample of raw lines so we can tune the parser to real output.
      console.log('[Sentinel PDF][debug] raw line sample:', lines.slice(0, 80))
      return NextResponse.json({ rowsInserted: 0 })
    }

    // Ignore zero-payable rows; only keep rows with real commission movement.
    // Parentheses are already parsed as negative by parseMoney(), so chargebacks
    // (e.g. "($436.88)") remain and are processed.
    const rowsWithPayable = rows.filter((r) => {
      const amt =
        r.payable_commission != null
          ? (typeof r.payable_commission === 'number'
              ? r.payable_commission
              : Number(String(r.payable_commission).replace(/,/g, '')))
          : NaN
      return !Number.isNaN(amt) && amt !== 0
    })
    const zeroPayableCount = rows.length - rowsWithPayable.length

    if (!rowsWithPayable.length) {
      console.warn(
        '[Sentinel PDF] Parsed rows found but all payable_commission values are zero.',
        { parsedRows: rows.length }
      )
      return NextResponse.json({ rowsInserted: 0 })
    }

    console.log(
      '[Sentinel PDF] Parsed sample:',
      rowsWithPayable.slice(0, 5).map((r) => ({
        policy_number: r.policy_number,
        payable_commission: r.payable_commission,
        applied_to_advance: r.applied_to_advance,
        client_name: r.client_name,
      }))
    )
    console.log('[Sentinel PDF] Parse stats:', {
      parsedRows: rows.length,
      insertedRows: rowsWithPayable.length,
      filteredZeroPayable: zeroPayableCount,
    })

    // Append-only behavior (same as other commission uploads):
    // keep historical rows; do not replace prior uploads.
    const { error: insertError } = await supabase
      .from('sentinel_commissions')
      .insert(rowsWithPayable)

    if (insertError) {
      console.error('[Sentinel PDF] Insert error:', insertError.message)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    console.log('[Sentinel PDF] Inserted sentinel_commissions rows:', rowsWithPayable.length)
    return NextResponse.json({ rowsInserted: rowsWithPayable.length })
  } catch (e: any) {
    console.error('[Sentinel PDF] Error handling request:', e)
    return NextResponse.json({ error: 'Failed to parse Sentinel commission PDF.' }, { status: 500 })
  }
}

