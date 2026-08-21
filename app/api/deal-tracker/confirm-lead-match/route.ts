/**
 * Writes policy_id + stage to one specific CRM lead — only reachable after a human
 * has reviewed the unmatched-lead review UI and clicked confirm on a candidate
 * (AI-suggested or picked manually). See lib/leadNotesSync.ts's attachPolicyToLeadById
 * doc comment: this is the one place in the app that attaches a policy without an
 * exact-key match having found it first.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getDdfClient } from '@/lib/ddfSource'
import { attachPolicyToLeadById } from '@/lib/leadNotesSync'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 })

  let body: { policyNumber?: string; leadId?: string; ghlStage?: string | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const policyNumber = String(body.policyNumber ?? '').trim()
  const leadId = String(body.leadId ?? '').trim()
  if (!policyNumber || !leadId) {
    return NextResponse.json({ error: 'policyNumber and leadId are required.' }, { status: 400 })
  }

  const { client: ddf } = getDdfClient('new')
  const result = await attachPolicyToLeadById(ddf, leadId, policyNumber, body.ghlStage ?? null)

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Failed to attach policy.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
