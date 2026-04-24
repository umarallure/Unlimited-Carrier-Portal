import { createClient } from '@supabase/supabase-js'

export const DEFAULT_DDF_CUTOVER_DATE = '2026-04-20'
const DAY_MS = 24 * 60 * 60 * 1000

function parseDateOnlyToUtcMs(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  const y = Number.parseInt(m[1], 10)
  const mm = Number.parseInt(m[2], 10)
  const d = Number.parseInt(m[3], 10)
  if (!Number.isFinite(y) || !Number.isFinite(mm) || !Number.isFinite(d)) return null
  return Date.UTC(y, mm - 1, d)
}

function resolveCutoverDateMs(): number {
  const configured = process.env.DDF_CUTOVER_DATE || DEFAULT_DDF_CUTOVER_DATE
  const parsed = parseDateOnlyToUtcMs(configured)
  if (parsed != null) return parsed
  return Date.UTC(2026, 3, 20)
}

export function isNewDdfByDealCreationDate(dealCreationDate: string | null | undefined): boolean {
  const creationMs = parseDateOnlyToUtcMs(dealCreationDate)
  if (creationMs == null) return false
  const cutover = resolveCutoverDateMs()
  return creationMs >= cutover
}

export type DdfSource = 'legacy' | 'new'

export function chooseDdfSourceByDealCreationDate(dealCreationDate: string | null | undefined): DdfSource {
  return isNewDdfByDealCreationDate(dealCreationDate) ? 'new' : 'legacy'
}

type DdfConnection = { url: string; key: string; table: string }

function legacyConnection(): DdfConnection {
  const url =
    process.env.LEGACY_DDF_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL
  const key =
    process.env.LEGACY_DDF_ANON_KEY ||
    process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error(
      'Missing legacy DDF env. Set LEGACY_DDF_SUPABASE_URL and LEGACY_DDF_ANON_KEY (or fallback external/public vars).'
    )
  }
  return { url, key, table: process.env.LEGACY_DDF_TABLE || 'daily_deal_flow' }
}

function newConnection(): DdfConnection {
  const url = process.env.NEW_DDF_SUPABASE_URL
  const key = process.env.NEW_DDF_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing new DDF env. Set NEW_DDF_SUPABASE_URL and NEW_DDF_SERVICE_ROLE_KEY.')
  }
  return { url, key, table: process.env.NEW_DDF_TABLE || 'daily_deal_flow' }
}

export function getDdfConnection(source: DdfSource): DdfConnection {
  return source === 'new' ? newConnection() : legacyConnection()
}

const clientCache = new Map<string, ReturnType<typeof createClient>>()

export function getDdfClient(source: DdfSource): { client: ReturnType<typeof createClient>; table: string } {
  const conn = getDdfConnection(source)
  const cacheKey = `${source}:${conn.url}:${conn.key.slice(0, 12)}:${conn.table}`
  let client = clientCache.get(cacheKey)
  if (!client) {
    client = createClient(conn.url, conn.key)
    clientCache.set(cacheKey, client)
  }
  return { client, table: conn.table }
}

export function sourceForLog(source: DdfSource): string {
  const conn = getDdfConnection(source)
  return `${source}:${conn.table}`
}

export function ddfCutoverDateLabel(): string {
  return process.env.DDF_CUTOVER_DATE || DEFAULT_DDF_CUTOVER_DATE
}

export const _internal = { parseDateOnlyToUtcMs, resolveCutoverDateMs, DAY_MS }
