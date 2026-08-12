import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENCY_AGENT_MAP,
  AGENCY_OPTIONS,
  NO_MATCH_SENTINEL,
  agentsForAgencies,
  normalizeAgentName,
  resolveSalesAgentFilter,
  salesAgentMatchesAgencies,
} from './agencyAgents'

/**
 * resolveSalesAgentFilter was lifted verbatim out of app/deal-tracker/page.tsx so
 * Policy Audit could share the roster. These pin the original behaviour — including
 * the empty-intersection sentinel — so the extraction cannot quietly change what
 * Deal Tracker sends to the server.
 */

test('AGENCY_OPTIONS lists the three agencies in map order', () => {
  assert.deepEqual(AGENCY_OPTIONS, ['Unlimited Insurance', 'Heritage Insurance', 'Safe Harbor Insurance'])
})

test('every agency has a non-empty roster', () => {
  for (const [agency, agents] of Object.entries(AGENCY_AGENT_MAP)) {
    assert.ok(agents.length > 0, `${agency} has no agents`)
  }
})

/**
 * Case variants of one name (e.g. 'Abdul Ibrahim' and 'ABDUL IBRAHIM') are listed
 * deliberately — the Deal Tracker server filter matches sales_agent exactly, so
 * each spelling that appears in a carrier file has to be present. They collapse to
 * one key for the in-memory match, which is fine. What must NOT happen is the same
 * person appearing under two different agencies: agency filtering would then be
 * ambiguous and both filters would return them.
 */
test('no agent is claimed by two different agencies', () => {
  const owner = new Map<string, string>()
  const collisions: string[] = []
  for (const [agency, agents] of Object.entries(AGENCY_AGENT_MAP)) {
    for (const agent of agents) {
      const key = normalizeAgentName(agent)
      const existing = owner.get(key)
      if (existing != null && existing !== agency) {
        collisions.push(`"${agent}" is in both ${existing} and ${agency}`)
      }
      owner.set(key, agency)
    }
  }
  assert.deepEqual(collisions, [])
})

// ── normalizeAgentName ─────────────────────────────────────────────────────

test('normalizeAgentName: uppercases, trims, collapses whitespace', () => {
  assert.equal(normalizeAgentName('  Brandon   Flinchum '), 'BRANDON FLINCHUM')
  assert.equal(normalizeAgentName('FLINCHUM/  BRANDON'), 'FLINCHUM/ BRANDON')
  assert.equal(normalizeAgentName(null), '')
  assert.equal(normalizeAgentName(undefined), '')
})

// ── agentsForAgencies ──────────────────────────────────────────────────────

test('agentsForAgencies: unions rosters and de-duplicates', () => {
  const one = agentsForAgencies(['Heritage Insurance'])
  const two = agentsForAgencies(['Heritage Insurance', 'Safe Harbor Insurance'])
  assert.ok(one.includes('Isaac Reed'))
  assert.ok(two.includes('Isaac Reed'))
  assert.ok(two.includes('Brandon Flinchum'))
  assert.equal(two.length, new Set(two).size)
  assert.ok(two.length > one.length)
})

test('agentsForAgencies: unknown agency contributes nothing', () => {
  assert.deepEqual(agentsForAgencies(['Not An Agency']), [])
  assert.deepEqual(agentsForAgencies([]), [])
})

// ── salesAgentMatchesAgencies (Policy Audit, in-memory) ────────────────────

test('salesAgentMatchesAgencies: empty selection matches everything', () => {
  assert.equal(salesAgentMatchesAgencies('Anyone At All', []), true)
  assert.equal(salesAgentMatchesAgencies(null, []), true)
})

test('salesAgentMatchesAgencies: matches every spelling of the same person', () => {
  for (const spelling of ['Brandon Flinchum', 'BRANDON FLINCHUM', 'FLINCHUM, BRANDON', 'FLINCHUM/ BRANDON']) {
    assert.equal(
      salesAgentMatchesAgencies(spelling, ['Safe Harbor Insurance']),
      true,
      `"${spelling}" should match Safe Harbor`
    )
  }
})

test('salesAgentMatchesAgencies: tolerates casing and stray whitespace', () => {
  assert.equal(salesAgentMatchesAgencies('  brandon   flinchum  ', ['Safe Harbor Insurance']), true)
})

test('salesAgentMatchesAgencies: rejects an agent from another agency', () => {
  assert.equal(salesAgentMatchesAgencies('Isaac Reed', ['Safe Harbor Insurance']), false)
  assert.equal(salesAgentMatchesAgencies('Isaac Reed', ['Heritage Insurance']), true)
})

test('salesAgentMatchesAgencies: blank sales_agent never matches a real selection', () => {
  assert.equal(salesAgentMatchesAgencies(null, ['Heritage Insurance']), false)
  assert.equal(salesAgentMatchesAgencies('', ['Heritage Insurance']), false)
  assert.equal(salesAgentMatchesAgencies('   ', ['Heritage Insurance']), false)
})

test('salesAgentMatchesAgencies: multiple agencies match either roster', () => {
  const both = ['Heritage Insurance', 'Safe Harbor Insurance']
  assert.equal(salesAgentMatchesAgencies('Isaac Reed', both), true)
  assert.equal(salesAgentMatchesAgencies('Noah Brock', both), true)
  assert.equal(salesAgentMatchesAgencies('Benjamin Wunder', both), false)
})

// ── resolveSalesAgentFilter (Deal Tracker, server-side) ────────────────────

test('resolveSalesAgentFilter: neither selection -> undefined (no filter)', () => {
  assert.equal(resolveSalesAgentFilter([], []), undefined)
})

test('resolveSalesAgentFilter: agencies only -> the whole roster', () => {
  const out = resolveSalesAgentFilter(['Heritage Insurance'], [])
  assert.deepEqual(out, AGENCY_AGENT_MAP['Heritage Insurance'])
})

test('resolveSalesAgentFilter: single agent -> a bare string, not an array', () => {
  assert.equal(resolveSalesAgentFilter([], ['Isaac Reed']), 'Isaac Reed')
})

test('resolveSalesAgentFilter: several agents -> an array', () => {
  assert.deepEqual(resolveSalesAgentFilter([], ['Isaac Reed', 'Trinity Queen']), ['Isaac Reed', 'Trinity Queen'])
})

test('resolveSalesAgentFilter: both -> the intersection', () => {
  const out = resolveSalesAgentFilter(['Heritage Insurance'], ['Isaac Reed', 'Brandon Flinchum'])
  assert.equal(out, 'Isaac Reed') // Brandon is Safe Harbor, so he drops out
})

test('resolveSalesAgentFilter: intersection is case-insensitive', () => {
  assert.equal(resolveSalesAgentFilter(['Heritage Insurance'], ['isaac reed']), 'isaac reed')
})

test('resolveSalesAgentFilter: empty intersection -> the no-match sentinel', () => {
  const out = resolveSalesAgentFilter(['Heritage Insurance'], ['Brandon Flinchum'])
  assert.equal(out, NO_MATCH_SENTINEL)
  assert.equal(out, '__none__') // the literal Deal Tracker relied on
})

test('resolveSalesAgentFilter: unknown agency with agents behaves as agents-only', () => {
  assert.equal(resolveSalesAgentFilter(['Not An Agency'], ['Isaac Reed']), 'Isaac Reed')
})
