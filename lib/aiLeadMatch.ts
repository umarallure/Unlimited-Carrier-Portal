/**
 * AI-assisted match suggestions for the two places this app's automatic matchers
 * give up and leave a human to search by hand — mirrors INSURVAS-CRM's
 * lib/qaCoaching/matchDeal.ts — same NVIDIA provider, same JSON schema shape,
 * same hallucination guard — since that's this org's established pattern for
 * "let an LLM break a tie among scored candidates."
 *
 * Two entry points, same underlying signals (name + writing agent + carrier) and
 * the same never-writes-anything contract:
 *
 * - suggestLeadMatch — for app/api/deal-tracker/suggest-lead-match/route.ts. The
 *   exact-key matcher (policy_id / decrypted tracking_id — see
 *   findLeadsForPolicyNumbers in lib/leadNotesSync.ts) already ran and found
 *   nothing. Only proposes a leadId; the actual write happens after a human
 *   clicks confirm, via attachPolicyToLeadById.
 * - suggestDdfMatch — for app/api/deal-tracker/suggest-ddf-match/route.ts. The
 *   upload-time DDF name matcher (matchDdfNamesToRecords) already ran and found
 *   nothing for this policy — this is the "Incomplete" case in the verification
 *   dialog. Only proposes a daily_deal_flow record id; "using" it just fills the
 *   row's Call Center/Phone/Effective Date inputs, the same as picking one by
 *   hand from the existing candidate list.
 */
import { nvidiaChat, nvidiaConfigured } from './nvidia'
import { fireworksChat, fireworksConfigured, extractJson } from './fireworks'

/**
 * Provider switch — set AI_MATCH_PROVIDER=fireworks in .env.local to compare
 * against NVIDIA's build.nvidia.com endpoint (default), which has had inconsistent
 * gateway latency (see lib/nvidia.ts). Both clients share the same request/response
 * shape, so nothing else in this file needs to know which one is active.
 */
function activeProvider(): 'nvidia' | 'fireworks' {
  return process.env.AI_MATCH_PROVIDER?.trim().toLowerCase() === 'fireworks' ? 'fireworks' : 'nvidia'
}

export function aiMatchConfigured(): boolean {
  return activeProvider() === 'fireworks' ? fireworksConfigured() : nvidiaConfigured()
}

async function runMatchChat(system: string, user: string, maxTokens: number): Promise<{ content: string }> {
  return activeProvider() === 'fireworks'
    ? fireworksChat(system, user, maxTokens)
    : nvidiaChat(system, user, maxTokens)
}

/** Injectable in tests so the guard/parsing logic can be verified without a real network call. */
export type MatchChatFn = (system: string, user: string, maxTokens: number) => Promise<{ content: string }>


/** Shared response shape both prompts ask for — only the id field name differs per caller. */
type ParsedMatchResponse = {
  selectedId: string | null
  confidence: number
  matchedName: boolean
  matchedAgent: boolean
  matchedCarrier: boolean
  reasoning: string
}

const RESPONSE_SHAPE_INSTRUCTIONS = [
  'Respond with ONLY a JSON object of this exact shape:',
  '{"selected_id": string|null, "confidence": number between 0 and 1, "matched_name": boolean, "matched_agent": boolean, "matched_carrier": boolean, "reason": string}',
  '"reason" is one short sentence.',
].join(' ')

function parseMatchResponse(content: string, allowedIds: Set<string>): ParsedMatchResponse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(extractJson(content))
  } catch {
    console.error('[aiLeadMatch] response was not valid JSON:', content.slice(0, 200))
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const obj = parsed as Record<string, unknown>

  const rawId = typeof obj.selected_id === 'string' && obj.selected_id.trim() ? obj.selected_id.trim() : null
  // Hallucination guard, same as INSURVAS-CRM's selectDeal: an id outside the
  // supplied candidates is discarded, never trusted.
  const selectedId = rawId && allowedIds.has(rawId) ? rawId : null
  if (rawId && !selectedId) {
    console.error('[aiLeadMatch] model returned an id not in the candidate list:', rawId)
  }

  const rawConfidence = typeof obj.confidence === 'number' ? obj.confidence : 0
  const confidence = selectedId ? Math.min(1, Math.max(0, rawConfidence)) : 0

  return {
    selectedId,
    confidence,
    matchedName: selectedId != null && obj.matched_name === true,
    matchedAgent: selectedId != null && obj.matched_agent === true,
    matchedCarrier: selectedId != null && obj.matched_carrier === true,
    reasoning: typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'No reasoning provided.',
  }
}

export type LeadMatchTarget = {
  policyNumber: string
  name: string | null
  carrier: string | null
  agent: string | null
}

export type LeadMatchCandidate = {
  leadId: string
  firstName: string | null
  lastName: string | null
  agent: string | null
  carrier: string | null
}

export type LeadMatchSuggestion = {
  leadId: string | null
  confidence: number
  matchedName: boolean
  matchedAgent: boolean
  matchedCarrier: boolean
  reasoning: string
}

const LEAD_MATCH_SYSTEM_PROMPT = [
  'Choose the CRM lead that this issued insurance policy belongs to.',
  'An exact policy-number match already ran and found nothing for this policy — for some carriers (e.g. AMAM) the tracking id captured at lead intake frequently does not decrypt-match the carrier\'s own policy number, so this is expected, not suspicious.',
  'Base the decision only on the supplied name, writing agent, and carrier. Consider nicknames, misspellings, and transposed first/last names when comparing names. Do not guess: if no candidate is a plausible match, return null.',
  'selected_id must be one of the supplied candidate ids, or null.',
  RESPONSE_SHAPE_INSTRUCTIONS,
].join(' ')

/**
 * Ask the LLM to suggest which candidate lead matches `target`. Returns null (not a
 * zero-confidence suggestion) on any failure — missing key, network error, a
 * response that doesn't parse, or a selected id outside the candidate list — so
 * the caller falls back to "AI unavailable, pick manually" instead of surfacing a
 * bad guess.
 */
export async function suggestLeadMatch(
  target: LeadMatchTarget,
  candidates: LeadMatchCandidate[],
  chat: MatchChatFn = runMatchChat
): Promise<LeadMatchSuggestion | null> {
  if (!aiMatchConfigured()) return null
  if (candidates.length === 0) {
    return {
      leadId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'No unattached CRM leads with a similar name were found.',
    }
  }

  const userMessage = JSON.stringify({
    policy: {
      policy_number: target.policyNumber,
      insured_name: target.name,
      carrier: target.carrier,
      writing_agent: target.agent,
    },
    candidates: candidates.map((c) => ({
      id: c.leadId,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
      agent: c.agent,
      carrier: c.carrier,
    })),
  })

  try {
    // 400 previously truncated valid JSON on harder disambiguation cases (e.g. two candidates
    // sharing the same corrected name from separate policies) — the model would run out of budget
    // mid-string (e.g. `{"selected_id":"5817c334-`), fail to parse, and silently report no match
    // even though it was one token away from a correct, high-confidence answer.
    const { content } = await chat(LEAD_MATCH_SYSTEM_PROMPT, userMessage, 800)
    const parsed = parseMatchResponse(content, new Set(candidates.map((c) => c.leadId)))
    if (!parsed) return null
    return {
      leadId: parsed.selectedId,
      confidence: parsed.confidence,
      matchedName: parsed.matchedName,
      matchedAgent: parsed.matchedAgent,
      matchedCarrier: parsed.matchedCarrier,
      reasoning: parsed.reasoning,
    }
  } catch (e) {
    console.error('[aiLeadMatch] request error:', e instanceof Error ? e.message : e)
    return null
  }
}

export type DdfMatchTarget = {
  name: string | null
  carrier: string | null
  agent: string | null
}

export type DdfMatchCandidate = {
  recordId: string
  insuredName: string | null
  agent: string | null
  carrier: string | null
}

export type DdfMatchSuggestion = {
  recordId: string | null
  confidence: number
  matchedName: boolean
  matchedAgent: boolean
  matchedCarrier: boolean
  reasoning: string
}

const DDF_MATCH_SYSTEM_PROMPT = [
  'Choose the Daily Deal Flow (DDF) record — the original lead submission — that this issued insurance policy came from.',
  'The upload-time name matcher already ran and found nothing for this policy: no exact name, no order-invariant first+last, and no fuzzy match within edit distance 2 on both names. These candidates come from a looser, human-reviewed search, so weigh name similarity carefully — consider nicknames, misspellings, and transposed first/last names, but do not force a pick.',
  'Base the decision only on the supplied name, writing agent, and carrier. Do not guess: if no candidate is a plausible match, return null.',
  'selected_id must be one of the supplied candidate ids, or null.',
  RESPONSE_SHAPE_INSTRUCTIONS,
].join(' ')

/**
 * Ask the LLM to suggest which DDF candidate this policy's insured name/agent/carrier
 * belongs to. Same contract as suggestLeadMatch: never writes anything, returns null
 * (not a zero-confidence suggestion) on any failure so the caller falls back to
 * manual review.
 */
export async function suggestDdfMatch(
  target: DdfMatchTarget,
  candidates: DdfMatchCandidate[],
  chat: MatchChatFn = runMatchChat
): Promise<DdfMatchSuggestion | null> {
  if (!aiMatchConfigured()) return null
  if (candidates.length === 0) {
    return {
      recordId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'No Daily Deal Flow candidates were found for this name/carrier.',
    }
  }

  const userMessage = JSON.stringify({
    policy: {
      insured_name: target.name,
      carrier: target.carrier,
      writing_agent: target.agent,
    },
    candidates: candidates.map((c) => ({
      id: c.recordId,
      name: c.insuredName,
      agent: c.agent,
      carrier: c.carrier,
    })),
  })

  try {
    // See the matching comment in suggestLeadMatch — 400 tokens was too tight and truncated valid
    // JSON mid-string on harder disambiguation cases, silently producing "no match" for candidates
    // the model had actually already selected correctly.
    const { content } = await chat(DDF_MATCH_SYSTEM_PROMPT, userMessage, 800)
    const parsed = parseMatchResponse(content, new Set(candidates.map((c) => c.recordId)))
    if (!parsed) return null
    return {
      recordId: parsed.selectedId,
      confidence: parsed.confidence,
      matchedName: parsed.matchedName,
      matchedAgent: parsed.matchedAgent,
      matchedCarrier: parsed.matchedCarrier,
      reasoning: parsed.reasoning,
    }
  } catch (e) {
    console.error('[aiLeadMatch] request error:', e instanceof Error ? e.message : e)
    return null
  }
}
