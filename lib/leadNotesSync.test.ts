import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  syncLeadStagesFromDdfStatus,
  resolvePreferredStage,
  buildLeadStageUpdate,
  findLeadsForPolicyNumbers,
  attachPolicyToLeadById,
  type DdfStatusStageSync,
  type PipelineStageRow,
} from './leadNotesSync'

// ── resolvePreferredStage: pure-function unit tests ────────────────────────
// Deliberately just "first match" — matches the AMAM Correspondence route's
// own (unshared) resolution so both land on the same stage for the same name.

test('resolvePreferredStage: no matches -> null', () => {
  assert.equal(resolvePreferredStage([]), null)
})

test('resolvePreferredStage: single match -> that match', () => {
  const only: PipelineStageRow = { id: 1, pipeline_id: 1, name: 'FDPF Pending Reason' }
  assert.deepEqual(resolvePreferredStage([only]), only)
})

test('resolvePreferredStage: multiple matches -> the first one', () => {
  const inChargeback: PipelineStageRow = { id: 115, pipeline_id: 1, name: 'Chargeback DQ' }
  const inTransfer: PipelineStageRow = { id: 146, pipeline_id: 4, name: 'Chargeback DQ' }
  assert.deepEqual(resolvePreferredStage([inChargeback, inTransfer]), inChargeback)
  assert.deepEqual(resolvePreferredStage([inTransfer, inChargeback]), inTransfer)
})

// ── buildLeadStageUpdate: pure-function unit tests ─────────────────────────
// This is the shared payload builder used by both syncLeadStagesFromDdfStatus
// (bulk, upload-triggered) and the AMAM Correspondence "change stage" route
// (single lead, human-triggered) — consolidated so both write the same fields
// the same way instead of maintaining two slightly different implementations.

test('buildLeadStageUpdate: writes stage/stage_id/pipeline_id when the resolved stage differs', () => {
  const lead = { policy_id: 'POL-1', stage_id: 128, pipeline_id: 4 }
  const stageRow: PipelineStageRow = { id: 1, pipeline_id: 1, name: 'FDPF Pending Reason' }
  const update = buildLeadStageUpdate(lead, 'POL-1', stageRow)
  assert.deepEqual(update, { stage: 'FDPF Pending Reason', stage_id: 1, pipeline_id: 1 })
})

test('buildLeadStageUpdate: writes policy_id when it differs, even without a stage match', () => {
  const lead = { policy_id: null, stage_id: 128, pipeline_id: 4 }
  const update = buildLeadStageUpdate(lead, 'POL-2', null)
  assert.deepEqual(update, { policy_id: 'POL-2' })
})

test('buildLeadStageUpdate: writes both policy_id and stage fields together', () => {
  const lead = { policy_id: null, stage_id: 128, pipeline_id: 4 }
  const stageRow: PipelineStageRow = { id: 1, pipeline_id: 1, name: 'FDPF Pending Reason' }
  const update = buildLeadStageUpdate(lead, 'POL-3', stageRow)
  assert.deepEqual(update, { policy_id: 'POL-3', stage: 'FDPF Pending Reason', stage_id: 1, pipeline_id: 1 })
})

test('buildLeadStageUpdate: empty object when nothing changed', () => {
  const lead = { policy_id: 'POL-4', stage_id: 1, pipeline_id: 1 }
  const stageRow: PipelineStageRow = { id: 1, pipeline_id: 1, name: 'FDPF Pending Reason' }
  const update = buildLeadStageUpdate(lead, 'POL-4', stageRow)
  assert.deepEqual(update, {})
})

test('buildLeadStageUpdate: empty object when policyNumber is blank and no stage match', () => {
  const lead = { policy_id: null, stage_id: null, pipeline_id: null }
  const update = buildLeadStageUpdate(lead, '', null)
  assert.deepEqual(update, {})
})

// ── syncLeadStagesFromDdfStatus: end-to-end against a fake Supabase client ─
//
// Mirrors the real pipeline_stages layout (see INSURVAS-CRM/pipeline_stages.json):
// pipeline 1 = Chargeback, pipeline 2 = Customer, pipeline 4 = Transfer.
//
// Matching is deliberately exactly two exact, unique-key paths — no scoring,
// no name/phone fuzzy matching, no submission_id:
//   1. policy_id — lead already has the policy attached.
//   2. tracking_id decryption — brand-new lead, not attached to a policy yet.
// A policy number matching neither comes back in unmatchedPolicyNumbers.

const PIPELINE_STAGES: PipelineStageRow[] = [
  { id: 1, pipeline_id: 1, name: 'FDPF Pending Reason' },
  { id: 6, pipeline_id: 1, name: 'Pending Lapse' },
  { id: 7, pipeline_id: 1, name: 'Chargeback Failed Payment' },
  { id: 115, pipeline_id: 1, name: 'Chargeback DQ' },
  { id: 12, pipeline_id: 2, name: 'Issued - Pending First Draft' },
  { id: 15, pipeline_id: 2, name: 'ACTIVE PLACED - Paid as Advanced' }, // CRM casing differs from carrier-portal's
  { id: 128, pipeline_id: 4, name: 'Pending Approval' },
  { id: 129, pipeline_id: 4, name: 'Pending Manual Action' },
  { id: 146, pipeline_id: 4, name: 'Chargeback DQ' },
]

type FakeLead = {
  id: string
  tracking_id: string | null
  policy_id: string | null
  stage: string | null
  stage_id: number | null
  pipeline_id: number | null
}

/**
 * Minimal in-memory stand-in for the Supabase client, supporting only the
 * chains syncLeadStagesFromDdfStatus actually issues:
 *   from(t).select(cols)                      (pipeline_stages: no filter)
 *   from(t).select(cols).in(col, vals)         (leads by policy_id)
 *   from(t).select(cols).not(col, 'is', null)  (leads with non-null tracking_id)
 *   from(t).update(payload).eq('id', id)
 */
function makeFakeDdfClient(tables: { leads: FakeLead[]; pipeline_stages: PipelineStageRow[] }) {
  function builder(rows: any[], filters: ((r: any) => boolean)[], mode: 'select' | 'update', updatePayload: any) {
    const self = {
      select(_cols: string) {
        return builder(rows, filters, 'select', null)
      },
      in(col: string, vals: unknown[]) {
        return builder(rows, [...filters, (r: any) => vals.includes(r[col])], mode, updatePayload)
      },
      not(col: string, _op: string, _val: unknown) {
        return builder(rows, [...filters, (r: any) => r[col] != null], mode, updatePayload)
      },
      update(payload: any) {
        return builder(rows, filters, 'update', payload)
      },
      eq(col: string, val: unknown) {
        return builder(rows, [...filters, (r: any) => r[col] === val], mode, updatePayload)
      },
      then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
        try {
          const matched = rows.filter(r => filters.every(f => f(r)))
          if (mode === 'update') {
            for (const row of matched) Object.assign(row, updatePayload)
          }
          resolve({ data: matched.map(r => ({ ...r })), error: null })
        } catch (e) {
          if (reject) reject(e)
          else resolve({ data: null, error: e })
        }
      },
    }
    return self
  }

  return {
    from(table: 'leads' | 'pipeline_stages') {
      return builder(tables[table], [], 'select', null)
    },
    // expose the live arrays so tests can assert final state directly
    __tables: tables,
  }
}

function baseLead(overrides: Partial<FakeLead>): FakeLead {
  return {
    id: 'lead-1',
    tracking_id: null,
    policy_id: null,
    stage: null,
    stage_id: null,
    pipeline_id: null,
    ...overrides,
  }
}

test('syncLeadStagesFromDdfStatus: policy_id path — already-attached lead moves across pipelines', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: 'POL-001', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-001', status: 'FDPF Pending Reason' }]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
  assert.equal(lead.stage, 'FDPF Pending Reason')
  assert.equal(result.matchedCount, 1)
  assert.deepEqual(result.unmatchedPolicyNumbers, [])
})

test('syncLeadStagesFromDdfStatus: tracking_id path — brand-new lead gets policy_id attached AND stage moved together', async () => {
  // Mirrors the real "policy sold yesterday, not in accounting DB yet" case: the lead
  // has a tracking_id (hashed at form submission) but no policy_id yet.
  const lead = baseLead({ id: 'lead-2', tracking_id: 'POL-002', policy_id: null, pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-002', status: 'FDPF Pending Reason' }]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.policy_id, 'POL-002')
  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
  assert.equal(result.matchedCount, 1)
})

test('syncLeadStagesFromDdfStatus: matches stage name case-insensitively', async () => {
  const lead = baseLead({ id: 'lead-3', policy_id: 'POL-003', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  // carrier-portal's canonical casing differs from the CRM's stored "ACTIVE PLACED - Paid as Advanced"
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-003', status: 'Active Placed - Paid as Advanced' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 15)
  assert.equal(lead.pipeline_id, 2)
})

test('syncLeadStagesFromDdfStatus: a stage name that collides across pipelines resolves to the first match', async () => {
  const lead = baseLead({ id: 'lead-4', policy_id: 'POL-004', pipeline_id: 4, stage_id: 129, stage: 'Pending Manual Action' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  // "Chargeback DQ" exists in both pipeline 1 (id 115, listed first) and pipeline 4 (id 146) —
  // matches the AMAM Correspondence route's own resolution: first match wins, no pipeline preference.
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-004', status: 'Chargeback DQ' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.pipeline_id, 1)
  assert.equal(lead.stage_id, 115)
})

test('syncLeadStagesFromDdfStatus: no matching pipeline_stage leaves stage untouched but still writes policy_id', async () => {
  const lead = baseLead({ id: 'lead-5', tracking_id: 'POL-005', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval', policy_id: null })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-005', status: 'CANNOT BE FOUND IN CARRIER' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 128)
  assert.equal(lead.pipeline_id, 4)
  assert.equal(lead.stage, 'Pending Approval')
  assert.equal(lead.policy_id, 'POL-005')
})

test('syncLeadStagesFromDdfStatus: already up-to-date lead is left alone', async () => {
  const lead = baseLead({ id: 'lead-6', policy_id: 'POL-006', pipeline_id: 1, stage_id: 1, stage: 'FDPF Pending Reason' })
  const snapshot = { ...lead }
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-006', status: 'FDPF Pending Reason' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.deepEqual(lead, snapshot)
})

test('syncLeadStagesFromDdfStatus: a lead matched by policy_id is not reprocessed by the tracking_id path', async () => {
  const lead = baseLead({
    id: 'lead-7',
    tracking_id: 'POL-007', // decrypts (no-op, no key in test env) to the same policy number
    policy_id: 'POL-007',
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-007', status: 'FDPF Pending Reason' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
})

test('syncLeadStagesFromDdfStatus: a policy number matching no lead at all comes back in unmatchedPolicyNumbers', async () => {
  const lead = baseLead({ id: 'lead-8', policy_id: 'POL-008', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [
    { trackingId: 'POL-008', status: 'FDPF Pending Reason' },
    { trackingId: 'POL-DOES-NOT-EXIST', status: 'FDPF Pending Reason' },
  ]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(result.matchedCount, 1)
  assert.deepEqual(result.unmatchedPolicyNumbers, ['POL-DOES-NOT-EXIST'])
})

// ── Edge cases: same-name rows in the carrier file + a lead with a wrong tracking_id ─
//
// Requested by the manager: the carrier file can have two rows for the same insured
// name but different policy numbers (twins, a re-issued policy, etc.), and a CRM lead
// can carry a tracking_id that was captured wrong at form submission (typo/stale value)
// so it decrypts to a policy number that doesn't actually belong to it. Since this
// function never looks at name — matching is exactly policy_id or tracking_id decryption,
// see the file-level doc comment — a same-name coincidence must never cause a guess.
// The wrong-tracking_id lead must come back untouched and its policy number unmatched,
// not force-matched to whichever same-named lead happens to be nearby.

test('syncLeadStagesFromDdfStatus: two same-name rows with different policy numbers, one lead with a wrong tracking_id — both stay unmatched and the lead is untouched', async () => {
  // "John Smith" has two policies in this upload: POL-100 and POL-200. The only CRM
  // lead on file for him has tracking_id 'POL-999' — wrong/mistyped at submission —
  // which matches neither policy number.
  const wrongTrackingLead = baseLead({
    id: 'lead-wrong-tid',
    tracking_id: 'POL-999',
    policy_id: null,
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const snapshot = { ...wrongTrackingLead }
  const ddf = makeFakeDdfClient({ leads: [wrongTrackingLead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [
    { trackingId: 'POL-100', status: 'FDPF Pending Reason' }, // John Smith, policy 1
    { trackingId: 'POL-200', status: 'Pending Lapse' },       // John Smith, policy 2
  ]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.deepEqual(wrongTrackingLead, snapshot)
  assert.equal(result.matchedCount, 0)
  assert.deepEqual(result.unmatchedPolicyNumbers.sort(), ['POL-100', 'POL-200'])
})

test('syncLeadStagesFromDdfStatus: of two same-name rows, only the one with a real match updates — the wrong-tracking_id lead is never substituted in for the other', async () => {
  // Same "John Smith, two policies" setup, but POL-100 does have a real lead (brand
  // new, tracking_id matches exactly). POL-200 has no correct lead — only the
  // wrong-tracking_id lead exists, and it must not be picked as a fallback for it.
  const correctLead = baseLead({
    id: 'lead-correct',
    tracking_id: 'POL-100',
    policy_id: null,
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const wrongTrackingLead = baseLead({
    id: 'lead-wrong-tid',
    tracking_id: 'POL-999',
    policy_id: null,
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const wrongSnapshot = { ...wrongTrackingLead }
  const ddf = makeFakeDdfClient({ leads: [correctLead, wrongTrackingLead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [
    { trackingId: 'POL-100', status: 'FDPF Pending Reason' },
    { trackingId: 'POL-200', status: 'Pending Lapse' },
  ]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(correctLead.policy_id, 'POL-100')
  assert.equal(correctLead.stage_id, 1)
  assert.equal(correctLead.pipeline_id, 1)
  assert.deepEqual(wrongTrackingLead, wrongSnapshot)
  assert.equal(result.matchedCount, 1)
  assert.deepEqual(result.unmatchedPolicyNumbers, ['POL-200'])
})

test('syncLeadStagesFromDdfStatus: matches multiple leads by policy number in one batch', async () => {
  const leadA = baseLead({ id: 'lead-a', policy_id: 'POL-A', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const leadB = baseLead({ id: 'lead-b', tracking_id: 'POL-B', policy_id: null, pipeline_id: 2, stage_id: 12, stage: 'Issued - Pending First Draft' })
  const ddf = makeFakeDdfClient({ leads: [leadA, leadB], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [
    { trackingId: 'POL-A', status: 'FDPF Pending Reason' },
    { trackingId: 'POL-B', status: 'Pending Lapse' },
  ]

  const result = await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(leadA.stage_id, 1)
  assert.equal(leadA.pipeline_id, 1)
  assert.equal(leadB.stage_id, 6)
  assert.equal(leadB.pipeline_id, 1)
  assert.equal(leadB.policy_id, 'POL-B')
  assert.equal(result.matchedCount, 2)
})

// ── findLeadsForPolicyNumbers: the read-only resolver shared by the sync path and
// the unmatched-lead review page ──────────────────────────────────────────────

test('findLeadsForPolicyNumbers: resolves policy_id and tracking_id matches, reports the rest unmatched', async () => {
  const leadA = baseLead({ id: 'lead-a', policy_id: 'POL-A' })
  const leadB = baseLead({ id: 'lead-b', tracking_id: 'POL-B', policy_id: null })
  const ddf = makeFakeDdfClient({ leads: [leadA, leadB], pipeline_stages: PIPELINE_STAGES })

  const result = await findLeadsForPolicyNumbers(ddf as any, ['POL-A', 'POL-B', 'POL-NOWHERE'])

  assert.equal(result.matchedByPolicy.get('POL-A')?.id, 'lead-a')
  assert.equal(result.matchedByPolicy.get('POL-B')?.id, 'lead-b')
  assert.deepEqual(result.unmatchedPolicyNumbers, ['POL-NOWHERE'])
})

test('findLeadsForPolicyNumbers: nothing is written — this is read-only', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: 'POL-1', stage_id: 128, pipeline_id: 4, stage: 'Pending Approval' })
  const snapshot = { ...lead }
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  await findLeadsForPolicyNumbers(ddf as any, ['POL-1'])

  assert.deepEqual(lead, snapshot)
})

test('findLeadsForPolicyNumbers: when both a policy_id lead and a separate tracking_id lead resolve to the same policy number, the policy_id match wins', async () => {
  const policyIdLead = baseLead({ id: 'lead-policy-id', policy_id: 'POL-DUP' })
  const trackingIdLead = baseLead({ id: 'lead-tracking-id', tracking_id: 'POL-DUP', policy_id: null })
  const ddf = makeFakeDdfClient({ leads: [policyIdLead, trackingIdLead], pipeline_stages: PIPELINE_STAGES })

  const result = await findLeadsForPolicyNumbers(ddf as any, ['POL-DUP'])

  assert.equal(result.matchedByPolicy.size, 1)
  assert.equal(result.matchedByPolicy.get('POL-DUP')?.id, 'lead-policy-id')
})

// ── attachPolicyToLeadById: the human-confirmed, by-id write path used by the
// AI-assisted unmatched-lead review page's "Confirm" button ───────────────────

test('attachPolicyToLeadById: writes policy_id and moves stage on the specified lead', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: null, tracking_id: null, pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-1', 'POL-999', 'FDPF Pending Reason')

  assert.equal(result.ok, true)
  assert.equal(lead.policy_id, 'POL-999')
  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
})

test('attachPolicyToLeadById: works even when the lead has an unrelated tracking_id — bypasses the exact-key search entirely', async () => {
  // This is exactly the "wrong tracking_id" scenario the manager's edge-case tests
  // guard against for the automatic sync — but here a human has looked at it and
  // explicitly confirmed the match, so attaching by id must succeed regardless.
  const lead = baseLead({ id: 'lead-1', policy_id: null, tracking_id: 'POL-SOMETHING-ELSE', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-1', 'POL-100', 'Pending Lapse')

  assert.equal(result.ok, true)
  assert.equal(lead.policy_id, 'POL-100')
  assert.equal(lead.stage_id, 6)
})

test('attachPolicyToLeadById: no matching pipeline_stage still writes policy_id', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: null, pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-1', 'POL-100', 'NOT A REAL STAGE')

  assert.equal(result.ok, true)
  assert.equal(lead.policy_id, 'POL-100')
  assert.equal(lead.stage_id, 128)
})

test('attachPolicyToLeadById: unknown lead id returns ok:false and writes nothing', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: null, pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const snapshot = { ...lead }
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-does-not-exist', 'POL-100', null)

  assert.equal(result.ok, false)
  assert.deepEqual(lead, snapshot)
})

test('attachPolicyToLeadById: missing leadId or policyNumber returns ok:false', async () => {
  const ddf = makeFakeDdfClient({ leads: [], pipeline_stages: PIPELINE_STAGES })
  assert.equal((await attachPolicyToLeadById(ddf as any, '', 'POL-100', null)).ok, false)
  assert.equal((await attachPolicyToLeadById(ddf as any, 'lead-1', '', null)).ok, false)
})

test('attachPolicyToLeadById: refuses to overwrite a lead that already has a different policy attached', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: 'POL-ALREADY-CORRECT', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const snapshot = { ...lead }
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-1', 'POL-DIFFERENT', 'FDPF Pending Reason')

  assert.equal(result.ok, false)
  assert.deepEqual(lead, snapshot)
})

test('attachPolicyToLeadById: re-confirming the same policy_id the lead already has still succeeds (idempotent, still moves stage)', async () => {
  const lead = baseLead({ id: 'lead-1', policy_id: 'POL-100', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })

  const result = await attachPolicyToLeadById(ddf as any, 'lead-1', 'POL-100', 'FDPF Pending Reason')

  assert.equal(result.ok, true)
  assert.equal(lead.stage_id, 1)
})
