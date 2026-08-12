import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { policyLookupCandidates } from '@/lib/leadNotesSync'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  let body: {
    policyNumber?: string
    newStage?: string
    note?: string
    dealTrackerId?: string
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })
  }

  const policyNumber = String(body.policyNumber ?? '').trim()
  const newStage = String(body.newStage ?? '').trim()
  const note = String(body.note ?? '').trim()
  const dealTrackerId = String(body.dealTrackerId ?? '').trim()

  if (!policyNumber || !newStage) {
    return NextResponse.json({ error: 'policyNumber and newStage are required.' }, { status: 400 })
  }

  const { client: crm } = getDdfClient('new')
  const now = new Date().toISOString()

  // ── 1. Look up pipeline_stages to get numeric id + pipeline_id ───────────────
  const { data: stageRows, error: stageError } = await crm
    .from('pipeline_stages')
    .select('id, pipeline_id, name')
    .ilike('name', newStage)
    .limit(5)

  if (stageError) {
    return NextResponse.json({ error: stageError.message }, { status: 500 })
  }

  const stageRow = (stageRows ?? []).find(
    (r: { name: string }) => r.name.trim().toLowerCase() === newStage.toLowerCase()
  ) as { id: number; pipeline_id: number; name: string } | undefined

  // ── 2. Find the lead in INSURVAS CRM by policy_id ───────────────────────────
  const candidates = policyLookupCandidates(policyNumber)
  const { data: leadRows, error: lookupError } = await crm
    .from('leads')
    .select('id, stage, stage_id, pipeline_id, notes')
    .in('policy_id', candidates)
    .limit(1)

  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 })
  }

  if (!leadRows || leadRows.length === 0) {
    return NextResponse.json({ found: false, message: 'No lead found in INSURVAS CRM for this policy number.' })
  }

  const lead = leadRows[0] as {
    id: string
    stage: string | null
    stage_id: number | null
    pipeline_id: number | null
    notes: string | null
  }
  const previousStage = lead.stage

  // ── 3. Update leads: stage (text) + stage_id (FK) + pipeline_id if changed ──
  const crmUpdate: Record<string, unknown> = {
    stage: stageRow?.name ?? newStage,
    stage_id: stageRow?.id ?? null,
  }
  if (stageRow && stageRow.pipeline_id !== lead.pipeline_id) {
    crmUpdate.pipeline_id = stageRow.pipeline_id
  }
  if (note) {
    const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
    const entry = `[Carrier Portal ${stamp}] ${user.email ?? 'Unknown'}: ${note}`
    crmUpdate.notes = lead.notes ? `${lead.notes}\n\n${entry}` : entry
  }

  const { error: crmUpdateError } = await crm
    .from('leads')
    .update(crmUpdate as never)
    .eq('id', lead.id)

  if (crmUpdateError) {
    return NextResponse.json({ error: crmUpdateError.message }, { status: 500 })
  }

  // ── 4. Update deal_tracker.ghl_stage in Carrier Portal ──────────────────────
  const dtUpdate: Record<string, unknown> = {
    ghl_stage: newStage,
    updated_at: now,
    last_updated: now,
  }
  if (note) {
    // Also append note to deal_tracker review notes
    await supabase
      .from('deal_tracker_review_notes')
      .insert({
        policy_id: dealTrackerId || null,
        note: note,
        previous_ghl_stage: previousStage,
        next_ghl_stage: newStage,
        reviewer_name: user.email ?? null,
        created_at: now,
      })
      .select('id')
      .maybeSingle()
  }

  if (dealTrackerId) {
    await supabase
      .from('deal_tracker')
      .update(dtUpdate as never)
      .eq('id', dealTrackerId)
  } else {
    // Fall back to matching by policy_number
    await supabase
      .from('deal_tracker')
      .update(dtUpdate as never)
      .eq('policy_number', policyNumber)
  }

  return NextResponse.json({
    found: true,
    leadId: lead.id,
    previousStage,
    newStage: stageRow?.name ?? newStage,
    stageId: stageRow?.id ?? null,
    pipelineChanged: stageRow ? stageRow.pipeline_id !== lead.pipeline_id : false,
  })
}
