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

    let debugLinesEmitted = 0
    const MAX_DEBUG_LINES = 50

    const tryParsePolicyLine = (line: string) => {
      const trimmed = line.trim()
      if (!trimmed) return null
      if (trimmed.toUpperCase().startsWith('TOTAL')) return null

      // Collect money and percent chunks from the tail of the line.
      const moneyMatches = trimmed.match(moneyRegex) || []
      const pctMatches = trimmed.match(pctRegex) || []

      // Expect at least Payable Comm + Applied To Advance; Comm Premium is optional.
      if (moneyMatches.length < 2) return null

      // Identify core monetary columns from the end:
      const appliedToAdvanceStr = moneyMatches[moneyMatches.length - 1]
      const payableCommStr = moneyMatches[moneyMatches.length - 2]
      const commPremiumStr =
        moneyMatches.length >= 3 ? moneyMatches[moneyMatches.length - 3] : null

      const commissionRateStr = pctMatches.length > 0 ? pctMatches[pctMatches.length - 1] : null

      // Remove the money and percent pieces from the line so we can parse the head.
      let head = trimmed
      for (const m of moneyMatches) head = head.replace(m, ' ')
      for (const p of pctMatches) head = head.replace(p, ' ')
      head = head.replace(/\s+/g, ' ').trim()

      // Tokenize the remaining head. Layout (approx):
      // Writing Agent #, Writing Agent Name, Policy #, Name, App St, Plan Code, Eff Mo/Yr, Mths Paid, Paid to Date, Policy Dur.
      const tokens = head.split(' ').filter(Boolean)
      if (tokens.length < 6) {
        if (debugLinesEmitted < MAX_DEBUG_LINES) {
          console.log('[Sentinel PDF][debug] skip: too few tokens', { line: trimmed, head, tokens })
          debugLinesEmitted++
        }
        return null
      }

      const writingAgentNumber = tokens[0]

      // Find policy number as the first all-digit token of length >= 5
      let policyIndex = -1
      for (let i = 1; i < tokens.length; i++) {
        if (/^\d{5,}$/.test(tokens[i])) {
          policyIndex = i
          break
        }
      }
      if (policyIndex === -1) {
        if (debugLinesEmitted < MAX_DEBUG_LINES) {
          console.log('[Sentinel PDF][debug] skip: no policy number', { line: trimmed, head, tokens })
          debugLinesEmitted++
        }
        return null
      }

      const writingAgentName = tokens.slice(1, policyIndex).join(' ') || null

      const policyNumber = tokens[policyIndex]

      // After policy number: client name until we hit a 2-letter state code
      let stateIndex = -1
      for (let i = policyIndex + 1; i < tokens.length; i++) {
        if (/^[A-Z]{2}$/i.test(tokens[i])) {
          stateIndex = i
          break
        }
      }
      if (stateIndex === -1) {
        if (debugLinesEmitted < MAX_DEBUG_LINES) {
          console.log('[Sentinel PDF][debug] skip: no state token', { line: trimmed, head, tokens })
          debugLinesEmitted++
        }
        return null
      }

      const clientName = tokens.slice(policyIndex + 1, stateIndex).join(' ') || null
      const state = tokens[stateIndex] ?? null

      // Remaining: plan code, eff month/yr, mths paid, paid to date, policy duration (best-effort parsing)
      const remaining = tokens.slice(stateIndex + 1)
      const planCode = remaining[0] ?? null
      const effMonthYear = remaining[1] ?? null
      const monthsPaid = remaining[2] ? Number(remaining[2]) : null
      const paidToDate = remaining[3] ?? null
      const policyDuration = remaining[4] ? Number(remaining[4]) : null

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
        prevLine != null ? tryParsePolicyLine(`${prevLine} ${line}`) : null
      if (!parsed) {
        parsed = tryParsePolicyLine(line)
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

    // Fallback: handle vertical layout where an entire row is spread across many lines.
    // Based on observed output, detail blocks look like:
    //  LIFE
    //  First Year
    //  K999999622              (writing agent #)
    //  FLINCHUM, BRANDON       (writing agent name)
    //  654558                  (policy #)
    //  NATACIA LOGAN-COLLINS   (client name)   <-- may be on the next line(s)
    //  IL                      (state)
    //  848                     (plan code)
    //  03/2026                 (eff Mo/Yr)
    //  1                       (months paid)
    //  04/2026                 (paid to date)
    //  1                       (policy duration)
    //  $58.02 85.00 %          (commission premium + rate)
    //  85.00 % $384.70         (rate + payable comm)
    //  $384.70 $49.32          (payable + applied to advance)
    if (!rows.length) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]?.trim() !== 'LIFE') continue
        if ((lines[i + 1] || '').trim() !== 'First Year') continue

        const writingAgentNumber = (lines[i + 2] || '').trim()
        const writingAgentName = (lines[i + 3] || '').trim() || null
        const policyNumber = (lines[i + 4] || '').trim()
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

        // Find monetary values in all subsequent lines of the document.
        const tailText = lines.slice(cursor).join(' ')
        const tailMoney = tailText.match(moneyRegex) || []
        const tailPct = tailText.match(pctRegex) || []

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

        if (positiveMoney.length > 0) {
          // Payable commission should be the largest positive amount (e.g. 384.70)
          const maxPayable = positiveMoney.reduce((max, cur) =>
            cur.val > max.val ? cur : max
          )
          payableCommStr = maxPayable.raw

          // Applied to advance is typically the smallest positive (e.g. 49.32)
          const remaining = positiveMoney.filter(m => m !== maxPayable)
          if (remaining.length > 0) {
            const minApplied = remaining.reduce((min, cur) =>
              cur.val < min.val ? cur : min
            )
            appliedToAdvanceStr = minApplied.raw

            // Commission premium, when present, is the remaining positive value (e.g. 58.02)
            const remainingAfterApplied = remaining.filter(m => m !== minApplied)
            if (remainingAfterApplied.length > 0) {
              commissionPremiumStr = remainingAfterApplied[0].raw
            }
          }
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
      }
    }

    if (!rows.length) {
      console.warn('[Sentinel PDF] No policy rows detected for file:', storagePath)
      // Log a sample of raw lines so we can tune the parser to real output.
      console.log('[Sentinel PDF][debug] raw line sample:', lines.slice(0, 80))
      return NextResponse.json({ rowsInserted: 0 })
    }

    const byKey = new Map<string, any>()
    for (const r of rows) {
      const key = `${r.agency_carrier_id}::${r.policy_number}`
      byKey.set(key, r)
    }
    const dedupedRows = Array.from(byKey.values())

    const { error: insertError } = await supabase
      .from('sentinel_commissions')
      .upsert(dedupedRows, {
        onConflict: 'agency_carrier_id,policy_number',
        ignoreDuplicates: false,
      })

    if (insertError) {
      console.error('[Sentinel PDF] Insert error:', insertError.message)
      return NextResponse.json({ error: insertError.message }, { status: 500 })
    }

    console.log('[Sentinel PDF] Inserted sentinel_commissions rows:', dedupedRows.length)
    return NextResponse.json({ rowsInserted: dedupedRows.length })
  } catch (e: any) {
    console.error('[Sentinel PDF] Error handling request:', e)
    return NextResponse.json({ error: 'Failed to parse Sentinel commission PDF.' }, { status: 500 })
  }
}

