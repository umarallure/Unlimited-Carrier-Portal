import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  syncLeadStagesFromDdfStatus,
  resolvePreferredStage,
  buildLeadStageUpdate,
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
  submission_id: string | null
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
 *   from(t).select(cols).in(col, vals)         (leads by submission_id)
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
    submission_id: null,
    tracking_id: null,
    policy_id: null,
    stage: null,
    stage_id: null,
    pipeline_id: null,
    ...overrides,
  }
}

test('syncLeadStagesFromDdfStatus: moves a lead across pipelines to reach the target stage (Transfer -> Chargeback)', async () => {
  const lead = baseLead({ id: 'lead-1', tracking_id: 'POL-001', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-001', status: 'FDPF Pending Reason', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
  assert.equal(lead.stage, 'FDPF Pending Reason')
  assert.equal(lead.policy_id, 'POL-001')
})

test('syncLeadStagesFromDdfStatus: matches stage name case-insensitively', async () => {
  const lead = baseLead({ id: 'lead-2', tracking_id: 'POL-002', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  // carrier-portal's canonical casing differs from the CRM's stored "ACTIVE PLACED - Paid as Advanced"
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-002', status: 'Active Placed - Paid as Advanced', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 15)
  assert.equal(lead.pipeline_id, 2)
})

test('syncLeadStagesFromDdfStatus: a stage name that collides across pipelines resolves to the first match', async () => {
  const lead = baseLead({ id: 'lead-3', tracking_id: 'POL-003', pipeline_id: 4, stage_id: 129, stage: 'Pending Manual Action' })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  // "Chargeback DQ" exists in both pipeline 1 (id 115, listed first) and pipeline 4 (id 146) —
  // matches the AMAM Correspondence route's own resolution: first match wins, no pipeline preference.
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-003', status: 'Chargeback DQ', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.pipeline_id, 1)
  assert.equal(lead.stage_id, 115)
})

test('syncLeadStagesFromDdfStatus: no matching pipeline_stage leaves stage untouched but still writes policy_id', async () => {
  const lead = baseLead({ id: 'lead-4', tracking_id: 'POL-004', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval', policy_id: null })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-004', status: 'CANNOT BE FOUND IN CARRIER', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 128)
  assert.equal(lead.pipeline_id, 4)
  assert.equal(lead.stage, 'Pending Approval')
  assert.equal(lead.policy_id, 'POL-004')
})

test('syncLeadStagesFromDdfStatus: already up-to-date lead is left alone', async () => {
  const lead = baseLead({ id: 'lead-5', tracking_id: 'POL-005', pipeline_id: 1, stage_id: 1, stage: 'FDPF Pending Reason', policy_id: 'POL-005' })
  const snapshot = { ...lead }
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-005', status: 'FDPF Pending Reason', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.deepEqual(lead, snapshot)
})

test('syncLeadStagesFromDdfStatus: matches a lead by policy_id when tracking_id and submission_id are both null', async () => {
  // Mirrors a real production case: a lead already self-healed/attached via
  // CRM Sync Operations or Pipeline Audit has policy_id set directly but no
  // tracking_id to decrypt and no submission_id — previously invisible to
  // this function entirely, silently scanning 0 matches.
  const lead = baseLead({
    id: 'lead-7',
    submission_id: null,
    tracking_id: null,
    policy_id: 'POL-9000003',
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-9000003', status: 'FDPF Pending Reason', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
  assert.equal(lead.stage, 'FDPF Pending Reason')
})

test('syncLeadStagesFromDdfStatus: policy_id match does not get reprocessed by the tracking_id path', async () => {
  const lead = baseLead({
    id: 'lead-8',
    submission_id: null,
    tracking_id: 'POL-008', // decrypts (no-op, no key in test env) to the same policy number
    policy_id: 'POL-008',
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-008', status: 'FDPF Pending Reason', submissionId: null }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 1)
  assert.equal(lead.pipeline_id, 1)
})

test('syncLeadStagesFromDdfStatus: submission_id path is preferred and prevents double-processing via tracking_id path', async () => {
  const lead = baseLead({
    id: 'lead-6',
    submission_id: 'sub-6',
    tracking_id: 'POL-006',
    pipeline_id: 4,
    stage_id: 128,
    stage: 'Pending Approval',
  })
  const ddf = makeFakeDdfClient({ leads: [lead], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [{ trackingId: 'POL-006', status: 'Pending Lapse', submissionId: 'sub-6' }]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(lead.stage_id, 6)
  assert.equal(lead.pipeline_id, 1)
})

test('syncLeadStagesFromDdfStatus: matches multiple leads by policy number in one batch', async () => {
  const leadA = baseLead({ id: 'lead-a', tracking_id: 'POL-A', pipeline_id: 4, stage_id: 128, stage: 'Pending Approval' })
  const leadB = baseLead({ id: 'lead-b', tracking_id: 'POL-B', pipeline_id: 2, stage_id: 12, stage: 'Issued - Pending First Draft' })
  const ddf = makeFakeDdfClient({ leads: [leadA, leadB], pipeline_stages: PIPELINE_STAGES })
  const updates: DdfStatusStageSync[] = [
    { trackingId: 'POL-A', status: 'FDPF Pending Reason', submissionId: null },
    { trackingId: 'POL-B', status: 'Pending Lapse', submissionId: null },
  ]

  await syncLeadStagesFromDdfStatus(ddf as any, updates)

  assert.equal(leadA.stage_id, 1)
  assert.equal(leadA.pipeline_id, 1)
  assert.equal(leadB.stage_id, 6)
  assert.equal(leadB.pipeline_id, 1)
})
