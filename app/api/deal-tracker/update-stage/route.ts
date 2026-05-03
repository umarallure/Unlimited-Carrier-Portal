import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { dealId, newStage } = body

    if (!dealId || !newStage) {
      return NextResponse.json(
        { error: 'Missing dealId or newStage' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()

    const { data: existing, error: fetchError } = await supabase
      .from('deal_tracker')
      .select('id, ghl_stage, version_history')
      .eq('id', dealId)
      .single()

    if (fetchError || !existing) {
      return NextResponse.json(
        { error: 'Deal not found' },
        { status: 404 }
      )
    }

    const { error: updateError } = await supabase
      .from('deal_tracker')
      .update({
        ghl_stage: newStage,
        updated_at: new Date().toISOString(),
        last_changed_by_file_id: null,
        last_changed_by_file_name: null,
        last_changed_by_user_id: user?.id ?? null,
        last_changed_by_user_email: user?.email ?? null,
      })
      .eq('id', dealId)

    if (updateError) {
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, previousStage: existing.ghl_stage, newStage })
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || 'Internal server error' },
      { status: 500 }
    )
  }
}
