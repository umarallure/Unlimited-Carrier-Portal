/**
 * Batched lead-stage sync driven by deal_tracker.ghl_stage.
 *
 * Called from the browser after a deal tracker file is confirmed/saved (hundreds of
 * rows per file). For each { policyNumber, ghlStage } pair the matching lead is found
 * (by decrypting leads.tracking_id — see syncLeadStagesFromDdfStatus) and its
 * stage/stage_id is set from the ghl_stage name. The DDF `status` column is intentionally
 * NOT used here — the pipeline stage comes from the carrier-portal ghl_stage only.
 *
 * POST body: { updates: { policyNumber: string; ghlStage: string }[] }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getDdfClient } from '@/lib/ddfSource'
import { syncLeadStagesFromDdfStatus, type DdfStatusStageSync } from '@/lib/leadNotesSync'

export async function POST(request: NextRequest) {
  let body: { updates?: { policyNumber?: string; ghlStage?: string }[] }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  // trackingId = plaintext policy number; status = ghl_stage name (looked up in pipeline_stages).
  // submissionId is null: entries carry no DDF submission id, so the sync falls back to
  // decrypting leads.tracking_id — a single scan handles the whole batch.
  const seen = new Set<string>()
  const updates: DdfStatusStageSync[] = (Array.isArray(body.updates) ? body.updates : [])
    .map((u) => ({
      trackingId: String(u?.policyNumber ?? '').trim(),
      status: String(u?.ghlStage ?? '').trim(),
      submissionId: null,
    }))
    .filter((u) => {
      if (!u.trackingId || !u.status) return false
      if (seen.has(u.trackingId)) return false
      seen.add(u.trackingId)
      return true
    })

  if (updates.length === 0) {
    return NextResponse.json({ synced: 0 })
  }

  try {
    const { client } = getDdfClient('new')
    await syncLeadStagesFromDdfStatus(client, updates)
    return NextResponse.json({ synced: updates.length })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'lead stage sync failed'
    console.error('[sync-lead-stages]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
