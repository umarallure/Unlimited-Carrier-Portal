import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreCandidates, type ScoredLeadCandidate } from './leadMatchCandidates'
import type { LeadCandidateRow } from './leadNotesSync'

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
