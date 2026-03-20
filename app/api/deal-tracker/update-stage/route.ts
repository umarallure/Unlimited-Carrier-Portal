import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

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

    const supabase = createClient(supabaseUrl, supabaseKey)

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
