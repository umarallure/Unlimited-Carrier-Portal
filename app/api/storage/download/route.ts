/**
 * Proxy for Supabase Storage downloads. Use this instead of the direct Storage URL
 * so the browser only talks to your app (same-origin), avoiding CORS.
 *
 * GET /api/storage/download?path=Unlimited%20Insurance%2FAMAM%2FCommission%2Ffile.csv
 * Or by file id: GET /api/storage/download?fileId=uuid
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const BUCKET = 'uic-documents'

export async function GET(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseAnonKey) {
    return new NextResponse('Storage not configured', { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const pathParam = searchParams.get('path')
  const fileId = searchParams.get('fileId')

  let storagePath: string | null = null

  if (pathParam && pathParam.trim()) {
    storagePath = decodeURIComponent(pathParam.trim())
  } else if (fileId && fileId.trim()) {
    const supabase = createClient(supabaseUrl, supabaseAnonKey)
    const { data: row, error } = await supabase
      .from('files')
      .select('storage_path')
      .eq('id', fileId.trim())
      .single()
    if (error || !row?.storage_path) {
      return NextResponse.json({ error: 'File not found or no storage path' }, { status: 404 })
    }
    storagePath = row.storage_path
  }

  if (!storagePath) {
    return NextResponse.json(
      { error: 'Missing query: path=... or fileId=...' },
      { status: 400 }
    )
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey)
  const { data, error } = await supabase.storage.from(BUCKET).download(storagePath)

  if (error) {
    return NextResponse.json(
      { error: error.message || 'Storage download failed' },
      { status: error.message?.includes('not found') ? 404 : 400 }
    )
  }

  if (!data) {
    return NextResponse.json({ error: 'No file data' }, { status: 404 })
  }

  const filename = storagePath.split('/').pop() || 'download'
  const contentType = getContentType(filename)

  return new NextResponse(data, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${sanitizeFilename(filename)}"`,
      'Cache-Control': 'private, max-age=60',
    },
  })
}

function getContentType(filename: string): string {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel'
  return 'application/octet-stream'
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^\w\s.-]/g, '_')
}
