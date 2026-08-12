/**
 * Agency → sales agent mapping.
 *
 * There is no agency column on `deal_tracker`, so "filter by agency" is really
 * "filter by the sales agents who belong to that agency". Carrier files spell the
 * same person several ways ("Brandon Flinchum", "BRANDON FLINCHUM",
 * "FLINCHUM, BRANDON", "FLINCHUM/ BRANDON"), so every known spelling is listed —
 * a missing spelling silently drops that agent's policies from the filter.
 *
 * Hardcoded for now. Lifted out of app/deal-tracker/page.tsx so the Policy Audit
 * page filters on exactly the same roster instead of keeping a second copy that
 * would drift the first time someone joins or leaves.
 */

export const AGENCY_AGENT_MAP: Record<string, string[]> = {
  'Unlimited Insurance': [
    'Benjamin Wunder',
    'WUNDER, BENJAMIN',
    'WUNDER/ BENJAMIN M',
    'Claudia Tradardi',
    'TRADARDI NAPOLETANO, CLAUDIA',
    'TRADARDI NAPOLETANO/ CLAU',
    'TRADARDI/ CLAUDIA',
    'Erica Hicks',
    'HICKS/ ERICA L',
    'Lydia Sutton',
    'SUTTON, LYDIA ROSE',
    'SUTTON/ LYDIA R',
  ],
  'Heritage Insurance': [
    '1227642',
    'Abdul Ibrahim',
    'ABDUL IBRAHIM',
    'IBRAHIM, ABDUL',
    'IBRAHIM/ ABDUL',
    'Isaac Reed',
    'ISAAC REED',
    'REED/ ISAAC J',
    'Trinity Queen',
    'TRINITY QUEEN',
    'QUEEN/ TRINITY',
  ],
  'Safe Harbor Insurance': [
    'Andrea Munoz Bonilla',
    'Aubrey Nichols',
    'NICHOLS/ AUBREY',
    'Brandon Flinchum',
    'BRANDON FLINCHUM',
    'FLINCHUM, BRANDON',
    'FLINCHUM/ BRANDON',
    'BROCK/ NOAH',
    'Noah Brock',
    'NOAH BROCK',
    'COLEMAN, AIDAN',
    'COLEMAN/ AIDAN',
    'Maria Sanchez',
    'SANCHEZ SANTIAGO/ MARIA',
  ],
}

export const AGENCY_OPTIONS = Object.keys(AGENCY_AGENT_MAP)

/**
 * Comparison key for a sales agent name: uppercased, punctuation-adjacent
 * whitespace collapsed. Used for in-memory matching only — the server-side
 * filter sends the raw spellings above, because `deal_tracker.sales_agent` is
 * compared exactly there.
 */
export function normalizeAgentName(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
}

/** Every raw agent spelling belonging to the given agencies, de-duplicated. */
export function agentsForAgencies(agencies: string[]): string[] {
  return Array.from(new Set(agencies.flatMap((agency) => AGENCY_AGENT_MAP[agency] ?? [])))
}

/** Normalized lookup set for the given agencies. */
export function agentKeysForAgencies(agencies: string[]): Set<string> {
  return new Set(agentsForAgencies(agencies).map(normalizeAgentName))
}

/**
 * Does this policy's sales agent belong to any of the selected agencies?
 * An empty selection matches everything, so callers can apply it unconditionally.
 */
export function salesAgentMatchesAgencies(salesAgent: unknown, agencies: string[]): boolean {
  if (agencies.length === 0) return true
  const key = normalizeAgentName(salesAgent)
  if (!key) return false
  return agentKeysForAgencies(agencies).has(key)
}

/**
 * Sentinel meaning "an agency and an agent were both chosen but they do not
 * overlap", i.e. the result set must be empty. Matching on a value no
 * sales_agent can hold is how the server-side filter expresses that.
 */
export const NO_MATCH_SENTINEL = '__none__'

/**
 * Collapse an agency selection and an explicit agent selection into the single
 * `sales_agent` filter the server accepts.
 *
 * - agencies only → every agent in those agencies
 * - agents only → those agents
 * - both → the intersection, or NO_MATCH_SENTINEL when it is empty
 * - neither → undefined (no filter)
 */
export function resolveSalesAgentFilter(
  selectedAgencies: string[],
  explicitAgents: string[]
): string | string[] | undefined {
  const agencyAgents = agentsForAgencies(selectedAgencies)

  if (agencyAgents.length > 0 && explicitAgents.length > 0) {
    const allowed = new Set(agencyAgents.map(normalizeAgentName))
    const intersection = explicitAgents.filter((a) => allowed.has(normalizeAgentName(a)))
    if (intersection.length === 0) return NO_MATCH_SENTINEL
    return intersection.length === 1 ? intersection[0] : intersection
  }
  if (agencyAgents.length > 0) return agencyAgents
  if (explicitAgents.length > 0) {
    return explicitAgents.length === 1 ? explicitAgents[0] : explicitAgents
  }
  return undefined
}
