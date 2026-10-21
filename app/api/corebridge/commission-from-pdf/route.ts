import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { parsePdfTextIsolated } from '@/lib/pdfParseIsolated'
import { parseCorebridgeCommissionPdfText, dedupeCorebridgeCommissionRows } from '@/lib/corebridgeCommissionParser'

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
    const { fileId, agencyCarrierId, carrierCode, storagePath, deferWrite } = await req.json()

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

    // Parse in an isolated child process — pdf-parse's vendored pdf.js throws
    // spuriously on well-formed PDFs once the Supabase client above has been
    // created in-process. See lib/pdfParseIsolated.ts for details.
    let text: string
    try {
      text = await parsePdfTextIsolated(buffer)
    } catch (e: any) {
      console.error('[Corebridge PDF] pdf-parse failed:', e)
      return NextResponse.json({ error: e?.message || 'pdf-parse failed on server.' }, { status: 500 })
    }

    if (!text.trim()) {
      console.warn('[Corebridge PDF] No text extracted from PDF:', storagePath)
      return NextResponse.json({ rowsInserted: 0 })
    }

    const { rows } = parseCorebridgeCommissionPdfText(text, { agencyCarrierId, fileId, storagePath })

    if (!rows.length) {
      console.warn('[Corebridge PDF] No policy rows detected for file:', storagePath)
      return NextResponse.json({ rowsInserted: 0, rows: [] })
    }

    const dedupedRows = dedupeCorebridgeCommissionRows(rows)
    console.log('[Corebridge PDF] After dedup:', dedupedRows.length, 'rows to insert')

    if (deferWrite === true) {
      console.log('[Corebridge PDF] deferWrite: returning rows without DB insert')
      return NextResponse.json({
        rowsInserted: 0,
        rows: dedupedRows,
        deferred: true,
      })
    }

    const table = supabase.from('corebridge_commissions')

    // Wipe ALL existing corebridge_commissions for this agency+file so
    // re-uploads start clean and old non-AD rows don't linger.
    const { error: wipeError } = await table
      .delete()
      .eq('agency_carrier_id', agencyCarrierId)
      .eq('file_id', fileId)
    if (wipeError) {
      console.error('[Corebridge PDF] Wipe error:', wipeError.message)
    }

    // Also remove any prior rows for the same policy numbers (from older uploads)
    // so stale AE/FY rows don't persist in the DB.
    for (const row of dedupedRows) {
      await table
        .delete()
        .eq('agency_carrier_id', row.agency_carrier_id)
        .eq('policy_number', row.policy_number)
    }

    const { error: insertError } = await table.insert(dedupedRows)
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

