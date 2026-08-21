import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  suggestLeadMatch,
  suggestDdfMatch,
  aiMatchConfigured,
  type LeadMatchTarget,
  type LeadMatchCandidate,
  type DdfMatchTarget,
  type DdfMatchCandidate,
  type MatchChatFn,
} from './aiLeadMatch'
import { extractJson } from './fireworks'

// ── env isolation ───────────────────────────────────────────────────────────
// aiMatchConfigured()/the provider switch read process.env directly (no caching),
// so every test that touches these vars must restore the originals afterward —
// this suite would otherwise leak state into whichever other test file runs next
// in the same process, and vice versa depending on real .env/.env.local values.

const ENV_KEYS = ['NVIDIA_API_KEY', 'FIREWORKS_API_KEY', 'AI_MATCH_PROVIDER'] as const

function withEnv<T>(vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) {
    const value = vars[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

async function withEnvAsync<T>(
  vars: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
  fn: () => Promise<T>
): Promise<T> {
  const saved: Record<string, string | undefined> = {}
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  for (const key of ENV_KEYS) {
    const value = vars[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  }
}

const CONFIGURED_ENV = { NVIDIA_API_KEY: 'test-nvidia-key', FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: undefined }

// ── test fixtures ───────────────────────────────────────────────────────────

const leadTarget: LeadMatchTarget = {
  policyNumber: 'POL-1',
  name: 'Diane Walker',
  carrier: 'AMAM',
  agent: 'D. Ruiz',
}

const leadCandidates: LeadMatchCandidate[] = [
  { leadId: 'lead-1', firstName: 'Diane', lastName: 'Walker', agent: 'D. Ruiz', carrier: 'AMAM' },
  { leadId: 'lead-2', firstName: 'John', lastName: 'Smith', agent: 'Other', carrier: 'MOH' },
]

const ddfTarget: DdfMatchTarget = { name: 'Diane Walker', carrier: 'AMAM', agent: 'D. Ruiz' }

const ddfCandidates: DdfMatchCandidate[] = [
  { recordId: 'ddf-1', insuredName: 'Diane Walker', agent: 'D. Ruiz', carrier: 'AMAM' },
  { recordId: 'ddf-2', insuredName: 'John Smith', agent: 'Other', carrier: 'MOH' },
]

function jsonChat(payload: unknown): MatchChatFn {
  return async () => ({ content: JSON.stringify(payload) })
}

function rawChat(content: string): MatchChatFn {
  return async () => ({ content })
}

function throwingChat(error: unknown): MatchChatFn {
  return async () => {
    throw error
  }
}

function unreachableChat(): MatchChatFn {
  return async () => {
    throw new Error('chat should not have been called')
  }
}

// ── aiMatchConfigured / provider switch ─────────────────────────────────────

test('aiMatchConfigured: false when neither provider key is set', () => {
  withEnv({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: undefined }, () => {
    assert.equal(aiMatchConfigured(), false)
  })
})

test('aiMatchConfigured: defaults to nvidia when AI_MATCH_PROVIDER is unset', () => {
  withEnv({ NVIDIA_API_KEY: 'k', FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: undefined }, () => {
    assert.equal(aiMatchConfigured(), true)
  })
  withEnv({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: 'k', AI_MATCH_PROVIDER: undefined }, () => {
    assert.equal(aiMatchConfigured(), false) // fireworks key alone doesn't count while nvidia is the active provider
  })
})

test('aiMatchConfigured: AI_MATCH_PROVIDER=fireworks switches which key is checked', () => {
  withEnv({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: 'k', AI_MATCH_PROVIDER: 'fireworks' }, () => {
    assert.equal(aiMatchConfigured(), true)
  })
  withEnv({ NVIDIA_API_KEY: 'k', FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: 'fireworks' }, () => {
    assert.equal(aiMatchConfigured(), false) // nvidia key alone doesn't count while fireworks is the active provider
  })
})

test('aiMatchConfigured: AI_MATCH_PROVIDER is case/whitespace-insensitive', () => {
  withEnv({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: 'k', AI_MATCH_PROVIDER: '  Fireworks  ' }, () => {
    assert.equal(aiMatchConfigured(), true)
  })
})

test('aiMatchConfigured: an unrecognized AI_MATCH_PROVIDER value falls back to nvidia', () => {
  withEnv({ NVIDIA_API_KEY: 'k', FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: 'openrouter' }, () => {
    assert.equal(aiMatchConfigured(), true)
  })
})

// ── not configured -> null, never calls the model ───────────────────────────

test('suggestLeadMatch: returns null and never calls chat when AI is not configured', async () => {
  await withEnvAsync({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: undefined }, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, unreachableChat())
    assert.equal(result, null)
  })
})

test('suggestDdfMatch: returns null and never calls chat when AI is not configured', async () => {
  await withEnvAsync({ NVIDIA_API_KEY: undefined, FIREWORKS_API_KEY: undefined, AI_MATCH_PROVIDER: undefined }, async () => {
    const result = await suggestDdfMatch(ddfTarget, ddfCandidates, unreachableChat())
    assert.equal(result, null)
  })
})

// ── empty candidate pool -> short-circuit response, no model call ──────────

test('suggestLeadMatch: empty candidate list short-circuits to a "no candidates" suggestion without calling chat', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, [], unreachableChat())
    assert.deepEqual(result, {
      leadId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'No unattached CRM leads with a similar name were found.',
    })
  })
})

test('suggestDdfMatch: empty candidate list short-circuits to a "no candidates" suggestion without calling chat', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestDdfMatch(ddfTarget, [], unreachableChat())
    assert.deepEqual(result, {
      recordId: null,
      confidence: 0,
      matchedName: false,
      matchedAgent: false,
      matchedCarrier: false,
      reasoning: 'No Daily Deal Flow candidates were found for this name/carrier.',
    })
  })
})

// ── happy path ───────────────────────────────────────────────────────────────

test('suggestLeadMatch: a valid response selecting a real candidate is returned as-is', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({
      selected_id: 'lead-1',
      confidence: 0.87,
      matched_name: true,
      matched_agent: true,
      matched_carrier: true,
      reason: 'Exact name, agent, and carrier match.',
    })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.deepEqual(result, {
      leadId: 'lead-1',
      confidence: 0.87,
      matchedName: true,
      matchedAgent: true,
      matchedCarrier: true,
      reasoning: 'Exact name, agent, and carrier match.',
    })
  })
})

test('suggestDdfMatch: a valid response selecting a real candidate is returned as-is', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({
      selected_id: 'ddf-1',
      confidence: 0.6,
      matched_name: true,
      matched_agent: false,
      matched_carrier: true,
      reason: 'Name and carrier match, agent differs.',
    })
    const result = await suggestDdfMatch(ddfTarget, ddfCandidates, chat)
    assert.deepEqual(result, {
      recordId: 'ddf-1',
      confidence: 0.6,
      matchedName: true,
      matchedAgent: false,
      matchedCarrier: true,
      reasoning: 'Name and carrier match, agent differs.',
    })
  })
})

test('suggestLeadMatch: the model explicitly declining (selected_id: null) is passed through, not treated as an error', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: null, confidence: 0.9, matched_name: false, reason: 'No plausible candidate.' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.leadId, null)
    // confidence is forced to 0 even though the model returned 0.9 — see below.
    assert.equal(result?.confidence, 0)
    assert.equal(result?.reasoning, 'No plausible candidate.')
  })
})

// ── hallucination guard: the whole point of this file ───────────────────────

test('suggestLeadMatch: an id outside the candidate list is discarded, not trusted', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({
      selected_id: 'lead-does-not-exist',
      confidence: 0.99,
      matched_name: true,
      matched_agent: true,
      matched_carrier: true,
      reason: 'Confident match.',
    })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.leadId, null)
    assert.equal(result?.confidence, 0)
    assert.equal(result?.matchedName, false)
    assert.equal(result?.matchedAgent, false)
    assert.equal(result?.matchedCarrier, false)
  })
})

test('suggestDdfMatch: an id outside the candidate list is discarded, not trusted', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: 'ddf-does-not-exist', confidence: 1, matched_name: true, reason: 'x' })
    const result = await suggestDdfMatch(ddfTarget, ddfCandidates, chat)
    assert.equal(result?.recordId, null)
    assert.equal(result?.confidence, 0)
  })
})

test('suggestLeadMatch: matched_* flags are forced false when no id was actually selected, even if the model set them true', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: null, matched_name: true, matched_agent: true, matched_carrier: true, reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.matchedName, false)
    assert.equal(result?.matchedAgent, false)
    assert.equal(result?.matchedCarrier, false)
  })
})

// ── confidence clamping ──────────────────────────────────────────────────────

test('suggestLeadMatch: confidence above 1 is clamped to 1', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: 'lead-1', confidence: 5, reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.confidence, 1)
  })
})

test('suggestLeadMatch: negative confidence is clamped to 0', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: 'lead-1', confidence: -3, reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.confidence, 0)
  })
})

test('suggestLeadMatch: a non-numeric confidence defaults to 0', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: 'lead-1', confidence: 'high', reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.confidence, 0)
  })
})

// ── malformed / unexpected model output ─────────────────────────────────────

test('suggestLeadMatch: unparseable JSON returns null', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat('not json at all'))
    assert.equal(result, null)
  })
})

test('suggestLeadMatch: a JSON array (valid JSON, no selected_id field) is treated as no selection, not a hard failure', async () => {
  // typeof [] === 'object' in JS, so this passes the object check but has no
  // selected_id property — same as an explicit "no match" response.
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat('["lead-1"]'))
    assert.equal(result?.leadId, null)
    assert.equal(result?.confidence, 0)
  })
})

test('suggestLeadMatch: a JSON null response body returns null (fails the object check)', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat('null'))
    assert.equal(result, null)
  })
})

test('suggestLeadMatch: a bare JSON string (valid JSON, wrong shape) returns null', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat('"lead-1"'))
    assert.equal(result, null)
  })
})

test('suggestLeadMatch: selected_id of the wrong type (number, not string) is treated as no selection', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: 1, confidence: 0.9, reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.leadId, null)
  })
})

test('suggestLeadMatch: a whitespace-only selected_id is treated as no selection', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const chat = jsonChat({ selected_id: '   ', confidence: 0.9, reason: 'x' })
    const result = await suggestLeadMatch(leadTarget, leadCandidates, chat)
    assert.equal(result?.leadId, null)
  })
})

test('suggestLeadMatch: a missing/blank reason falls back to a default message', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const noReason = await suggestLeadMatch(leadTarget, leadCandidates, jsonChat({ selected_id: 'lead-1', confidence: 0.5 }))
    assert.equal(noReason?.reasoning, 'No reasoning provided.')
    const blankReason = await suggestLeadMatch(
      leadTarget,
      leadCandidates,
      jsonChat({ selected_id: 'lead-1', confidence: 0.5, reason: '   ' })
    )
    assert.equal(blankReason?.reasoning, 'No reasoning provided.')
  })
})

test('suggestLeadMatch: a chat function that throws (network error / timeout) returns null instead of throwing', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestLeadMatch(leadTarget, leadCandidates, throwingChat(new Error('fetch failed')))
    assert.equal(result, null)
  })
})

test('suggestDdfMatch: a chat function that throws returns null instead of throwing', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const result = await suggestDdfMatch(ddfTarget, ddfCandidates, throwingChat(new Error('timeout')))
    assert.equal(result, null)
  })
})

// ── model responses wrapped in markdown / stray prose ───────────────────────
// This is what extractJson (shared with the DdfMatch/LeadMatch parsers) exists for:
// models routinely wrap JSON in code fences or add a sentence before/after it.

test('suggestLeadMatch: a response wrapped in a ```json fence is parsed correctly', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const content = '```json\n{"selected_id": "lead-1", "confidence": 0.8, "reason": "fenced"}\n```'
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat(content))
    assert.equal(result?.leadId, 'lead-1')
    assert.equal(result?.reasoning, 'fenced')
  })
})

test('suggestLeadMatch: a response with stray prose around the JSON object is parsed correctly', async () => {
  await withEnvAsync(CONFIGURED_ENV, async () => {
    const content = 'Sure, here is my answer:\n{"selected_id": "lead-1", "confidence": 0.8, "reason": "prose"}\nHope that helps!'
    const result = await suggestLeadMatch(leadTarget, leadCandidates, rawChat(content))
    assert.equal(result?.leadId, 'lead-1')
    assert.equal(result?.reasoning, 'prose')
  })
})

// ── extractJson: the low-level parser directly ──────────────────────────────

test('extractJson: passes clean JSON through unchanged', () => {
  assert.equal(extractJson('{"a":1}'), '{"a":1}')
})

test('extractJson: strips a ```json ... ``` fence', () => {
  assert.equal(extractJson('```json\n{"a":1}\n```'), '{"a":1}')
})

test('extractJson: strips a plain ``` ... ``` fence with no language tag', () => {
  assert.equal(extractJson('```\n{"a":1}\n```'), '{"a":1}')
})

test('extractJson: extracts the object from surrounding prose with no fence', () => {
  assert.equal(extractJson('here you go: {"a":1} thanks'), '{"a":1}')
})

test('extractJson: no braces at all falls back to the trimmed original text', () => {
  assert.equal(extractJson('  no json here  '), 'no json here')
})
