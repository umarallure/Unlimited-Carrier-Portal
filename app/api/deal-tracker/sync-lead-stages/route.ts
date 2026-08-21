/**
 * Batched lead-stage sync driven by deal_tracker.ghl_stage.
 *
 * Called from the browser after a deal tracker file is confirmed/saved (hundreds of
 * rows per file). For each { policyNumber, ghlStage } pair the matching lead is found
 * — by exact policy_id match, or by decrypting leads.tracking_id for leads that don't
 * have policy_id yet (see syncLeadStagesFromDdfStatus for the exact two-path rule) —
 * and its stage/stage_id is set from the ghl_stage name. The DDF `status` column is
 * intentionally NOT used here — the pipeline stage comes from the carrier-portal
 * ghl_stage only. No name/phone/submission_id matching: policy numbers that match
 * neither path come back in `unmatched` for manual handling.
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
  const seen = new Set<string>()
  const updates: DdfStatusStageSync[] = (Array.isArray(body.updates) ? body.updates : [])
    .map((u) => ({
      trackingId: String(u?.policyNumber ?? '').trim(),
      status: String(u?.ghlStage ?? '').trim(),
    }))
    .filter((u) => {
      if (!u.trackingId || !u.status) return false
      if (seen.has(u.trackingId)) return false
      seen.add(u.trackingId)
      return true
    })

  if (updates.length === 0) {
    return NextResponse.json({ synced: 0, unmatched: [] })
  }

  try {
    const { client } = getDdfClient('new')
    const result = await syncLeadStagesFromDdfStatus(client, updates)
    return NextResponse.json({ synced: result.matchedCount, unmatched: result.unmatchedPolicyNumbers })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'lead stage sync failed'
    console.error('[sync-lead-stages]', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
