import { NextRequest, NextResponse } from 'next/server'
import { createClient as createServiceClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { decryptTrackingIdSafe } from '@/lib/trackingIdCrypto'
import { insertLeadNote, policyLookupCandidates } from '@/lib/leadNotesSync'
import { GHL_STAGE_ORDER } from '@/lib/ghlStageResolver'

export const dynamic = 'force-dynamic'

const LEADS_TABLE = process.env.NEW_DDF_LEADS_TABLE || 'leads'

/**
 * Service-role client, server-only.
 *
 * `deal_tracker_review_notes` has an RLS policy that rejects inserts from the
 * `authenticated` role, so the cookie-scoped client cannot write the audit row.
 * This route has already verified the caller is a signed-in user and stamps
 * their address into `reviewer_name`, so writing the note with elevated rights
 * adds no capability the caller did not already have.
 *
 * Same shape as app/api/admin/users/route.ts. Never import this into a client
 * component — SUPABASE_SERVICE_ROLE_KEY is not exposed to the browser.
 */
function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
  if (!url || !key) return null
  return createServiceClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

type LeadRow = {
  id: string
  policy_id: string | null
  stage: string | null
  stage_id: number | null
  pipeline_id: number | null
}

type CrmResult = {
  leadFound: boolean
  leadId: string | null
  matchedBy: 'policy_id' | 'tracking_id' | null
  previousStage: string | null
  stageUpdated: boolean
  stageId: number | null
  pipelineChanged: boolean
  noteSaved: boolean
  message: string | null
}

/**
 * Resolve the CRM `pipeline_stages` row for a GHL stage name.
 *
 * Stage names are compared case-insensitively because the CRM and the portal
 * disagree on casing for some stages (portal "Active Placed - Paid as Advanced"
 * vs CRM "ACTIVE PLACED - Paid as Advanced").
 */
async function resolvePipelineStage(
  crm: ReturnType<typeof getDdfClient>['client'],
  stageName: string
): Promise<{ id: number; pipeline_id: number; name: string } | null> {
  const { data, error } = await crm
    .from('pipeline_stages')
    .select('id, pipeline_id, name')
    .ilike('name', stageName)
    .limit(10)

  if (error) {
    console.error('[correspondence/update-stage] pipeline_stages lookup failed:', error.message)
    return null
  }

  const rows = (data ?? []) as Array<{ id: number; pipeline_id: number; name: string }>
  return rows.find((r) => r.name.trim().toLowerCase() === stageName.trim().toLowerCase()) ?? null
}

/**
 * Find the CRM lead for a policy number.
 *
 * `leads.policy_id` covers most rows and is a single indexed query. Leads that
 * predate policy attachment only carry the policy number inside the encrypted
 * `tracking_id`, so those need a decrypting scan — the same fallback used by
 * /api/deal-tracker/update-stage. Kept second because it is far more expensive.
 */
async function findLead(
  crm: ReturnType<typeof getDdfClient>['client'],
  policyNumber: string
): Promise<{ lead: LeadRow; matchedBy: 'policy_id' | 'tracking_id' } | null> {
  const candidates = policyLookupCandidates(policyNumber)

  if (candidates.length) {
    const { data, error } = await crm
      .from(LEADS_TABLE)
      .select('id, policy_id, stage, stage_id, pipeline_id')
      .in('policy_id', candidates)
      .limit(1)

    if (error) console.error('[correspondence/update-stage] policy_id lookup failed:', error.message)
    const rows = (data ?? []) as LeadRow[]
    if (rows.length) return { lead: rows[0], matchedBy: 'policy_id' }
  }

  const { data: trackingRows, error: trackingError } = await crm
    .from(LEADS_TABLE)
    .select('id, policy_id, stage, stage_id, pipeline_id, tracking_id')
    .not('tracking_id', 'is', null)

  if (trackingError) {
    console.error('[correspondence/update-stage] tracking_id fetch failed:', trackingError.message)
    return null
  }

  const target = policyNumber.trim().toLowerCase()
  for (const raw of (trackingRows ?? []) as Array<LeadRow & { tracking_id: string | null }>) {
    if (!raw.tracking_id) continue
    if (decryptTrackingIdSafe(raw.tracking_id).trim().toLowerCase() !== target) continue
    return {
      lead: {
        id: raw.id,
        policy_id: raw.policy_id,
        stage: raw.stage,
        stage_id: raw.stage_id,
        pipeline_id: raw.pipeline_id,
      },
      matchedBy: 'tracking_id',
    }
  }

  return null
}

/**
 * Move a GHL stage from the AMAM Correspondence grid.
 *
 * Writes, in order:
 *   1. deal_tracker.ghl_stage                (authoritative — failure aborts)
 *   2. deal_tracker_review_notes             (audit trail of the transition)
 *   3. CRM leads.stage / stage_id / pipeline_id
 *   4. CRM lead_notes                        (the memo that justified the move)
 *
 * Steps 3 and 4 are best-effort: a CRM outage or an unattached lead must not
 * roll back the portal-side change. The response reports each step separately
 * so the UI can tell the user exactly what landed.
 */
export async function POST(request: NextRequest) {
  let body: {
    dealId?: string
    policyNumber?: string
    newStage?: string
    note?: string
    correspondenceId?: string
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

  const dealId = String(body.dealId ?? '').trim()
  const newStage = String(body.newStage ?? '').trim()
  const note = String(body.note ?? '').trim()

  if (!dealId || !newStage) {
    return NextResponse.json({ error: 'dealId and newStage are required.' }, { status: 400 })
  }

  // Only stages the portal knows about — this endpoint must not be able to write
  // an arbitrary string into deal_tracker.ghl_stage.
  const canonicalStage = (GHL_STAGE_ORDER as readonly string[]).find(
    (s) => s.toLowerCase() === newStage.toLowerCase()
  )
  if (!canonicalStage) {
    return NextResponse.json({ error: `Unknown GHL stage: ${newStage}` }, { status: 400 })
  }

  // ── 1. deal_tracker ───────────────────────────────────────────────────────
  const { data: existing, error: fetchError } = await supabase
    .from('deal_tracker')
    .select('id, ghl_stage, policy_number')
    .eq('id', dealId)
    .maybeSingle()

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Deal not found in Deal Tracker.' }, { status: 404 })
  }

  const deal = existing as { id: string; ghl_stage: string | null; policy_number: string | null }
  const previousStage = deal.ghl_stage
  const policyNumber = String(body.policyNumber ?? deal.policy_number ?? '').trim()
  const now = new Date().toISOString()

  if (previousStage === canonicalStage) {
    return NextResponse.json(
      { error: `Deal is already in "${canonicalStage}".` },
      { status: 400 }
    )
  }

  const { error: updateError } = await supabase
    .from('deal_tracker')
    .update({
      ghl_stage: canonicalStage,
      updated_at: now,
      last_updated: now,
      last_changed_by_file_id: null,
      last_changed_by_file_name: null,
      last_changed_by_user_id: user.id,
      last_changed_by_user_email: user.email ?? null,
    } as never)
    .eq('id', dealId)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // ── 2. Review note (audit trail + the FK lead_notes hangs off) ─────────────
  let reviewNoteId: string | null = null
  let reviewNoteError: string | null = null

  if (note) {
    const service = getServiceClient()
    if (!service) {
      reviewNoteError =
        'SUPABASE_SERVICE_ROLE_KEY is not configured, so the review note could not be written (RLS blocks the user role).'
      console.error('[correspondence/update-stage]', reviewNoteError)
    } else {
      const { data: insertedNote, error: noteError } = await service
        .from('deal_tracker_review_notes')
        .insert({
          policy_id: dealId,
          note,
          previous_ghl_stage: previousStage,
          next_ghl_stage: canonicalStage,
          reviewer_name: user.email ?? null,
          created_at: now,
        } as never)
        .select('id')
        .maybeSingle()

      if (noteError) {
        reviewNoteError = noteError.message
        console.error('[correspondence/update-stage] review note insert failed:', noteError.message)
      } else {
        const row = insertedNote as { id?: unknown } | null
        reviewNoteId = row?.id != null ? String(row.id) : null
      }
    }
  }

  // ── 3 & 4. CRM stage + lead note (best effort) ─────────────────────────────
  const crmResult: CrmResult = {
    leadFound: false,
    leadId: null,
    matchedBy: null,
    previousStage: null,
    stageUpdated: false,
    stageId: null,
    pipelineChanged: false,
    noteSaved: false,
    message: null,
  }

  if (!policyNumber) {
    crmResult.message = 'Deal has no policy number, so the CRM lead could not be located.'
  } else {
    try {
      const { client: crm } = getDdfClient('new')

      const stageRow = await resolvePipelineStage(crm, canonicalStage)
      const match = await findLead(crm, policyNumber)

      if (!match) {
        crmResult.message = `No lead found in the CRM for policy ${policyNumber}. Attach the policy in the CRM to enable syncing.`
      } else {
        const { lead, matchedBy } = match
        crmResult.leadFound = true
        crmResult.leadId = lead.id
        crmResult.matchedBy = matchedBy
        crmResult.previousStage = lead.stage

        const crmUpdate: Record<string, unknown> = {}

        // Self-heal: leads matched by decrypting tracking_id have no policy_id,
        // so the next lookup would pay for the scan again.
        if (lead.policy_id !== policyNumber) crmUpdate.policy_id = policyNumber

        if (stageRow) {
          crmUpdate.stage = stageRow.name
          crmUpdate.stage_id = stageRow.id
          if (stageRow.pipeline_id !== lead.pipeline_id) crmUpdate.pipeline_id = stageRow.pipeline_id
        }

        const { error: crmUpdateError } = await crm
          .from(LEADS_TABLE)
          .update(crmUpdate as never)
          .eq('id', lead.id)

        if (crmUpdateError) {
          crmResult.message = `CRM lead update failed: ${crmUpdateError.message}`
          console.error('[correspondence/update-stage] lead update failed:', crmUpdateError.message)
        } else if (stageRow) {
          crmResult.stageUpdated = true
          crmResult.stageId = stageRow.id
          crmResult.pipelineChanged = stageRow.pipeline_id !== lead.pipeline_id
        } else {
          crmResult.message = `"${canonicalStage}" has no matching pipeline stage in the CRM, so the lead stage was left unchanged.`
        }

        if (note) {
          // `lead_notes.created_by` is a uuid holding a CRM user id, which a
          // portal user does not have. Stamp the author into the body instead,
          // matching how /api/review-policies/update-crm-stage writes leads.notes.
          const stamp = new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          })
          const inserted = await insertLeadNote({
            leadId: lead.id,
            body: `[Carrier Portal ${stamp}] ${user.email ?? 'Unknown'}: ${note}`,
            dealTrackerReviewNoteId: reviewNoteId ?? '',
            createdBy: null,
          })
          if (inserted.ok) {
            crmResult.noteSaved = true
          } else {
            crmResult.message = [crmResult.message, `Lead note failed: ${inserted.message}`]
              .filter(Boolean)
              .join(' ')
            console.error('[correspondence/update-stage] lead note failed:', inserted.message)
          }
        }
      }
    } catch (err: unknown) {
      // Missing NEW_DDF_* env, network failure, etc. The portal-side change stands.
      crmResult.message = `CRM sync unavailable: ${err instanceof Error ? err.message : String(err)}`
      console.error('[correspondence/update-stage] CRM sync error:', err)
    }
  }

  return NextResponse.json({
    ok: true,
    dealId,
    policyNumber,
    previousStage,
    newStage: canonicalStage,
    correspondenceId: String(body.correspondenceId ?? '').trim() || null,
    reviewNote: {
      saved: reviewNoteId != null,
      id: reviewNoteId,
      error: reviewNoteError,
    },
    crm: crmResult,
  })
}
