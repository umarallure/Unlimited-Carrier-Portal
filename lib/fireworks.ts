/**
 * Shared Fireworks AI LLM client (api.fireworks.ai, OpenAI-compatible). Mirrors
 * lib/nvidia.ts exactly — same retry/timeout handling, same shape — so
 * lib/aiLeadMatch.ts can switch between providers via AI_MATCH_PROVIDER without
 * any other code changing. Added specifically to test whether Fireworks has more
 * consistent latency than build.nvidia.com's free-tier gateway (see lib/nvidia.ts's
 * REQUEST_TIMEOUT_MS comment for the reliability issues that motivated this).
 */
const FIREWORKS_URL = 'https://api.fireworks.ai/inference/v1/chat/completions'
const DEFAULT_MODEL = 'accounts/fireworks/routers/glm-5p2-fast'
const REQUEST_TIMEOUT_MS = 90_000

/** Pull the first JSON object out of a model response, tolerating code fences / stray prose. */
export function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : content
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim()
}

export function fireworksConfigured(): boolean {
  return Boolean(process.env.FIREWORKS_API_KEY?.trim())
}

export function fireworksModel(): string {
  return process.env.FIREWORKS_MODEL?.trim() || DEFAULT_MODEL
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** One JSON chat completion, with retry/backoff on 429/503/500 and on a request timeout. */
export async function fireworksChat(
  system: string,
  user: string,
  maxTokens = 1024,
  modelOverride?: string
): Promise<{ content: string; model: string; id: string | null }> {
  const apiKey = process.env.FIREWORKS_API_KEY?.trim()
  if (!apiKey) throw new Error('FIREWORKS_API_KEY is not configured.')
  const model = modelOverride || fireworksModel()
  const body = JSON.stringify({
    model,
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  })
  const MAX_RETRIES = 3
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await fetch(FIREWORKS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      if (attempt < MAX_RETRIES) {
        await sleep(1500 * 2 ** attempt)
        continue
      }
      throw new Error(`Fireworks LLM request failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.ok) {
      const data = (await res.json()) as { id?: string; choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content ?? ''
      if (!content) throw new Error('Fireworks LLM returned no content.')
      return { content, model, id: data.id ?? null }
    }
    const retriable = res.status === 429 || res.status === 503 || res.status === 500
    if (attempt < MAX_RETRIES && retriable) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000
      await res.body?.cancel().catch(() => {})
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 15_000) : 1500 * 2 ** attempt)
      continue
    }
    throw new Error(`Fireworks LLM failed (${res.status}): ${(await res.text()).slice(0, 400)}`)
  }
}
