/**
 * AMAM Correspondence
 *
 * Parses the AMAM correspondence CSV export, saves it to `amam_correspondence`,
 * and links each row back to `deal_tracker` on policy number.
 *
 * The link is resolved at read time rather than stored, because correspondence
 * regularly arrives for policies that never reach deal_tracker (declines,
 * withdrawn applications, closed files) and for policies that land in
 * deal_tracker only after the correspondence file is uploaded.
 */

import Papa from 'papaparse'
import { supabase } from './supabaseClient'

export const AMAM_CORRESPONDENCE_TABLE = 'amam_correspondence'

/** Chunk size for `.in(...)` lookups and batched upserts. */
const CHUNK_SIZE = 200

export interface AmamCorrespondenceRow {
  id?: string
  agent_id: string | null
  agent_name: string | null
  policy_number: string
  policy_number_key: string
  policyholder: string | null
  correspondence_date: string | null
  description: string | null
  form_code: string | null
  action_item: string | null
  source_file: string | null
  source_row: number | null
  dedupe_key: string
  created_at?: string
  updated_at?: string
}

/** Parsed row plus what we worked out about it before saving. */
export interface AmamCorrespondencePreviewRow extends AmamCorrespondenceRow {
  /** 1-based line number in the uploaded CSV, for error reporting. */
  csvRow: number
  /** Already present in the database under the same dedupe_key. */
  isExisting: boolean
  /** An earlier row in this same file carried the same dedupe_key. */
  isDuplicateInFile: boolean
  /** A deal_tracker row exists for this policy number. */
  hasDealTracker: boolean
}

export interface AmamCorrespondenceParseResult {
  rows: AmamCorrespondencePreviewRow[]
  /** Rows dropped because they had no usable policy number. */
  skipped: Array<{ csvRow: number; reason: string }>
  totalDataRows: number
  detectedHeaders: string[]
}

/** Deal tracker fields shown alongside a correspondence row. */
export interface LinkedDealTracker {
  id: string
  policy_number: string
  name: string | null
  ghl_name: string | null
  carrier: string | null
  ghl_stage: string | null
  policy_status: string | null
  carrier_status: string | null
  sales_agent: string | null
  call_center: string | null
  phone_number: string | null
  effective_date: string | null
  deal_value: number | null
  monthly_premium: number | null
}

const DEAL_TRACKER_LINK_COLUMNS =
  'id, policy_number, name, ghl_name, carrier, ghl_stage, policy_status, carrier_status, sales_agent, call_center, phone_number, effective_date, deal_value, monthly_premium'

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Join key for policy numbers. Mirrors the tolerant matching used in
 * lib/invoicing.ts so AMAM's zero-padded and unpadded exports collapse together.
 */
export function normalizePolicyKey(value: unknown): string {
  const raw = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+/, '') || '0'
}

/**
 * Every plausible way `deal_tracker.policy_number` might store this policy, so
 * an `.in(...)` lookup hits regardless of zero padding.
 */
export function policyLookupCandidates(value: unknown): string[] {
  const raw = String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return []
  if (!/^\d+$/.test(raw)) return [raw]
  const stripped = raw.replace(/^0+/, '') || '0'
  const out = new Set<string>([raw, stripped])
  for (let len = stripped.length; len <= 12; len++) {
    out.add(stripped.padStart(len, '0'))
  }
  return Array.from(out)
}

/** `7/8/2026` / `07-08-2026` / `2026-07-08` -> `2026-07-08`. Null when unparseable. */
export function parseCorrespondenceDate(value: unknown): string | null {
  const str = String(value ?? '').trim()
  if (!str) return null

  const iso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  }

  const us = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/)
  if (us) {
    const month = Number(us[1])
    const day = Number(us[2])
    let year = Number(us[3])
    if (year < 100) year += year < 70 ? 2000 : 1900
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

function cleanText(value: unknown): string | null {
  const str = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return str.length ? str : null
}

/**
 * Stable natural key. Two AMAM memos for the same policy on the same day are
 * distinct only by description + form code, so all four make up the key.
 */
export function buildDedupeKey(row: {
  policy_number_key: string
  correspondence_date: string | null
  description: string | null
  form_code: string | null
}): string {
  return [
    row.policy_number_key,
    row.correspondence_date ?? '',
    (row.description ?? '').toUpperCase(),
    (row.form_code ?? '').toUpperCase(),
  ].join('|')
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * AMAM has shipped this export with slightly different headers over time, so
 * each field accepts a few aliases. Matching is case- and separator-insensitive.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  agent_id: ['agent id', 'agentid', 'agent #', 'agent number', 'agent no'],
  agent_name: ['agent name', 'agentname', 'agent', 'writing agent'],
  policy_number: ['policy number', 'policynumber', 'policy #', 'policy', 'policy no', 'policy num'],
  policyholder: ['policyholder', 'policy holder', 'insured', 'insured name', 'client', 'client name'],
  correspondence_date: ['date', 'correspondence date', 'corr date', 'letter date'],
  description: ['description', 'desc', 'correspondence', 'memo'],
  form_code: ['form code', 'formcode', 'form', 'form #'],
  action_item: ['action item', 'actionitem', 'action', 'action required', 'notes'],
}

function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Maps our field names to the actual header strings present in this file. */
function resolveHeaderMap(headers: string[]): Record<string, string | null> {
  const normalized = headers.map((h) => ({ raw: h, key: normalizeHeader(h) }))
  const map: Record<string, string | null> = {}

  for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
    let match = normalized.find((h) => aliases.includes(h.key))
    if (!match) {
      // Fall back to a contains-match so "Policy Number (AMAM)" still resolves.
      match = normalized.find((h) => aliases.some((alias) => h.key.includes(alias)))
    }
    map[field] = match ? match.raw : null
  }

  return map
}

/**
 * Read and parse the AMAM correspondence CSV. Pure — touches no database.
 * The file is read as text first so a UTF-8 BOM never ends up inside the first
 * header name (this export ships with one).
 */
export async function parseAmamCorrespondenceCsv(file: File): Promise<AmamCorrespondenceParseResult> {
  const text = (await file.text()).replace(/^﻿/, '')

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h: string) => h.replace(/^﻿/, '').trim(),
  })

  const headers = (parsed.meta?.fields ?? []).filter(Boolean)
  const headerMap = resolveHeaderMap(headers)

  if (!headerMap.policy_number) {
    throw new Error(
      `Could not find a policy number column. Expected one of: Policy Number, Policy #, Policy. Found: ${headers.join(', ') || '(none)'}`
    )
  }

  const dataRows = parsed.data ?? []
  const rows: AmamCorrespondencePreviewRow[] = []
  const skipped: Array<{ csvRow: number; reason: string }> = []
  const seenInFile = new Set<string>()

  const get = (record: Record<string, string>, field: string): string => {
    const header = headerMap[field]
    if (!header) return ''
    return record[header] ?? ''
  }

  dataRows.forEach((record, idx) => {
    // +2: one for the header line, one to make it 1-based like a spreadsheet.
    const csvRow = idx + 2

    const policyNumber = String(get(record, 'policy_number') ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    const policyKey = normalizePolicyKey(policyNumber)

    if (!policyKey) {
      // Trailing blank lines are common in these exports; only flag real rows.
      const hasAnyContent = Object.values(record).some((v) => String(v ?? '').trim().length > 0)
      if (hasAnyContent) skipped.push({ csvRow, reason: 'Missing policy number' })
      return
    }

    const base = {
      agent_id: cleanText(get(record, 'agent_id')),
      agent_name: cleanText(get(record, 'agent_name')),
      policy_number: policyNumber,
      policy_number_key: policyKey,
      policyholder: cleanText(get(record, 'policyholder')),
      correspondence_date: parseCorrespondenceDate(get(record, 'correspondence_date')),
      description: cleanText(get(record, 'description')),
      form_code: cleanText(get(record, 'form_code')),
      action_item: cleanText(get(record, 'action_item')),
      source_file: file.name,
      source_row: csvRow,
    }

    const dedupeKey = buildDedupeKey(base)
    const isDuplicateInFile = seenInFile.has(dedupeKey)
    seenInFile.add(dedupeKey)

    rows.push({
      ...base,
      dedupe_key: dedupeKey,
      csvRow,
      isExisting: false,
      isDuplicateInFile,
      hasDealTracker: false,
    })
  })

  return { rows, skipped, totalDataRows: dataRows.length, detectedHeaders: headers }
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Fills in `isExisting` (already saved) and `hasDealTracker` (policy is known to
 * deal_tracker) so the preview can show what a save would actually change.
 */
export async function annotateCorrespondencePreview(
  rows: AmamCorrespondencePreviewRow[]
): Promise<AmamCorrespondencePreviewRow[]> {
  if (!rows.length) return rows

  const dedupeKeys = Array.from(new Set(rows.map((r) => r.dedupe_key)))
  const existingKeys = new Set<string>()

  for (const batch of chunk(dedupeKeys)) {
    const { data, error } = await supabase
      .from(AMAM_CORRESPONDENCE_TABLE)
      .select('dedupe_key')
      .in('dedupe_key', batch)
    if (error) throw new Error(`Failed to check existing correspondence: ${error.message}`)
    ;(data as Array<{ dedupe_key: string }> | null)?.forEach((r) => existingKeys.add(r.dedupe_key))
  }

  const matchedKeys = await findDealTrackerPolicyKeys(rows.map((r) => r.policy_number))

  return rows.map((row) => ({
    ...row,
    isExisting: existingKeys.has(row.dedupe_key),
    hasDealTracker: matchedKeys.has(row.policy_number_key),
  }))
}

/** Normalized policy keys (from the given list) that exist in deal_tracker. */
export async function findDealTrackerPolicyKeys(policyNumbers: string[]): Promise<Set<string>> {
  const matched = new Set<string>()
  const candidates = Array.from(new Set(policyNumbers.flatMap((p) => policyLookupCandidates(p))))
  if (!candidates.length) return matched

  for (const batch of chunk(candidates)) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select('policy_number')
      .in('policy_number', batch)
    if (error) throw new Error(`Failed to look up deal tracker policies: ${error.message}`)
    ;(data as Array<{ policy_number: string }> | null)?.forEach((r) =>
      matched.add(normalizePolicyKey(r.policy_number))
    )
  }

  return matched
}

/** Full deal_tracker rows for the given policy numbers, keyed by normalized policy. */
export async function fetchLinkedDealTrackers(
  policyNumbers: string[]
): Promise<Map<string, LinkedDealTracker>> {
  const byKey = new Map<string, LinkedDealTracker>()
  const candidates = Array.from(new Set(policyNumbers.flatMap((p) => policyLookupCandidates(p))))
  if (!candidates.length) return byKey

  for (const batch of chunk(candidates)) {
    const { data, error } = await supabase
      .from('deal_tracker')
      .select(DEAL_TRACKER_LINK_COLUMNS)
      .in('policy_number', batch)
    if (error) throw new Error(`Failed to load linked deals: ${error.message}`)

    for (const row of (data as unknown as LinkedDealTracker[]) || []) {
      const key = normalizePolicyKey(row.policy_number)
      // A policy can appear more than once; keep the first, which is enough for
      // the summary columns shown next to each correspondence row.
      if (!byKey.has(key)) byKey.set(key, row)
    }
  }

  return byKey
}

export interface SaveCorrespondenceResult {
  saved: number
  inserted: number
  updated: number
}

/**
 * Upsert on `dedupe_key`, so re-uploading an overlapping export refreshes the
 * action item / provenance instead of creating duplicates.
 */
export async function saveAmamCorrespondence(
  rows: AmamCorrespondencePreviewRow[]
): Promise<SaveCorrespondenceResult> {
  const payloadByKey = new Map<string, AmamCorrespondenceRow>()
  const now = new Date().toISOString()

  // Last row wins within a single file, matching a plain re-import.
  for (const row of rows) {
    payloadByKey.set(row.dedupe_key, {
      agent_id: row.agent_id,
      agent_name: row.agent_name,
      policy_number: row.policy_number,
      policy_number_key: row.policy_number_key,
      policyholder: row.policyholder,
      correspondence_date: row.correspondence_date,
      description: row.description,
      form_code: row.form_code,
      action_item: row.action_item,
      source_file: row.source_file,
      source_row: row.source_row,
      dedupe_key: row.dedupe_key,
      updated_at: now,
    })
  }

  const payload = Array.from(payloadByKey.values())
  if (!payload.length) return { saved: 0, inserted: 0, updated: 0 }

  const updated = rows.filter((r) => r.isExisting).length

  for (const batch of chunk(payload, 500)) {
    const { error } = await supabase
      .from(AMAM_CORRESPONDENCE_TABLE)
      .upsert(batch, { onConflict: 'dedupe_key' })
    if (error) throw new Error(`Failed to save correspondence: ${error.message}`)
  }

  return { saved: payload.length, inserted: payload.length - updated, updated }
}

/** Filters that can be pushed down to Postgres (all live on amam_correspondence). */
export interface CorrespondenceFilters {
  search?: string
  description?: string
  agentId?: string
  dateFrom?: string
  dateTo?: string
}

export interface CorrespondenceDataset {
  rows: AmamCorrespondenceRow[]
  /** Keyed by `policy_number_key`. */
  dealTrackers: Map<string, LinkedDealTracker>
  /** True when the row cap was hit and some matching rows were left unread. */
  truncated: boolean
}

/** Safety valve on the full load below. */
export const MAX_CORRESPONDENCE_ROWS = 10000

const FETCH_PAGE_SIZE = 1000

/**
 * Every correspondence row matching the pushdown filters, plus the deal_tracker
 * row for each policy.
 *
 * Loaded in full rather than a page at a time because GHL Stage, Policy Status,
 * GHL Name and the link filter all live on deal_tracker. Postgres cannot filter
 * on them from here, so paging in the database would produce short pages and a
 * wrong total once any of those filters is applied. The page filters and
 * paginates this set in memory instead, which keeps every filter exact.
 */
export async function fetchAmamCorrespondence(
  filters: CorrespondenceFilters
): Promise<CorrespondenceDataset> {
  const rows: AmamCorrespondenceRow[] = []
  let truncated = false

  for (let offset = 0; offset < MAX_CORRESPONDENCE_ROWS; offset += FETCH_PAGE_SIZE) {
    let request = supabase
      .from(AMAM_CORRESPONDENCE_TABLE)
      .select('*')
      .order('correspondence_date', { ascending: false, nullsFirst: false })
      .order('policy_number', { ascending: true })
      .range(offset, offset + FETCH_PAGE_SIZE - 1)

    const search = filters.search?.trim()
    if (search) {
      // `,` and `(` `)` are PostgREST `or=` delimiters and `%` is a wildcard.
      const escaped = search.replace(/[%,()]/g, ' ').trim()
      if (escaped) {
        request = request.or(
          `policy_number.ilike.%${escaped}%,policyholder.ilike.%${escaped}%,agent_name.ilike.%${escaped}%,agent_id.ilike.%${escaped}%`
        )
      }
    }
    if (filters.description && filters.description !== 'all') {
      request = request.eq('description', filters.description)
    }
    if (filters.agentId && filters.agentId !== 'all') {
      request = request.eq('agent_id', filters.agentId)
    }
    if (filters.dateFrom) request = request.gte('correspondence_date', filters.dateFrom)
    if (filters.dateTo) request = request.lte('correspondence_date', filters.dateTo)

    const { data, error } = await request
    if (error) throw new Error(`Failed to load correspondence: ${error.message}`)

    const batch = (data as AmamCorrespondenceRow[]) || []
    rows.push(...batch)

    if (batch.length < FETCH_PAGE_SIZE) break
    if (rows.length >= MAX_CORRESPONDENCE_ROWS) {
      truncated = true
      break
    }
  }

  const dealTrackers = await fetchLinkedDealTrackers(rows.map((r) => r.policy_number))
  return { rows, dealTrackers, truncated }
}

export interface CorrespondenceFacets {
  descriptions: string[]
  agents: Array<{ id: string; name: string }>
}

/** Distinct values for the filter dropdowns. */
export async function fetchCorrespondenceFacets(): Promise<CorrespondenceFacets> {
  const { data, error } = await supabase
    .from(AMAM_CORRESPONDENCE_TABLE)
    .select('description, agent_id, agent_name')
    .limit(10000)
  if (error) throw new Error(`Failed to load filters: ${error.message}`)

  const descriptions = new Set<string>()
  const agents = new Map<string, string>()

  for (const row of (data as Array<{
    description: string | null
    agent_id: string | null
    agent_name: string | null
  }>) || []) {
    if (row.description) descriptions.add(row.description)
    if (row.agent_id) agents.set(row.agent_id, row.agent_name || row.agent_id)
  }

  return {
    descriptions: Array.from(descriptions).sort(),
    agents: Array.from(agents.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/** All correspondence for one policy, newest first — used by the detail drawer. */
export async function fetchCorrespondenceForPolicy(
  policyNumber: string
): Promise<AmamCorrespondenceRow[]> {
  const key = normalizePolicyKey(policyNumber)
  if (!key) return []

  const { data, error } = await supabase
    .from(AMAM_CORRESPONDENCE_TABLE)
    .select('*')
    .eq('policy_number_key', key)
    .order('correspondence_date', { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to load policy correspondence: ${error.message}`)

  return (data as AmamCorrespondenceRow[]) || []
}

/** Delete by id. Returns the number of rows removed. */
export async function deleteCorrespondenceRows(ids: string[]): Promise<number> {
  if (!ids.length) return 0
  let removed = 0
  for (const batch of chunk(ids)) {
    const { error, count } = await supabase
      .from(AMAM_CORRESPONDENCE_TABLE)
      .delete({ count: 'exact' })
      .in('id', batch)
    if (error) throw new Error(`Failed to delete correspondence: ${error.message}`)
    removed += count ?? batch.length
  }
  return removed
}
