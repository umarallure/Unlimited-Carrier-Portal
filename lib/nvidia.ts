/**
 * Shared NVIDIA LLM client (build.nvidia.com, OpenAI-compatible). Mirrors
 * INSURVAS-CRM's lib/qaCoaching/nvidia.ts — same org, same provider, same
 * conventions — so this repo's AI-assisted matching (lib/aiLeadMatch.ts) behaves
 * like the CRM's existing deal matcher (lib/qaCoaching/matchDeal.ts).
 */
const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
const DEFAULT_MODEL = 'meta/llama-3.3-70b-instruct'

/** Pull the first JSON object out of a model response, tolerating code fences / stray prose. */
export function extractJson(content: string): string {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : content
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : body.trim()
}

export function nvidiaConfigured(): boolean {
  return Boolean(process.env.NVIDIA_API_KEY?.trim())
}

export function nvidiaModel(): string {
  return process.env.NVIDIA_MODEL?.trim() || DEFAULT_MODEL
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Per-attempt request timeout. build.nvidia.com's free/community endpoint has high
 * and variable gateway overhead independent of actual generation time — observed
 * responses where the model's own `e2e_latency_seconds` was ~0.1s but the full
 * round trip still took 20-30s, and a 1-2 candidate prompt succeeded while an
 * 8-candidate prompt (more input tokens) exceeded a 60s ceiling. 90s gives real
 * requests headroom without waiting indefinitely.
 */
const REQUEST_TIMEOUT_MS = 90_000

/** One JSON chat completion, with retry/backoff on 429/503/500 and on a request timeout. */
export async function nvidiaChat(
  system: string,
  user: string,
  maxTokens = 1024,
  modelOverride?: string
): Promise<{ content: string; model: string; id: string | null }> {
  const apiKey = process.env.NVIDIA_API_KEY?.trim()
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not configured.')
  const model = modelOverride || nvidiaModel()
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
      res = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      // A timeout/abort or network failure never reaches the status-code branch below,
      // so it needs its own retry path — previously this threw immediately on the
      // first slow response instead of retrying like a 429/503 does.
      if (attempt < MAX_RETRIES) {
        await sleep(1500 * 2 ** attempt)
        continue
      }
      throw new Error(`NVIDIA LLM request failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (res.ok) {
      const data = (await res.json()) as { id?: string; choices?: Array<{ message?: { content?: string } }> }
      const content = data.choices?.[0]?.message?.content ?? ''
      if (!content) throw new Error('NVIDIA LLM returned no content.')
      return { content, model, id: data.id ?? null }
    }
    const retriable = res.status === 429 || res.status === 503 || res.status === 500
    if (attempt < MAX_RETRIES && retriable) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000
      await res.body?.cancel().catch(() => {})
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 15_000) : 1500 * 2 ** attempt)
      continue
    }
    throw new Error(`NVIDIA LLM failed (${res.status}): ${(await res.text()).slice(0, 400)}`)
  }
}
