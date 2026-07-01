import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { decryptTrackingIdSafe } from '@/lib/trackingIdCrypto'

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
      .select('id, ghl_stage, version_history, policy_number')
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

    // Sync leads.policy_id and leads.stage_id:
    // 1. deal_tracker.policy_number is the plaintext policy number from the carrier file.
    // 2. leads.tracking_id holds the same value encrypted (RSA-OAEP). Decrypt each row and
    //    compare to find the matching lead — same approach used in DDF lookup Strategy 0.
    // 3. Write policy_id (plaintext) and update stage/stage_id from newStage (ghl_stage).
    const policyNumber = ((existing as Record<string, unknown>).policy_number as string | null | undefined)?.trim()
    if (policyNumber) {
      try {
        const { client: crm } = getDdfClient('new')
        const policyLower = policyNumber.toLowerCase()

        // Resolve the pipeline_stage row for newStage (needed for stage_id)
        const { data: stageRows } = await crm
          .from('pipeline_stages')
          .select('id, pipeline_id, name')
          .ilike('name', newStage)
          .limit(5)

        const stageRow = ((stageRows ?? []) as { id: number; pipeline_id: number; name: string }[])
          .find(r => r.name.trim().toLowerCase() === newStage.toLowerCase())

        if (!stageRow) {
          console.warn(`[update-stage] no pipeline_stage matched "${newStage}" — stage_id not updated`)
        }

        // Fetch all leads that have a tracking_id set
        const { data: leadRows, error: leadFetchError } = await crm
          .from('leads')
          .select('id, tracking_id, policy_id, stage_id, pipeline_id')
          .not('tracking_id', 'is', null)

        if (leadFetchError) {
          console.error('[update-stage] leads fetch error:', leadFetchError.message)
        }

        for (const raw of (leadRows ?? []) as { id: string; tracking_id: string | null; policy_id: string | null; stage_id: number | null; pipeline_id: number | null }[]) {
          if (!raw.tracking_id) continue

          // Decrypt the stored ciphertext; decryptTrackingIdSafe returns raw value on failure
          // (handles legacy plaintext rows from before encryption was enabled)
          const decrypted = decryptTrackingIdSafe(raw.tracking_id).trim().toLowerCase()
          if (decrypted !== policyLower) continue

          // Found the matching lead — write policy_id and stage
          const crmUpdate: Record<string, unknown> = {
            policy_id: policyNumber,
          }
          if (stageRow) {
            crmUpdate.stage = stageRow.name
            crmUpdate.stage_id = stageRow.id
            crmUpdate.pipeline_id = stageRow.pipeline_id
          }

          console.log(`[update-stage] updating lead ${raw.id} → policy_id="${policyNumber}", stage="${stageRow?.name ?? '(not found)'}"`)
          const { error: crmUpdateError } = await crm.from('leads').update(crmUpdate as never).eq('id', raw.id)
          if (crmUpdateError) {
            console.error('[update-stage] lead update failed:', crmUpdateError.message)
          }
          break
        }
      } catch (e: unknown) {
        // Lead sync is best-effort — don't fail the deal save
        console.error('[update-stage] lead sync error:', e instanceof Error ? e.message : e)
      }
    }

    return NextResponse.json({ success: true, previousStage: (existing as Record<string, unknown>).ghl_stage, newStage })
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 }
    )
  }
}
