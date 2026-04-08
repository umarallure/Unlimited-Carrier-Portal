/* eslint-disable @typescript-eslint/no-explicit-any */
'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { parseFile } from '@/lib/fileParser'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Search, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { normalizeRnaPolicyKey } from '@/lib/dealTracker.rna'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminInput,
  adminOutlineBtn,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminThPlain,
} from '@/lib/adminFieldClasses'

type CompareFieldKey =
  | 'name'
  | 'tasks'
  | 'ghl_name'
  | 'ghl_stage'
  | 'policy_status'
  | 'deal_creation_date'
  | 'policy_number'
  | 'carrier'
  | 'deal_value'
  | 'cc_value'
  | 'notes'
  | 'status'
  | 'sales_agent'
  | 'writing_number'
  | 'commission_type'
  | 'effective_date'
  | 'call_center'
  | 'phone_number'
  | 'cc_pmt_ws'
  | 'cc_cb_ws'
  | 'carrier_status'
  | 'policy_type'

type ParsedDealTrackerRow = {
  /**
   * Policy Number as displayed from the file (preserves leading zeros).
   * Used for diffs/display.
   */
  policy_number: string
  /**
   * Normalized policy key used for matching against DB rows.
   * (Strips spaces and collapses leading zeros for all-digit policy numbers.)
   */
  policy_number_key: string
  carrier: string
  // only the fields we compare
  fields: Partial<Record<CompareFieldKey, unknown>>
}

type MatchKind = 'exact' | 'different' | 'missing_in_db' | 'ambiguous_in_db' | 'db_only'

type DiffCell = {
  field: CompareFieldKey
  fileValue: string | null
  dbValue: string | null
}

type CompareRowResult = {
  policy_number: string
  carrier: string
  matchKind: MatchKind
  exact: boolean
  diffs: DiffCell[]
}

const TRACKED_FIELDS_STORAGE_KEY = 'deal_tracker_compare_tracked_fields_v1'

const TRACKABLE_FIELDS: Array<{ key: CompareFieldKey; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'ghl_name', label: 'GHL Name' },
  { key: 'ghl_stage', label: 'GHL Stage' },
  { key: 'policy_status', label: 'Policy Status' },
  { key: 'deal_creation_date', label: 'Deal Creation Date' },
  { key: 'deal_value', label: 'Deal Value' },
  { key: 'cc_value', label: 'CC Value' },
  { key: 'notes', label: 'Notes' },
  { key: 'status', label: 'Status' },
  { key: 'sales_agent', label: 'Sales Agent' },
  { key: 'writing_number', label: 'Writing #' },
  { key: 'effective_date', label: 'Effective Date' },
  { key: 'call_center', label: 'Call Center' },
  { key: 'phone_number', label: 'Phone Number' },
  { key: 'cc_pmt_ws', label: 'CC PMT WS' },
  { key: 'cc_cb_ws', label: 'CC CB WS' },
  { key: 'carrier_status', label: 'Carrier Status' },
  { key: 'policy_number', label: 'Policy Number' },
  { key: 'carrier', label: 'Carrier' },
]

const DEFAULT_TRACKED_FIELDS: CompareFieldKey[] = [
  'name',
  'ghl_stage',
  'deal_value',
  'status',
  'effective_date',
  'policy_number',
  'policy_status',
  'cc_value',
  'sales_agent',
  'call_center',
  'carrier',
  'phone_number',
  'carrier_status',
]

const FILE_HEADER_TO_DB_FIELD: Partial<Record<string, CompareFieldKey>> = {
  'Name': 'name',
  'Tasks': 'tasks',
  'GHL Name': 'ghl_name',
  'GHL Stage': 'ghl_stage',
  'Policy Status': 'policy_status',
  'Deal creation date': 'deal_creation_date',
  'Policy Number': 'policy_number',
  'Carrier': 'carrier',
  'Deal Value': 'deal_value',
  'CC Value': 'cc_value',
  'Notes': 'notes',
  'Status': 'status',
  'Sales Agent': 'sales_agent',
  'Writing #': 'writing_number',
  'Commission Type': 'commission_type',
  'Effective Date': 'effective_date',
  'Call Center': 'call_center',
  'Phone Number': 'phone_number',
  'CC PMT WS': 'cc_pmt_ws',
  'CC CB WS': 'cc_cb_ws',
  'Carrier Status': 'carrier_status',
  'Policy Type': 'policy_type',
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function normalizeDashEmptyToNull(s: unknown): string | null {
  if (s == null) return null
  const t = String(s).trim()
  if (!t) return null
  if (t === '-' || t.toLowerCase() === '—') return null
  return t
}

function normalizeCarrierForKey(v: unknown): string {
  const t = normalizeDashEmptyToNull(v)
  if (!t) return ''
  const key = normalizeWhitespace(t).toUpperCase()
  // Known export alias: ANAM (American Amicable) sometimes appears instead of AMAM.
  if (key === 'ANAM') return 'AMAM'
  // RNA: short name in exports vs full `carriers.name` in deal_tracker — same logical carrier.
  if (key === 'ROYAL NEIGHBORS' || key === 'ROYAL NEIGHBORS OF AMERICA') return 'ROYAL NEIGHBORS OF AMERICA'
  return key
}

/**
 * Must align with RNA (and deal_tracker upsert) for numeric policies: strip spaces, then leading zeros
 * on all-digit policy numbers so the compare keys match saved rows and duplicates collapse.
 */
function normalizePolicyForKey(v: unknown): string {
  const t = normalizeDashEmptyToNull(v)
  if (!t) return ''
  const compact = String(t).replace(/\s+/g, '').trim()
  if (/^\d+$/.test(compact)) {
    return normalizeRnaPolicyKey(compact).toUpperCase()
  }
  return compact.toUpperCase()
}

function normalizeDateYMD(value: unknown): string | null {
  const t = normalizeDashEmptyToNull(value)
  if (!t) return null

  // YYYY-MM-DD
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t)
  if (iso) {
    const y = iso[1]
    const m = String(parseInt(iso[2], 10)).padStart(2, '0')
    const d = String(parseInt(iso[3], 10)).padStart(2, '0')
    return `${y}-${m}-${d}`
  }

  // MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t)
  if (us) {
    const m = String(parseInt(us[1], 10)).padStart(2, '0')
    const d = String(parseInt(us[2], 10)).padStart(2, '0')
    return `${us[3]}-${m}-${d}`
  }

  // ISO / timestamptz: use the calendar prefix so we don't shift the day via UTC (toISOString).
  const ymdPrefix = String(t).match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymdPrefix) return ymdPrefix[1]

  const d = new Date(t.includes('T') ? t : `${t}T12:00:00`)
  if (Number.isNaN(d.getTime())) return normalizeWhitespace(t)
  const y = d.getFullYear()
  const mo = d.getMonth() + 1
  const day = d.getDate()
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null
  const t = String(value).trim()
  if (!t || t === '-' || t.toLowerCase() === 'null') return null
  const cleaned = t.replace(/,/g, '')
  const n = Number(cleaned)
  if (!Number.isFinite(n)) return null
  return n
}

function numbersEqual(a: unknown, b: unknown): boolean {
  const an = parseNumber(a) ?? 0
  const bn = parseNumber(b) ?? 0
  return Math.abs(an - bn) < 1e-6
}

function stringsEqual(a: unknown, b: unknown): boolean {
  const an = normalizeDashEmptyToNull(a)
  const bn = normalizeDashEmptyToNull(b)
  if (an == null && bn == null) return true
  if (an == null || bn == null) return false
  return normalizeWhitespace(an).toLowerCase() === normalizeWhitespace(bn).toLowerCase()
}

function valuesEqual(field: CompareFieldKey, fileValue: unknown, dbValue: unknown): boolean {
  if (
    field === 'deal_value' ||
    field === 'cc_value' ||
    field === 'cc_pmt_ws' ||
    field === 'cc_cb_ws'
  ) {
    return numbersEqual(fileValue, dbValue)
  }

  if (field === 'policy_number') {
    const an = normalizeDashEmptyToNull(fileValue)
    const bn = normalizeDashEmptyToNull(dbValue)
    if (an == null && bn == null) return true
    if (an == null || bn == null) return false

    const ac = String(an).replace(/\s+/g, '').trim()
    const bc = String(bn).replace(/\s+/g, '').trim()
    if (/^\d+$/.test(ac) && /^\d+$/.test(bc)) {
      return normalizeRnaPolicyKey(ac).toUpperCase() === normalizeRnaPolicyKey(bc).toUpperCase()
    }
  }

  if (field === 'deal_creation_date' || field === 'effective_date') {
    return normalizeDateYMD(fileValue) === normalizeDateYMD(dbValue)
  }

  return stringsEqual(fileValue, dbValue)
}

function toDisplayString(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  if (!t) return null
  if (t === '-' || t.toLowerCase() === '—') return null
  return t
}

function extractParsedRows(records: Array<{ policyNumber: string; data: Record<string, any> }>): ParsedDealTrackerRow[] {
  const out: ParsedDealTrackerRow[] = []

  for (const r of records) {
    const data = r.data || {}
    // prefer DB key columns from file columns if present, else fallback to detected policyNumber
    const policyNumberRaw = data['Policy Number'] ?? data['Policy #'] ?? r.policyNumber
    const carrierRaw = data['Carrier']
    const policyNumberKey = normalizePolicyForKey(policyNumberRaw)
    const carrier = normalizeCarrierForKey(carrierRaw)

    // Preserve the original policy value (except whitespace) for display/diffing.
    // Your historical import keeps leading zeros, so display should too.
    const policyNumberDisplayRaw = normalizeDashEmptyToNull(policyNumberRaw)
    const policyNumberDisplay = policyNumberDisplayRaw
      ? String(policyNumberDisplayRaw).replace(/\s+/g, '').trim().toUpperCase()
      : ''

    // Skip stray header rows accidentally included by CSV/Excel exports.
    // Example: policyNumber becomes "POLICYNUMBER" and carrier becomes "CARRIER".
    if (!policyNumberDisplay || !carrier) continue
    if (!/\d/.test(policyNumberDisplay)) continue
    if (carrier === 'CARRIER') continue

    const fields: Partial<Record<CompareFieldKey, unknown>> = {}
    for (const [header, v] of Object.entries(data)) {
      const dbField = FILE_HEADER_TO_DB_FIELD[header]
      if (!dbField) continue
      fields[dbField] = v
    }

    // ensure keys are always set
    fields.policy_number = policyNumberDisplay
    fields.carrier = carrier
    out.push({
      policy_number: policyNumberDisplay,
      policy_number_key: policyNumberKey,
      carrier,
      fields,
    })
  }

  return out
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export default function DealTrackerComparePage() {
  const [file, setFile] = useState<File | null>(null)
  const [carriers, setCarriers] = useState<string>('all')
  const [carrierOptions, setCarrierOptions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [parsedCount, setParsedCount] = useState<number>(0)
  const [dbFetchedCount, setDbFetchedCount] = useState<number>(0)
  const [results, setResults] = useState<CompareRowResult[]>([])
  const [pageSize, setPageSize] = useState(20)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [matchFilter, setMatchFilter] = useState<'all' | 'exact' | 'missing' | 'different' | 'db_only'>('all')
  const [trackedFields, setTrackedFields] = useState<CompareFieldKey[]>(DEFAULT_TRACKED_FIELDS)
  const [resultCarrierFilter, setResultCarrierFilter] = useState<string>('all')

  const compareFields: CompareFieldKey[] = useMemo(() => {
    const keys = new Set<CompareFieldKey>(trackedFields)
    // Always keep matching keys in compare logic.
    keys.add('policy_number')
    keys.add('carrier')
    return TRACKABLE_FIELDS.map(f => f.key).filter(k => keys.has(k))
  }, [trackedFields])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(TRACKED_FIELDS_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return
      const valid = parsed.filter((v): v is CompareFieldKey =>
        TRACKABLE_FIELDS.some(f => f.key === v)
      )
      if (!valid.length) return
      setTrackedFields(valid)
    } catch (_) {}
  }, [])

  useEffect(() => {
    localStorage.setItem(TRACKED_FIELDS_STORAGE_KEY, JSON.stringify(trackedFields))
  }, [trackedFields])

  const compareFieldSelect = useMemo(() => {
    const base = new Set(compareFields)
    // Supabase select must include keys too
    // Also fetch `id` so we can mark "DB-only" rows.
    base.add('id' as any)
    return Array.from(base).join(',')
  }, [compareFields])

  const summary = useMemo(() => {
    if (!results.length) return null
    const fileRows = results.filter(r => r.matchKind !== 'db_only')
    const dbOnly = results.filter(r => r.matchKind === 'db_only').length
    const total = fileRows.length
    const exact = fileRows.filter(r => r.exact).length
    const different = fileRows.filter(r => r.matchKind === 'different').length
    const missing = fileRows.filter(r => r.matchKind === 'missing_in_db').length
    const ambiguous = fileRows.filter(r => r.matchKind === 'ambiguous_in_db').length
    const score = total > 0 ? (exact / total) * 100 : 0
    return { total, dbOnly, exact, different, missing, ambiguous, score }
  }, [results])

  /** Match stats for file rows only, optionally narrowed by the result-table carrier filter. */
  const tableScopeSummary = useMemo(() => {
    if (!results.length) return null
    const fileRows = results.filter(r => r.matchKind !== 'db_only')
    const scoped =
      resultCarrierFilter === 'all'
        ? fileRows
        : fileRows.filter(
            r => normalizeCarrierForKey(r.carrier) === normalizeCarrierForKey(resultCarrierFilter)
          )
    const total = scoped.length
    const exact = scoped.filter(r => r.exact).length
    const different = scoped.filter(r => r.matchKind === 'different').length
    const missing = scoped.filter(r => r.matchKind === 'missing_in_db').length
    const ambiguous = scoped.filter(r => r.matchKind === 'ambiguous_in_db').length
    const score = total > 0 ? (exact / total) * 100 : 0
    const dbOnly =
      resultCarrierFilter === 'all' ? results.filter(r => r.matchKind === 'db_only').length : 0
    return { total, exact, different, missing, ambiguous, score, dbOnly }
  }, [results, resultCarrierFilter])

  const filteredResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filterFn = (r: CompareRowResult) => {
      if (matchFilter === 'all') return true
      if (matchFilter === 'exact') return r.matchKind === 'exact'
      if (matchFilter === 'missing') return r.matchKind === 'missing_in_db'
      if (matchFilter === 'db_only') return r.matchKind === 'db_only'
      // 'different': treat ambiguous + different as "different"
      return r.matchKind === 'different' || r.matchKind === 'ambiguous_in_db'
    }

    const carrierFiltered = resultCarrierFilter === 'all'
      ? results
      : results.filter(r => normalizeCarrierForKey(r.carrier) === normalizeCarrierForKey(resultCarrierFilter))
    const base = carrierFiltered.filter(filterFn)
    if (!q) return base
    return base.filter(r => (r.policy_number || '').toLowerCase().includes(q) || (r.carrier || '').toLowerCase().includes(q))
  }, [results, search, matchFilter, resultCarrierFilter])

  const resultCarrierOptions = useMemo(() => {
    return Array.from(new Set(results.map(r => r.carrier).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b))
  }, [results])

  const totalPages = Math.max(1, Math.ceil(filteredResults.length / pageSize))
  const paginated = filteredResults.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)

  const computeCompareResults = (
    effectiveRows: ParsedDealTrackerRow[],
    dbMap: Map<string, any[]>,
    policyDbMap: Map<string, any[]>
  ): CompareRowResult[] => {
    const matchedDbIdSet = new Set<string>()
    const resultsOut: CompareRowResult[] = []

    for (const fr of effectiveRows) {
      const exactKey = `${fr.policy_number_key}|${normalizeCarrierForKey(fr.carrier)}`
      const dbRowsExact = dbMap.get(exactKey) ?? []

      let dbRow: any | null = null
      if (dbRowsExact.length === 1) {
        dbRow = dbRowsExact[0]
      } else if (dbRowsExact.length > 1) {
        for (const r of dbRowsExact) {
          if (r?.id != null) matchedDbIdSet.add(String(r.id))
        }
        resultsOut.push({
          policy_number: fr.policy_number,
          carrier: fr.carrier,
          matchKind: 'ambiguous_in_db',
          exact: false,
          diffs: [],
        })
        continue
      } else {
        // No exact policy+carrier row. Fall back to policy-only.
        const policyKey = fr.policy_number_key
        const dbRowsByPolicy = policyDbMap.get(policyKey) ?? []

        if (dbRowsByPolicy.length === 0) {
          resultsOut.push({
            policy_number: fr.policy_number,
            carrier: fr.carrier,
            matchKind: 'missing_in_db',
            exact: false,
            diffs: [],
          })
          continue
        }
        if (dbRowsByPolicy.length > 1) {
          for (const r of dbRowsByPolicy) {
            if (r?.id != null) matchedDbIdSet.add(String(r.id))
          }
          resultsOut.push({
            policy_number: fr.policy_number,
            carrier: fr.carrier,
            matchKind: 'ambiguous_in_db',
            exact: false,
            diffs: [],
          })
          continue
        }
        dbRow = dbRowsByPolicy[0]
      }

      if (dbRow?.id != null) {
        matchedDbIdSet.add(String(dbRow.id))
      }

      const diffs: DiffCell[] = []
      for (const field of compareFields) {
        const fileVal = fr.fields[field]
        const dbVal = (dbRow as any)[field]
        const equal = valuesEqual(field, fileVal, dbVal)
        if (!equal) {
          diffs.push({
            field,
            fileValue: toDisplayString(fileVal),
            dbValue: toDisplayString(dbVal),
          })
        }
      }

      // Hard ignore `policy_type` and `commission_type` diffs even if it somehow gets into `diffs`
      // (e.g. stale bundle / future field list changes).
      const diffsFiltered = diffs.filter(d => d.field !== 'policy_type' && d.field !== 'commission_type')
      const exact = diffsFiltered.length === 0
      resultsOut.push({
        policy_number: fr.policy_number,
        carrier: fr.carrier,
        matchKind: exact ? 'exact' : 'different',
        exact,
        diffs: diffsFiltered,
      })
    }

    // DB-only detection within the scanned policy numbers universe.
    const dbOnlyOut: CompareRowResult[] = []
    for (const [, rows] of dbMap.entries()) {
      for (const row of rows) {
        if (row?.id == null) continue
        const idStr = String(row.id)
        if (matchedDbIdSet.has(idStr)) continue

        dbOnlyOut.push({
          policy_number: row.policy_number ? String(row.policy_number) : '',
          carrier: row.carrier ? String(row.carrier) : '',
          matchKind: 'db_only',
          exact: false,
          diffs: [],
        })
      }
    }

    return [...resultsOut, ...dbOnlyOut]
  }

  const runCompare = async () => {
    if (!file) return

    setLoading(true)
    setResults([])
    setParsedCount(0)
    setDbFetchedCount(0)
    setPage(1)
    setExpandedKey(null)

    try {
      const parsed = await parseFile(file)
      const parsedRows = extractParsedRows(parsed.records)
      setParsedCount(parsedRows.length)
      if (!parsedRows.length) {
        setResults([])
        return
      }

      // Optional carrier filter (client-side)
      const carrierSet = new Set(parsedRows.map(r => r.carrier))
      const carrierList = Array.from(carrierSet).sort((a, b) => a.localeCompare(b))
      setCarrierOptions(carrierList)
      const selectedCarrier = carriers === 'all' ? null : carriers
      const effectiveRows = selectedCarrier ? parsedRows.filter(r => r.carrier === selectedCarrier) : parsedRows

      // Map exported carrier value to DB carrier name.
      // Your export can contain:
      // - carrier codes (e.g. "MOH", "AMAM")
      // - aliases (e.g. "ANAM" -> "AMAM")
      // - partial/full names (e.g. "ROYAL NEIGHBORS")
      // We normalize the exported value and fuzzy-match against `carriers.code` and `carriers.name`.
      const { data: allCarrierRows, error: carrierErr } = await supabase
        .from('carriers')
        .select('code,name')

      if (carrierErr) throw carrierErr

      const codeKeyToName = new Map<string, string>()
      const nameVariants: Array<{ key: string; name: string }> = []

      for (const c of (allCarrierRows || []) as any[]) {
        if (!c?.code || !c?.name) continue
        const dbName = String(c.name)
        codeKeyToName.set(normalizeCarrierForKey(c.code), dbName)

        const nameUpper = normalizeCarrierForKey(dbName)
        const nameNoParen = normalizeWhitespace(String(dbName).split('(')[0])
        const nameNoParenKey = normalizeCarrierForKey(nameNoParen)

        nameVariants.push({ key: nameUpper, name: dbName })
        nameVariants.push({ key: nameNoParenKey, name: dbName })
      }

      const mapCarrierToDbName = (fileCarrierRaw: unknown): string => {
        const key = normalizeCarrierForKey(fileCarrierRaw)
        if (!key) return ''

        // 1) exact by carrier code (after aliases)
        const byCode = codeKeyToName.get(key)
        if (byCode) return byCode

        // 2) fuzzy by carrier name: prefix/inclusion
        for (const v of nameVariants) {
          if (!v?.key) continue
          if (v.key === key) return v.name
          if (v.key.startsWith(key)) return v.name
          if (key.startsWith(v.key)) return v.name
          if (v.key.includes(key)) return v.name
        }

        // no mapping found -> keep export value
        return String(fileCarrierRaw)
      }

      for (const row of effectiveRows) {
        const mapped = mapCarrierToDbName(row.carrier)
        if (mapped) {
          row.carrier = mapped
          row.fields.carrier = mapped
        }
      }

      // Supabase `.in('policy_number', ...)` matches the stored DB string exactly.
      // Your historical import script preserves leading zeros in `deal_tracker.policy_number`,
      // but our matching key collapses leading zeros. To avoid "missing in db" false negatives,
      // fetch by BOTH the display value and the normalized key.
      const allPolicyNumbers = Array.from(
        new Set(
          effectiveRows.flatMap(r => [r.policy_number, r.policy_number_key]).filter(Boolean)
        )
      )

      // Fetch deal_tracker rows by policy number.
      // We'll try an exact (policy+carrier) match first, but if carrier value differs
      // between the exported file and DB, we fall back to policy-only matching.
      const dbMap = new Map<string, any[]>() // key: policy|carrier
      const policyDbMap = new Map<string, any[]>() // key: policy
      // Smaller chunk size keeps each Supabase query fast and prevents the UI
      // from getting stuck on a single large `IN (...)` request.
      const policyChunks = chunk(allPolicyNumbers, 200)

      let fetchedSoFar = 0

      const withTimeout = async <T,>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> => {
        let t: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_, reject) => {
          t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
        })
        try {
          return await Promise.race([Promise.resolve(promise), timeout])
        } finally {
          if (t) clearTimeout(t)
        }
      }

      for (let i = 0; i < policyChunks.length; i++) {
        const chunkPol = policyChunks[i]
        let q = supabase.from('deal_tracker').select(compareFieldSelect).in('policy_number', chunkPol)
        // FETCH-ONCE: always fetch for all agencies; scope changes recompute locally.

        // Fetch
        console.log('[DealTrackerCompare] Fetching DB chunk', i + 1, '/', policyChunks.length, {
          policyCount: chunkPol.length,
        })
        const { data, error } = await withTimeout<any>(q as any, 60000, `deal_tracker chunk ${i + 1}`)
        if (error) throw error
        const rows = (data || []) as any[]

        fetchedSoFar += rows.length
        setDbFetchedCount(fetchedSoFar)

        for (const row of rows) {
          const policyNum = normalizePolicyForKey(row.policy_number)
          const carrier = normalizeCarrierForKey(row.carrier)
          const key = `${policyNum}|${carrier}`
          const arr = dbMap.get(key) ?? []
          arr.push(row)
          dbMap.set(key, arr)

          const policyArr = policyDbMap.get(policyNum) ?? []
          policyArr.push(row)
          policyDbMap.set(policyNum, policyArr)
        }
      }

      setResults(computeCompareResults(effectiveRows, dbMap, policyDbMap))
    } catch (e: any) {
      console.error('DealTracker compare failed:', e)
      alert(e?.message || 'Compare failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="admin-page w-full max-w-none space-y-6 px-4 py-8">
      <PageHeader
        title="Deal Tracker Compare (QA)"
        description={
          <>
            Upload your exported Deal Tracker Excel/CSV, then we compare each row vs the Supabase{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">deal_tracker</code> table by{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Policy Number</code> +{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Carrier</code>. We ignore{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">policy_type</code> and{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">commission_type</code> differences during matching.
            {' '}
            Numeric policy numbers are matched like RNA uploads (leading zeros stripped). DB rows are loaded once for
            all agencies (same policy # may appear under multiple orgs).
          </>
        }
      />

      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <CardTitle className={cn(adminCardTitle, 'text-lg')}>Upload & Compare</CardTitle>
        </CardHeader>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 items-end gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="block text-sm text-muted-foreground">Deal Tracker File (CSV or Excel)</label>
              <Input
                type="file"
                accept=".csv,.xlsx,.xls"
                onChange={e => setFile(e.target.files?.[0] ?? null)}
                className={cn(adminInput, 'cursor-pointer file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground')}
              />
            </div>

            <div className="space-y-2">
              <label className="block text-sm text-muted-foreground">Optional Carrier Filter</label>
              <Select value={carriers} onValueChange={setCarriers}>
                <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                  <SelectValue placeholder="All carriers" />
                </SelectTrigger>
                <SelectContent className={adminSelectContent}>
                  <SelectItem value="all" className={adminSelectItem}>All carriers</SelectItem>
                  {carrierOptions.map(c => (
                    <SelectItem key={c} value={c} className={adminSelectItem}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">
                Carrier dropdown is populated after parsing (requires compare click).
              </div>
            </div>
          </div>

          <Tabs defaultValue="upload" className="mt-6">
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1">
              <TabsTrigger value="upload">Upload</TabsTrigger>
              <TabsTrigger value="compare_settings">Compare Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="upload">
              <div className="text-xs text-muted-foreground">
                Use your file + carrier filter, then click Compare.
              </div>
            </TabsContent>
            <TabsContent value="compare_settings">
              <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4 dark:border-slate-800 dark:bg-slate-950/50">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-muted-foreground dark:text-slate-300">
                    Choose which columns should count as &quot;changed&quot;. Default excludes <code className="rounded bg-muted px-1 text-xs">notes</code>.
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className={adminOutlineBtn}
                      onClick={() => setTrackedFields(DEFAULT_TRACKED_FIELDS)}
                    >
                      Reset Defaults
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className={adminOutlineBtn}
                      onClick={() => setTrackedFields(TRACKABLE_FIELDS.map(f => f.key))}
                    >
                      Select All
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
                  {TRACKABLE_FIELDS.map(field => {
                    const checked = trackedFields.includes(field.key)
                    const lockedKey = field.key === 'policy_number' || field.key === 'carrier'
                    return (
                      <label
                        key={field.key}
                        className={cn(
                          'flex items-center gap-2 text-sm',
                          lockedKey ? 'text-muted-foreground' : 'text-foreground dark:text-slate-300'
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={lockedKey}
                          onCheckedChange={(isChecked) => {
                            if (lockedKey) return
                            setTrackedFields(prev => {
                              if (isChecked) return Array.from(new Set([...prev, field.key]))
                              return prev.filter(k => k !== field.key)
                            })
                          }}
                        />
                        <span>{field.label}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            </TabsContent>
          </Tabs>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Button
              onClick={() => void runCompare()}
              disabled={!file || loading}
              className="bg-orange-600 font-semibold text-white hover:bg-orange-700"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Comparing...
                </>
              ) : (
                <>
                  <Search className="mr-2 h-4 w-4" />
                  Compare
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={loading}
              className={adminOutlineBtn}
              onClick={() => {
                setFile(null)
                setResults([])
                setParsedCount(0)
                setDbFetchedCount(0)
                setPage(1)
                setSearch('')
              }}
            >
              Reset
            </Button>
          </div>

          {(parsedCount > 0 || results.length > 0) && (
            <div className="mt-6 space-y-2">
              <div className="text-sm text-muted-foreground dark:text-slate-300">
                Parsed rows: <span className="font-semibold text-foreground dark:text-white">{parsedCount}</span>
                {' '}| DB rows fetched:{' '}
                <span className="font-semibold text-foreground dark:text-white">{dbFetchedCount}</span>
              </div>
              {summary && (
                <div className="text-sm text-muted-foreground dark:text-slate-300">
                  Exact match: <span className="font-semibold text-foreground dark:text-white">{summary.exact}</span> /{' '}
                  <span className="font-semibold text-foreground dark:text-white">{summary.total}</span> ({summary.score.toFixed(2)}%)
                  {' '}| DB-only: <span className="font-semibold text-foreground dark:text-white">{summary.dbOnly}</span>
                  {' '}| Different:{' '}
                  <span className="font-semibold text-foreground dark:text-white">{summary.different}</span>
                  {' '}| Missing:{' '}
                  <span className="font-semibold text-foreground dark:text-white">{summary.missing}</span>
                  {' '}| Ambiguous:{' '}
                  <span className="font-semibold text-foreground dark:text-white">{summary.ambiguous}</span>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {results.length > 0 && (
        <Card>
          <CardHeader className={cn(adminCardHeaderBar, 'space-y-4')}>
            <div>
              <CardTitle className={cn(adminCardTitle, 'text-lg')}>Mapped entries</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground dark:text-slate-400">
                Use the carrier dropdown below to focus stats on one insurer name from the file.
              </p>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-end sm:gap-4">
              {tableScopeSummary && (
                <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-950/50">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {resultCarrierFilter === 'all' ? 'All carriers (file rows)' : `Carrier: ${resultCarrierFilter}`}
                  </div>
                  <div className="mt-1 tabular-nums text-foreground dark:text-slate-200">
                    Exact{' '}
                    <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                      {tableScopeSummary.exact}
                    </span>
                    {' / '}
                    <span className="font-semibold">{tableScopeSummary.total}</span> (
                    {tableScopeSummary.score.toFixed(2)}%) · Different{' '}
                    <span className="font-semibold text-blue-600 dark:text-blue-400">{tableScopeSummary.different}</span> ·
                    Missing{' '}
                    <span className="font-semibold text-red-600 dark:text-red-400">{tableScopeSummary.missing}</span>
                    {tableScopeSummary.ambiguous > 0 && (
                      <>
                        {' '}
                        · Ambiguous{' '}
                        <span className="font-semibold text-amber-600 dark:text-amber-400">
                          {tableScopeSummary.ambiguous}
                        </span>
                      </>
                    )}
                    {resultCarrierFilter === 'all' && tableScopeSummary.dbOnly > 0 && (
                      <>
                        {' '}
                        · DB-only{' '}
                        <span className="font-semibold text-purple-600 dark:text-purple-400">
                          {tableScopeSummary.dbOnly}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 dark:border-slate-800">
              <div className="text-sm font-medium text-muted-foreground dark:text-slate-400">Row filters</div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mr-1 text-xs text-muted-foreground">Match:</span>
                  <Button
                    size="sm"
                    variant={matchFilter === 'all' ? 'default' : 'outline'}
                    className={
                      matchFilter === 'all'
                        ? 'bg-slate-700 text-white hover:bg-slate-600 dark:bg-slate-700'
                        : adminOutlineBtn
                    }
                    onClick={() => setMatchFilter('all')}
                  >
                    All
                  </Button>
                  <Button
                    size="sm"
                    variant={matchFilter === 'exact' ? 'default' : 'outline'}
                    className={
                      matchFilter === 'exact'
                        ? 'bg-emerald-600 text-white hover:bg-emerald-600'
                        : adminOutlineBtn
                    }
                    onClick={() => setMatchFilter('exact')}
                  >
                    Exact
                  </Button>
                  <Button
                    size="sm"
                    variant={matchFilter === 'missing' ? 'default' : 'outline'}
                    className={
                      matchFilter === 'missing'
                        ? 'bg-red-600 text-white hover:bg-red-600'
                        : adminOutlineBtn
                    }
                    onClick={() => setMatchFilter('missing')}
                  >
                    Missing
                  </Button>
                  <Button
                    size="sm"
                    variant={matchFilter === 'different' ? 'default' : 'outline'}
                    className={
                      matchFilter === 'different'
                        ? 'bg-blue-600 text-white hover:bg-blue-600'
                        : adminOutlineBtn
                    }
                    onClick={() => setMatchFilter('different')}
                  >
                    Different
                  </Button>
                  <Button
                    size="sm"
                    variant={matchFilter === 'db_only' ? 'default' : 'outline'}
                    className={
                      matchFilter === 'db_only'
                        ? 'bg-purple-600 text-white hover:bg-purple-600'
                        : adminOutlineBtn
                    }
                    onClick={() => setMatchFilter('db_only')}
                    title="Deals present in DB but not matched by file rows (within scanned policy numbers)."
                  >
                    DB-only
                  </Button>
                </div>
                <Select value={resultCarrierFilter} onValueChange={setResultCarrierFilter}>
                  <SelectTrigger className={cn('h-10 w-56', adminSelectTrigger)}>
                    <SelectValue placeholder="Filter carrier" />
                  </SelectTrigger>
                  <SelectContent className={adminSelectContent}>
                    <SelectItem value="all" className={adminSelectItem}>All carriers</SelectItem>
                    {resultCarrierOptions.map(c => (
                      <SelectItem key={c} value={c} className={adminSelectItem}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search policy # or carrier..."
                  className={cn(adminInput, 'w-full min-w-[12rem] max-w-xs sm:w-72')}
                />
                <Button
                  variant="outline"
                  className={adminOutlineBtn}
                  onClick={() => {
                    setPage(1)
                    setResultCarrierFilter('all')
                  }}
                >
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Re-focus
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <Table>
              <TableHeader className="bg-muted/80 dark:bg-slate-800">
                <TableRow>
                  <TableHead className={adminThPlain}>Match</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={adminThPlain}>Carrier</TableHead>
                  <TableHead className={adminThPlain}>Changed Fields</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                      No results.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((r, idx) => {
                    const rowKey = `${r.policy_number}|${r.carrier}`
                    const isExpanded = expandedKey === rowKey && r.matchKind === 'different'
                    return (
                      <Fragment key={`${r.policy_number}-${r.carrier}-${idx}`}>
                        <TableRow>
                          <TableCell className="text-foreground">
                            {r.matchKind === 'exact' ? (
                              <span className="font-semibold text-emerald-700 dark:text-emerald-300">Exact</span>
                            ) : r.matchKind === 'missing_in_db' ? (
                              <span className="font-semibold text-red-700 dark:text-red-300">Missing</span>
                            ) : r.matchKind === 'ambiguous_in_db' ? (
                              <span className="font-semibold text-amber-700 dark:text-amber-300">Ambiguous</span>
                            ) : r.matchKind === 'db_only' ? (
                              <span className="font-semibold text-purple-700 dark:text-purple-300">DB-only</span>
                            ) : (
                              <span className="font-semibold text-blue-700 dark:text-blue-300">Different</span>
                            )}
                          </TableCell>
                          <TableCell className="font-mono text-foreground dark:text-slate-200">{r.policy_number}</TableCell>
                          <TableCell className="text-foreground dark:text-slate-200">{r.carrier}</TableCell>
                          <TableCell className="text-foreground dark:text-slate-200">
                            {r.matchKind === 'exact' ? (
                              <span className="text-muted-foreground">—</span>
                            ) : r.matchKind === 'db_only' ? (
                              <span className="text-muted-foreground dark:text-slate-300">—</span>
                            ) : (
                              <div className="flex items-center gap-2">
                                <span>
                                  {r.matchKind === 'different'
                                    ? (r.diffs.length ? `${r.diffs.length} field(s)` : 'Different')
                                    : '—'}
                                </span>
                                {r.matchKind === 'different' && r.diffs.length > 0 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className={cn('h-7', adminOutlineBtn)}
                                    onClick={() => setExpandedKey(prev => (prev === rowKey ? null : rowKey))}
                                  >
                                    {isExpanded ? 'Hide' : 'Details'}
                                  </Button>
                                )}
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                        {isExpanded && (
                          <TableRow>
                            <TableCell colSpan={4} className="bg-muted/40 dark:bg-slate-950/40">
                              <div className="p-3">
                                <div className="mb-2 text-xs font-medium text-muted-foreground dark:text-slate-300">
                                  Changes (file -&gt; DB)
                                </div>
                                <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                                  {r.diffs.map(d => (
                                    <div key={d.field} className="text-xs text-foreground dark:text-slate-200">
                                      <div className="font-semibold text-foreground dark:text-slate-100">{d.field}</div>
                                      <div className="text-muted-foreground">
                                        File: <span className="text-foreground dark:text-slate-200">{d.fileValue ?? '—'}</span>
                                      </div>
                                      <div className="text-muted-foreground">
                                        DB: <span className="text-foreground dark:text-slate-200">{d.dbValue ?? '—'}</span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>

            {filteredResults.length > pageSize && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm text-muted-foreground">
                  Page <span className="font-semibold text-foreground dark:text-slate-200">{page}</span> of{' '}
                  <span className="font-semibold text-foreground dark:text-slate-200">{totalPages}</span>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" className={adminOutlineBtn} disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    className={adminOutlineBtn}
                    disabled={page >= totalPages}
                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}

            {paginated.length > 0 && paginated.some(r => r.matchKind === 'different') && (
              <div className="mt-6 text-xs text-muted-foreground">
                Click <span className="font-semibold text-foreground dark:text-slate-200">Details</span> to see before/after values per column.
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

