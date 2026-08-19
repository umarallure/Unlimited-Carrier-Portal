/**
 * Scoring logic for the AI-assisted match review — used in two places:
 *   - scoreCandidates: ranks unattached CRM leads (lib/leadNotesSync.ts's
 *     fetchUnattachedLeadCandidates) against a deal_tracker policy that failed the
 *     exact policy_id/tracking_id match (the "Unmatched Leads" review page).
 *   - scoreDdfCandidates: ranks daily_deal_flow records (lib/dealTracker.ts's
 *     getDdfRecordsForCarrier) against a policy that failed the upload-time DDF
 *     name matcher (the "Incomplete" rows in the verification dialog).
 *
 * Both score on name, writing agent, and carrier. The weighting mirrors two
 * existing matchers in INSURVAS-CRM (name 50 / phone 80 / carrier 20 in
 * lib/agentCommissions/ddfPopulation.ts's scoreLaCommissionFallback, and the
 * identical scoreMatch in LeadsInformationPage.tsx) — same "exact key fails, fall
 * back to a scored name+corroborating-signal match" shape. Phone isn't used here
 * though: a deal_tracker policy only gets a phone number *from* a successful DDF
 * match, which is exactly what failed for these policies. Writing agent stands in
 * for phone's role as the corroborating signal instead — deliberately requested
 * for carriers like AMAM where name/tracking-id matching itself frequently fails.
 *
 * Name uses the same normalization/fuzzy-matching primitives lib/dealTracker.ts
 * already uses for DDF name matching (normalizeNameForSearch, extractNameParts,
 * editDistance) rather than a second matching algorithm, and is required — a
 * candidate with zero name relation is excluded even if agent and carrier match,
 * since "same agent, same carrier" alone matches dozens of unrelated clients.
 * Deliberately more permissive than the upload-time matcher's own tiers (which
 * require both name parts to correspond): this only ranks candidates for display
 * and for narrowing what gets sent to the AI suggestion call, with a human (and
 * the AI's own judgment) reviewing the result — it never decides a match by
 * itself, and nothing here writes anything.
 */
import { normalizeNameForSearch, extractNameParts, editDistance } from './dealTracker'
import type { LeadCandidateRow } from './leadNotesSync'
import type { DdfCarrierRecord } from './dealTracker'

export type ScoredLeadCandidate = LeadCandidateRow & { score: number }
export type ScoredDdfCandidate = DdfCarrierRecord & { score: number }

export type MatchTarget = {
  name: string | null | undefined
  agent?: string | null | undefined
  carrier?: string | null | undefined
}

const CARRIER_MATCH_BONUS = 20
const AGENT_MATCH_BONUS = 25

/** AMAM / ANAM / American Amicable are the same carrier under different labels across sources. */
const AMAM_ALIASES = ['amam', 'anam', 'american amicable']

function normalizeForCompare(value: string | null | undefined): string {
  return normalizeNameForSearch(value ?? '').toLowerCase()
}

function carriersMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  if (!na || !nb) return false
  if (na === nb || na.includes(nb) || nb.includes(na)) return true
  const aIsAmam = AMAM_ALIASES.some((alias) => na.includes(alias))
  const bIsAmam = AMAM_ALIASES.some((alias) => nb.includes(alias))
  return aIsAmam && bIsAmam
}

function agentsMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeForCompare(a)
  const nb = normalizeForCompare(b)
  return Boolean(na) && na === nb
}

/** Core name-similarity scorer, shape-agnostic — both callers reduce their candidate to a plain full-name string first. */
function nameScoreForNames(targetName: string, candidateFullName: string): number {
  const targetNormalized = normalizeNameForSearch(targetName)
  if (!targetNormalized) return 0
  const targetParts = extractNameParts(targetName.trim())

  const normalizedCandidate = normalizeNameForSearch(candidateFullName)
  if (!normalizedCandidate) return 0
  const candidateParts = extractNameParts(normalizedCandidate)

  if (normalizedCandidate.toLowerCase() === targetNormalized.toLowerCase()) return 100
  if (
    targetParts.firstName &&
    targetParts.lastName &&
    candidateParts.firstLastKey &&
    candidateParts.firstLastKey === targetParts.firstLastKey
  ) {
    return 80
  }
  if (targetParts.lastName && candidateParts.lastName && candidateParts.lastName.toLowerCase() === targetParts.lastName.toLowerCase()) {
    const firstDist =
      targetParts.firstName && candidateParts.firstName
        ? editDistance(targetParts.firstName.toLowerCase(), candidateParts.firstName.toLowerCase())
        : null
    return firstDist != null && firstDist <= 2 ? 55 : 30
  }
  if (targetParts.firstName && candidateParts.firstName && candidateParts.firstName.toLowerCase() === targetParts.firstName.toLowerCase()) {
    return 25
  }
  if (targetParts.firstName && targetParts.lastName && candidateParts.firstName && candidateParts.lastName) {
    const firstDist = editDistance(targetParts.firstName.toLowerCase(), candidateParts.firstName.toLowerCase())
    const lastDist = editDistance(targetParts.lastName.toLowerCase(), candidateParts.lastName.toLowerCase())
    if (firstDist <= 2 && lastDist <= 2) return 45
  }
  return 0
}

/**
 * Score and rank unattached CRM leads for `target`. Name match is required (score 0
 * candidates are dropped); agent and carrier matches add corroborating bonus points
 * on top so a name-ambiguous case (e.g. two "John Smith"s) can still be
 * disambiguated.
 */
export function scoreCandidates(target: MatchTarget, candidates: LeadCandidateRow[], topN = 5): ScoredLeadCandidate[] {
  if (!target.name || candidates.length === 0) return []

  const scored: ScoredLeadCandidate[] = []
  for (const c of candidates) {
    const candidateFullName = [c.first_name, c.last_name].filter(Boolean).join(' ')
    const base = nameScoreForNames(target.name, candidateFullName)
    if (base <= 0) continue
    let score = base
    if (carriersMatch(target.carrier, c.carrier)) score += CARRIER_MATCH_BONUS
    if (agentsMatch(target.agent, c.licensed_agent_account)) score += AGENT_MATCH_BONUS
    scored.push({ ...c, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN)
}

/**
 * Score and rank daily_deal_flow records for `target` — same weighting as
 * scoreCandidates, adapted for DDF's single combined insured_name field instead of
 * split first/last.
 */
export function scoreDdfCandidates(target: MatchTarget, candidates: DdfCarrierRecord[], topN = 5): ScoredDdfCandidate[] {
  if (!target.name || candidates.length === 0) return []

  const scored: ScoredDdfCandidate[] = []
  for (const c of candidates) {
    const base = nameScoreForNames(target.name, c.insured_name ?? '')
    if (base <= 0) continue
    let score = base
    if (carriersMatch(target.carrier, c.carrier)) score += CARRIER_MATCH_BONUS
    if (agentsMatch(target.agent, c.licensed_agent_account)) score += AGENT_MATCH_BONUS
    scored.push({ ...c, score })
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN)
}
