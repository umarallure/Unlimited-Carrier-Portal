import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncReviewNoteToLeadNotes } from '@/lib/leadNotesSync'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let body: {
    policyNumber?: string
    note?: string
    dealTrackerReviewNoteId?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const result = await syncReviewNoteToLeadNotes({
    policyNumber: String(body.policyNumber ?? ''),
    body: String(body.note ?? ''),
    dealTrackerReviewNoteId: String(body.dealTrackerReviewNoteId ?? ''),
    createdBy: null,
  })

  if (!result.synced) {
    return NextResponse.json(
      {
        synced: false,
        reason: result.reason,
        message: result.message,
      },
      { status: result.reason === 'no_lead' ? 200 : 500 }
    )
  }

  return NextResponse.json({
    synced: true,
    leadId: result.leadId,
    leadNoteId: result.leadNoteId,
  })
}
