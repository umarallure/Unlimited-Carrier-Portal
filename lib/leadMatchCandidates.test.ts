import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCandidates, scoreDdfCandidatesFromPool, type ScoredLeadCandidate } from './leadMatchCandidates'
import type { LeadCandidateRow } from './leadNotesSync'
import type { DdfCarrierRecord } from './dealTracker'

function candidate(overrides: Partial<LeadCandidateRow>): LeadCandidateRow {
  return {
    id: 'lead-1',
    first_name: null,
    last_name: null,
    phone: null,
    submission_id: null,
    carrier: null,
    licensed_agent_account: null,
    monthly_premium: null,
    draft_date: null,
    created_at: null,
    ...overrides,
  }
}

function ddfRecord(overrides: Partial<DdfCarrierRecord>): DdfCarrierRecord {
  return {
    id: 'ddf-1',
    insured_name: null,
    lead_vendor: null,
    client_phone_number: null,
    licensed_agent_account: null,
    carrier: 'AMAM',
    draft_date: null,
    tracking_id: null,
    status: null,
    ...overrides,
  }
}

function isoDaysAgo(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

test('scoreCandidates: exact name match scores highest', () => {
  const exact = candidate({ id: 'exact', first_name: 'Diane', last_name: 'Walker' })
  const unrelated = candidate({ id: 'unrelated', first_name: 'John', last_name: 'Smith' })
  const scored = scoreCandidates({ name: 'Diane Walker' }, [unrelated, exact])
  assert.equal(scored[0]?.id, 'exact')
  assert.equal(scored[0]?.score, 100)
})

test('scoreCandidates: name order does not matter ("Last, First" vs "First Last")', () => {
  const c = candidate({ id: 'c1', first_name: 'Raymond', last_name: 'Hart' })
  const scored = scoreCandidates({ name: 'HART, RAYMOND' }, [c])
  assert.equal(scored[0]?.id, 'c1')
  assert.ok(scored[0]!.score >= 80)
})

test('scoreCandidates: same last name, close first name (typo) scores as a fuzzy match', () => {
  const closeTypo = candidate({ id: 'typo', first_name: 'Lekeysha', last_name: 'Jones' })
  const scored = scoreCandidates({ name: 'Lakeysha Jones' }, [closeTypo])
  assert.equal(scored[0]?.id, 'typo')
  assert.ok(scored[0]!.score >= 55)
})

test('scoreCandidates: completely unrelated name scores zero and is excluded, even with matching agent/carrier', () => {
  const unrelated = candidate({
    id: 'unrelated',
    first_name: 'Zachary',
    last_name: 'Nguyen',
    carrier: 'AMAM',
    licensed_agent_account: 'D. Ruiz',
  })
  const scored = scoreCandidates({ name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' }, [unrelated])
  assert.deepEqual(scored, [])
})

test('scoreCandidates: candidates with no name on file are skipped', () => {
  const noName = candidate({ id: 'no-name', first_name: null, last_name: null })
  assert.deepEqual(scoreCandidates({ name: 'Diane Walker' }, [noName]), [])
})

test('scoreCandidates: empty target name returns no candidates', () => {
  const c = candidate({ id: 'c1', first_name: 'Diane', last_name: 'Walker' })
  assert.deepEqual(scoreCandidates({ name: '' }, [c]), [])
  assert.deepEqual(scoreCandidates({ name: null }, [c]), [])
})

// ── agent + carrier bonuses: the AMAM fallback the manager asked for ──────────
// When tracking-id matching itself fails (as it does for AMAM more than other
// carriers), name alone is often ambiguous — agent and carrier corroborate it.

test('scoreCandidates: matching carrier adds a bonus on top of the name score', () => {
  const sameCarrier = candidate({ id: 'same-carrier', first_name: 'Diane', last_name: 'Walker', carrier: 'AMAM' })
  const scored = scoreCandidates({ name: 'Diane Walker', carrier: 'AMAM' }, [sameCarrier])
  assert.equal(scored[0]?.score, 120) // 100 (exact name) + 20 (carrier)
})

test('scoreCandidates: AMAM / ANAM / American Amicable are treated as the same carrier', () => {
  const c = candidate({ id: 'c1', first_name: 'Diane', last_name: 'Walker', carrier: 'American Amicable' })
  const scored = scoreCandidates({ name: 'Diane Walker', carrier: 'AMAM' }, [c])
  assert.equal(scored[0]?.score, 120)
})

test('scoreCandidates: matching writing agent adds a bonus on top of the name score', () => {
  const sameAgent = candidate({ id: 'same-agent', first_name: 'Diane', last_name: 'Walker', licensed_agent_account: 'D. Ruiz' })
  const scored = scoreCandidates({ name: 'Diane Walker', agent: 'D. Ruiz' }, [sameAgent])
  assert.equal(scored[0]?.score, 125) // 100 (exact name) + 25 (agent)
})

test('scoreCandidates: agent and carrier bonuses stack, and can break a tie between two name-ambiguous candidates', () => {
  const wrongTwin = candidate({ id: 'wrong-twin', first_name: 'John', last_name: 'Smith', carrier: 'MOH', licensed_agent_account: 'B. Lee' })
  const rightTwin = candidate({ id: 'right-twin', first_name: 'John', last_name: 'Smith', carrier: 'AMAM', licensed_agent_account: 'D. Ruiz' })
  const scored = scoreCandidates({ name: 'John Smith', agent: 'D. Ruiz', carrier: 'AMAM' }, [wrongTwin, rightTwin])
  assert.equal(scored[0]?.id, 'right-twin')
  assert.equal(scored[0]?.score, 145) // 100 + 20 (carrier) + 25 (agent)
  assert.equal(scored[1]?.score, 100) // name-only match, no bonuses
})

test('scoreCandidates: agent/carrier bonuses never apply when name does not match at all', () => {
  const sameAgentWrongName = candidate({ id: 'c1', first_name: 'Zachary', last_name: 'Nguyen', licensed_agent_account: 'D. Ruiz', carrier: 'AMAM' })
  const scored = scoreCandidates({ name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' }, [sameAgentWrongName])
  assert.deepEqual(scored, [])
})

test('scoreCandidates: results are sorted highest score first and capped at topN', () => {
  const exact = candidate({ id: 'exact', first_name: 'Diane', last_name: 'Walker' })
  const firstLast = candidate({ id: 'first-last', first_name: 'Walker', last_name: 'Diane' }) // swapped, still order-invariant match
  const lastNameOnly = candidate({ id: 'last-only', first_name: 'Someone', last_name: 'Walker' })
  const scored: ScoredLeadCandidate[] = scoreCandidates({ name: 'Diane Walker' }, [lastNameOnly, exact, firstLast], 2)
  assert.equal(scored.length, 2)
  assert.equal(scored[0]?.id, 'exact')
  assert.ok(scored[0]!.score >= scored[1]!.score)
})

// ── scoreDdfCandidatesFromPool: the batch/single-row Ask AI candidate pipeline ─
// carrier + agent + a recent date window are hard requirements here (unlike
// scoreCandidates/scoreDdfCandidates above, where they're soft bonuses) — see
// lib/leadMatchCandidates.ts's block comment for why this was requested.

test('scoreDdfCandidatesFromPool: a name-perfect record for a DIFFERENT agent is excluded entirely', () => {
  const wrongAgent = ddfRecord({ id: 'wrong-agent', insured_name: 'Diane Walker', licensed_agent_account: 'B. Lee', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([wrongAgent], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.deepEqual(candidates, [])
})

test('scoreDdfCandidatesFromPool: matching agent + name within the window is returned, not widened', () => {
  const match = ddfRecord({ id: 'match', insured_name: 'Diane Walker', licensed_agent_account: 'D. Ruiz', draft_date: isoDaysAgo(2) })
  const { candidates, usedWiderWindow } = scoreDdfCandidatesFromPool([match], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'match')
  assert.equal(usedWiderWindow, false)
})

test('scoreDdfCandidatesFromPool: a record with no draft_date on file is NOT excluded by the date window', () => {
  const noDate = ddfRecord({ id: 'no-date', insured_name: 'Diane Walker', licensed_agent_account: 'D. Ruiz', draft_date: null })
  const { candidates, usedWiderWindow } = scoreDdfCandidatesFromPool([noDate], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'no-date')
  assert.equal(usedWiderWindow, false)
})

test('scoreDdfCandidatesFromPool: when target.agent is blank, the agent filter is skipped rather than excluding everything', () => {
  const noAgentOnFile = ddfRecord({ id: 'c1', insured_name: 'Diane Walker', licensed_agent_account: null, draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([noAgentOnFile], { name: 'Diane Walker', agent: null, carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'c1')
})

test('scoreDdfCandidatesFromPool: nothing within 7 days widens to the full pool (up to 10 days) and flags usedWiderWindow', () => {
  const old = ddfRecord({ id: 'old', insured_name: 'Diane Walker', licensed_agent_account: 'D. Ruiz', draft_date: isoDaysAgo(9) })
  const { candidates, usedWiderWindow } = scoreDdfCandidatesFromPool([old], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'old')
  assert.equal(usedWiderWindow, true)
})

test('scoreDdfCandidatesFromPool: the caller is responsible for the 10-day cutoff — records older than that (already excluded from the fetched pool) never surface, and there is no further widening', () => {
  // Simulates what a caller sees when fetchDdfCandidatePool already excluded anything older
  // than 10 days: an empty pool in, an empty (not widened) result out.
  const { candidates, usedWiderWindow } = scoreDdfCandidatesFromPool([], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.deepEqual(candidates, [])
  assert.equal(usedWiderWindow, false)
})

test('scoreDdfCandidatesFromPool: within the 7-day slice, ranking is by name score alone (no carrier/agent bonus) since both are already guaranteed', () => {
  const closerName = ddfRecord({ id: 'closer', insured_name: 'Diane Walker', licensed_agent_account: 'D. Ruiz', draft_date: isoDaysAgo(1) })
  const fuzzierName = ddfRecord({ id: 'fuzzier', insured_name: 'Dianne Walkers', licensed_agent_account: 'D. Ruiz', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([fuzzierName, closerName], { name: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'closer')
  assert.equal(candidates[0]?.score, 100)
})

test('scoreDdfCandidatesFromPool: empty target name returns no candidates', () => {
  const c = ddfRecord({ id: 'c1', insured_name: 'Diane Walker', draft_date: isoDaysAgo(1) })
  assert.deepEqual(scoreDdfCandidatesFromPool([c], { name: '' }).candidates, [])
  assert.deepEqual(scoreDdfCandidatesFromPool([c], { name: null }).candidates, [])
})

// ── full-name-vs-full-name similarity: no token splitting, no first/last separation,
// no suffix awareness — just how close the two whole strings are, as a 0-100 score.
// Replaced the earlier tiered/token approach for this pipeline specifically (see
// fullNameSimilarity in leadMatchCandidates.ts) so a typo or a trailing suffix doesn't
// need its own special-cased tier — it's just a small edit-distance delta either way.

test('fullNameSimilarity (via scoreDdfCandidatesFromPool): a typo anywhere in the full name still scores high', () => {
  const c = ddfRecord({ id: 'c1', insured_name: 'Mike Ross', licensed_agent_account: 'Test Rion', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([c], { name: 'Mike Ros', agent: 'Test Rion', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'c1')
  assert.ok(candidates[0]!.score >= 80, `expected a high score for a one-letter typo, got ${candidates[0]?.score}`)
})

test('fullNameSimilarity: a trailing suffix (Jr) is tolerated without any special-casing, since it is only a few extra characters', () => {
  const c = ddfRecord({ id: 'c1', insured_name: 'Harvey Spectre', licensed_agent_account: 'Test Rion', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([c], { name: 'Harvey Spectre Jr', agent: 'Test Rion', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'c1')
  assert.ok(candidates[0]!.score >= 75, `expected a high score for a suffix-only difference, got ${candidates[0]?.score}`)
})

test('fullNameSimilarity: two genuinely unrelated names still score low, but are not hard-excluded to zero', () => {
  // Important behavioral note: unlike the old tiered system, there is no hard
  // "not even a candidate" cutoff anymore — the AI's own "return null if nothing is
  // plausible" judgment (and the topN cap) is what actually filters weak matches now,
  // not this scoring step.
  const c = ddfRecord({ id: 'c1', insured_name: 'Diane Walker', licensed_agent_account: 'Test Rion', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([c], { name: 'Zachary Nguyen', agent: 'Test Rion', carrier: 'AMAM' })
  assert.equal(candidates[0]?.id, 'c1')
  assert.ok(candidates[0]!.score < 40, `expected a low score for unrelated names, got ${candidates[0]?.score}`)
})

test('fullNameSimilarity: exact full-name match still scores 100', () => {
  const c = ddfRecord({ id: 'c1', insured_name: 'Diane Walker', licensed_agent_account: 'Test Rion', draft_date: isoDaysAgo(1) })
  const { candidates } = scoreDdfCandidatesFromPool([c], { name: 'Diane Walker', agent: 'Test Rion', carrier: 'AMAM' })
  assert.equal(candidates[0]?.score, 100)
})
