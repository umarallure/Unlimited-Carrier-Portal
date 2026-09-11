// Pure text-parsing logic for Corebridge commission PDFs, extracted out of
// app/api/corebridge/commission-from-pdf/route.ts so it can be unit-tested
// without a running server, Supabase, or Storage.

export interface CorebridgeCommissionRow {
  agency_carrier_id: string
  file_id: string
  row_number: number
  policy_number: string
  statement_date: string | null
  co_name: string
  insured_name: string | null
  issue_date: string | null
  agent_code: string | null
  bga_code: string | null
  comm_type: string | null
  annual_premium: number | null
  premium: number | null
  split_pct: number | null
  split_premium: number | null
  annual_comm_rate: number | null
  comm_pct: number | null
  advance_balance: number | null
  commission_amount: number | null
  source_file: string
  source_format: 'COREBRIDGE_COMMISSION_PDF'
}

export function extractCorebridgeStatementDate(text: string): string | null {
  // "AS OF FEBRUARY 06, 2026"
  const asOfMatch = text.match(/AS OF\s+([A-Z]+)\s+(\d{2}),\s+(\d{4})/i)
  if (!asOfMatch) return null
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
  return mm ? `${yearStr}-${mm}-${dayStr}` : null
}

function parseMoney(s: string | undefined): number | null {
  if (!s) return null
  const raw = s.trim()
  const isParenNegative = /^\(.*\)$/.test(raw)
  const cleaned = raw.replace(/[()$,]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  if (Number.isNaN(n)) return null
  return isParenNegative ? -n : n
}

function parsePct(s: string | undefined): number | null {
  if (!s) return null
  const cleaned = s.replace(/[%(),]/g, '').trim()
  if (!cleaned) return null
  const n = Number(cleaned)
  return Number.isNaN(n) ? null : n
}

function parseDateMMDDYY(s: string | undefined): string | null {
  if (!s) return null
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{2})$/)
  if (!m) return null
  const [, mm, dd, yy] = m
  const year = Number(yy) >= 70 ? `19${yy}` : `20${yy}`
  return `${year}-${mm}-${dd}`
}

/**
 * Scan pdf-parse-extracted text for policy-level commission rows.
 * - Standard block: only track AD rows (comm-type token ending in "AD"),
 *   matching either a bare 2-letter token (e.g. "AD") or one fused onto a
 *   longer product code (e.g. "GENERICATTAD") — statement layouts vary.
 * - OVERRIDE block: track all rows; commission amount is the last money
 *   value on the line (the OVERRIDE COMM column).
 */
export function parseCorebridgeCommissionPdfText(
  text: string,
  ctx: { agencyCarrierId: string; fileId: string; storagePath: string }
): { statementDate: string | null; rows: CorebridgeCommissionRow[] } {
  const statementDate = extractCorebridgeStatementDate(text)

  const lines = text.split(/\r?\n/)
  const rows: CorebridgeCommissionRow[] = []
  let rowNumber = 0
  let inOverrideBlock = false

  console.log('[Corebridge PDF] ===== BEGIN LINE-BY-LINE PARSE =====')
  console.log('[Corebridge PDF] Total lines from pdf-parse:', lines.length)

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    const upperLine = line.toUpperCase()

    const hasCurrencyLikeValue = /[$(]\s*\d|[$]\d/.test(line)
    const looksLikeOverrideSummaryLine =
      upperLine.startsWith('OVERRIDE') &&
      hasCurrencyLikeValue &&
      !upperLine.includes('POLICY')

    if (looksLikeOverrideSummaryLine) {
      console.log('[Corebridge PDF] >>> Ignoring OVERRIDE summary line (not a header):', line)
      continue
    }

    const isPlainOverrideHeader = upperLine === 'OVERRIDE' || upperLine.startsWith('OVERRIDE ')
    const isOverrideHeader =
      !hasCurrencyLikeValue &&
      (upperLine.includes('OVERRIDE COMM') || isPlainOverrideHeader)

    if (isOverrideHeader) {
      console.log('[Corebridge PDF] >>> OVERRIDE BLOCK header detected:', line)
      inOverrideBlock = true
      continue
    }
    if (upperLine.includes('POLICY NUMBER') && upperLine.includes('COMM RATE')) {
      console.log('[Corebridge PDF] >>> STANDARD BLOCK header detected:', line)
      inOverrideBlock = false
      continue
    }
    if (upperLine.startsWith('CO NAME') || upperLine.startsWith('POLICY NUMBER')) {
      continue
    }
    if (upperLine.startsWith('SUB TOTAL')) continue
    if (upperLine.startsWith('TOTAL')) continue

    // Typical row begins with: "AGL 6250123368 DUCKNEY 07/04/25 18AG5 GENERICATTAE ..."
    const head = line.match(/^([A-Z]{2,4})\s+([0-9]{7,})\s+(.+?)\s+(\d{2}\/\d{2}\/\d{2})\s+(.*)$/)
    if (!head) continue

    const [, coName, policyNumber, insuredRaw, issueDateRaw, tailRaw] = head
    if (!policyNumber) continue

    // Only track rows whose COMM TYPE token ends with exactly "AD"
    // (e.g. GENERICATTAD, or a bare "AD" column). Skip AE, FY, REN, TA, etc.
    const lineTokens = line.split(/\s+/)
    const detectedCommTypeToken =
      lineTokens.find(
        tok =>
          /^(?:AD|AE|FY|REN|TA)$/i.test(tok) ||
          (tok.length >= 4 && /^[A-Z]+(?:AD|AE|FY|REN|TA)$/i.test(tok))
      ) ?? null

    if (!inOverrideBlock) {
      const hasAdCommType = !!detectedCommTypeToken && /AD$/i.test(detectedCommTypeToken)
      console.log('[Corebridge PDF] STANDARD row |', policyNumber, '| tokens:', lineTokens.filter(t => t.length >= 4 && /^[A-Z]+/i.test(t)).join(', '), '| detectedCommType:', detectedCommTypeToken, '| hasAD:', hasAdCommType, '| inOverride:', inOverrideBlock)
      if (!hasAdCommType) {
        console.log('[Corebridge PDF]   SKIPPED (no AD token)')
        continue
      }
      console.log('[Corebridge PDF]   ACCEPTED (AD token found)')
    } else {
      console.log('[Corebridge PDF] OVERRIDE row |', policyNumber, '| ACCEPTED (override block)')
    }

    const moneyMatches = tailRaw.match(/-?\$[\d,]+\.\d{2}|\(\$[\d,]+\.\d{2}\)/g) || []
    const commissionAmount = moneyMatches.length >= 1 ? parseMoney(moneyMatches[moneyMatches.length - 1]) : null
    const advanceBalance = moneyMatches.length >= 2 ? parseMoney(moneyMatches[moneyMatches.length - 2]) : null

    const pctMatches = tailRaw.match(/-?\d+(?:\.\d+)?%/g) || []
    const commPct = pctMatches.length >= 1 ? parsePct(pctMatches[pctMatches.length - 1]) : null
    const annualCommRate = pctMatches.length >= 2 ? parsePct(pctMatches[pctMatches.length - 2]) : null
    const splitPct = pctMatches.length >= 3 ? parsePct(pctMatches[pctMatches.length - 3]) : null

    let tail = tailRaw
    for (const m of moneyMatches) tail = tail.replace(m, ' ')
    for (const p of pctMatches) tail = tail.replace(p, ' ')
    tail = tail.replace(/\s+/g, ' ').trim()
    const tokens = tail.split(' ').filter(Boolean)

    const agentCode = tokens[0] ?? null
    const bgaCode = tokens[1] ?? null
    const commType = inOverrideBlock ? 'OVERRIDE' : detectedCommTypeToken

    const remainingMoney = tokens.slice(3).join(' ').match(/-?\$?[\d,]+\.\d{2}|\(\$[\d,]+\.\d{2}\)/g) || []
    const annualPremium = remainingMoney.length >= 1 ? parseMoney(remainingMoney[0]) : null
    const premium = remainingMoney.length >= 2 ? parseMoney(remainingMoney[1]) : null
    const splitPremium = remainingMoney.length >= 3 ? parseMoney(remainingMoney[2]) : null

    rowNumber += 1
    rows.push({
      agency_carrier_id: ctx.agencyCarrierId,
      file_id: ctx.fileId,
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
      source_file: ctx.storagePath,
      source_format: 'COREBRIDGE_COMMISSION_PDF',
    })
  }

  console.log('[Corebridge PDF] ===== END LINE-BY-LINE PARSE =====')
  console.log('[Corebridge PDF] Total accepted rows:', rows.length)
  console.log('[Corebridge PDF] Accepted policies:', rows.map(r => `${r.policy_number} (${r.comm_type})`).join(', '))

  return { statementDate, rows }
}

/** Dedupe by (agency_carrier_id, policy_number) so ON CONFLICT never tries to update the same row twice in one statement. */
export function dedupeCorebridgeCommissionRows(rows: CorebridgeCommissionRow[]): CorebridgeCommissionRow[] {
  const byKey = new Map<string, CorebridgeCommissionRow>()
  for (const r of rows) {
    const key = `${r.agency_carrier_id}::${r.policy_number}`
    byKey.set(key, r)
  }
  return Array.from(byKey.values())
}
