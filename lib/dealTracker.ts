/**
 * Deal Tracker Processing Logic
 * Handles mapping carrier files to standardized deal tracker format
 */

import { supabase } from './supabaseClient'
import { createClient } from '@supabase/supabase-js'

// External Supabase client for daily_deal_flow (from another database)
let externalSupabaseClient: ReturnType<typeof createClient> | null = null

function getExternalSupabaseClient() {
  if (!externalSupabaseClient) {
    const url = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_URL
    const key = process.env.NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY
    
    if (!url || !key) {
      throw new Error('Missing external Supabase credentials. Please set NEXT_PUBLIC_EXTERNAL_SUPABASE_URL and NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY')
    }
    
    externalSupabaseClient = createClient(url, key)
  }
  return externalSupabaseClient
}

export interface DealTrackerEntry {
  id?: string
  agency_carrier_id: string
  name: string | null
  tasks: string | null
  ghl_name: string | null
  ghl_stage: string | null
  policy_status: string | null
  deal_creation_date: string | null
  policy_number: string
  carrier: string
  carrier_id: string | null
  deal_value: number | null
  cc_value: number | null
  charge_back?: number | null
  notes: string | null
  status: string | null
  last_updated: string
  sales_agent: string | null
  writing_number: string | null
  commission_type: string | null
  effective_date: string | null
  call_center: string | null
  phone_number: string | null
  cc_pmt_ws: string | null
  cc_cb_ws: string | null
  carrier_status: string | null
  policy_type: string | null
  daily_deal_flow_fetched: boolean
  daily_deal_flow_fetched_at: string | null
  source_policy_table: string | null
  source_policy_id: string | null
  source_commission_table: string | null
  source_commission_id: string | null
}

export interface DealTrackerPreviewEntry extends DealTrackerEntry {
  isNew: boolean
  isUpdated: boolean
}

type DailyDealFlowInfo = {
  call_center: string | null
  phone_number: string | null
  draft_date: string | null
}

/**
 * Bulk fetch all status mappings for a carrier (OPTIMIZED)
 * Returns a Map of status -> mapped_status for fast lookups
 */
export async function bulkFetchStatusMappings(
  carrierId: string,
  carrierCode: string | null
): Promise<Map<string, string>> {
  const statusMap = new Map<string, string>()
  
  console.log('[Deal Tracker] Bulk fetching status mappings for carrier_id:', carrierId)
  
  // Fetch all mappings for this carrier_id
  const { data: mappings, error } = await supabase
    .from('carrier_status_mapping')
    .select('policy_status_in_carrier_portal, stage_monday')
    .eq('carrier_id', carrierId)

  if (!error && mappings && mappings.length > 0) {
    mappings.forEach(m => {
      statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
    })
    console.log('[Deal Tracker] Loaded', mappings.length, 'status mappings by carrier_id')
  }

  // Fallback: If no mappings found by carrier_id, try carrier_code
  if (statusMap.size === 0 && carrierCode) {
    console.log('[Deal Tracker] No mappings by carrier_id, trying carrier_code:', carrierCode)
    const { data: fallbackMappings, error: fallbackError } = await supabase
      .from('carrier_status_mapping')
      .select('policy_status_in_carrier_portal, stage_monday')
      .eq('carrier_code', carrierCode)

    if (!fallbackError && fallbackMappings && fallbackMappings.length > 0) {
      fallbackMappings.forEach(m => {
        statusMap.set(m.policy_status_in_carrier_portal, m.stage_monday)
      })
      console.log('[Deal Tracker] Loaded', fallbackMappings.length, 'status mappings by carrier_code')
    }
  }

  return statusMap
}

/**
 * Map carrier status to standardized status using carrier_status_mapping table
 * Uses carrier_id (UUID) from carriers table for reliable matching
 * NOTE: For bulk operations, use bulkFetchStatusMappings instead
 */
export async function mapCarrierStatus(
  carrierId: string, // UUID from carriers table
  carrierStatus: string | null
): Promise<string | null> {
  if (!carrierStatus || !carrierId) return null

  // Primary method: Match by carrier_id (UUID from carriers table)
  let { data, error } = await supabase
    .from('carrier_status_mapping')
    .select('stage_monday')
    .eq('carrier_id', carrierId)
    .eq('policy_status_in_carrier_portal', carrierStatus)
    .single()

  // Fallback to carrier_code if carrier_id not found (for backward compatibility)
  if (error || !data) {
    // Get carrier code to try fallback
    const { data: carrierData } = await supabase
      .from('carriers')
      .select('code')
      .eq('id', carrierId)
      .single()

    if (carrierData?.code) {
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('carrier_status_mapping')
        .select('stage_monday')
        .eq('carrier_code', carrierData.code)
        .eq('policy_status_in_carrier_portal', carrierStatus)
        .single()

      if (!fallbackError && fallbackData) {
        return fallbackData.stage_monday
      }
    }

    console.warn(`No mapping found for carrier_id: ${carrierId}, status: ${carrierStatus}`)
    return carrierStatus // Return original if no mapping found
  }

  return data.stage_monday
}

/**
 * Normalize name for better matching (remove extra spaces, commas -> space so "Last, First" matches "First Last")
 */
export function normalizeNameForSearch(name: string): string {
  if (!name) return ''
  // Replace commas with space so "Walker, Diane" becomes "Walker Diane" for consistent part extraction
  const noComma = name.replace(/,/g, ' ')
  return noComma.replace(/\s+/g, ' ').trim()
}

/**
 * Extract first and last name for flexible matching.
 * Returns a canonical key (sorted first|last) so "Diane Walker", "Walker, Diane", and "HART, RAYMOND L" vs "Raymond Lee Hart" match.
 * When a comma is present, treat "Last, First MI" so last = before comma, first = first word after comma.
 */
function extractNameParts(fullName: string): { firstName: string; lastName: string; allParts: string[]; firstLastKey: string } {
  const raw = (fullName ?? '').trim()
  if (!raw) {
    return { firstName: '', lastName: '', allParts: [], firstLastKey: '' }
  }

  const commaIdx = raw.indexOf(',')
  if (commaIdx >= 0) {
    // "Last, First MI" or "HART, RAYMOND L" -> last = before comma, first = first word after comma
    const beforeComma = raw.slice(0, commaIdx).replace(/\s+/g, ' ').trim()
    const afterComma = raw.slice(commaIdx + 1).replace(/\s+/g, ' ').trim()
    const firstWordAfter = afterComma.split(' ').filter(Boolean)[0] ?? ''
    if (beforeComma && firstWordAfter) {
      const lastName = beforeComma
      const firstName = firstWordAfter
      const firstLastKey = [firstName, lastName].sort().join('|').toLowerCase()
      return {
        firstName,
        lastName,
        allParts: [firstName, lastName],
        firstLastKey,
      }
    }
  }

  const normalized = normalizeNameForSearch(fullName)
  const parts = normalized.split(' ').filter(p => p.length > 0)
  if (parts.length === 0) {
    return { firstName: '', lastName: '', allParts: [], firstLastKey: '' }
  }
  const firstName = parts[0]
  const lastName = parts[parts.length - 1]
  const allParts = parts.filter((p, i) => i === 0 || i === parts.length - 1)
  const firstLastKey = [firstName, lastName].sort().join('|').toLowerCase()
  return { firstName, lastName, allParts, firstLastKey }
}

/**
 * Levenshtein edit distance (for fuzzy first-name matching: Lakeysha vs Lekeysha vs Leteysha)
 */
function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const curr = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = curr
  }
  return prev[n]
}

/**
 * Build insured name from AMAM policy fields to match DDF format: "First MI Last" (e.g. "Martha J Klar")
 */
function buildAmamInsuredName(p: { firstname?: string | null; lastname?: string | null; mi?: string | null }): string {
  const first = p.firstname?.trim() ?? ''
  const last = p.lastname?.trim() ?? ''
  const mi = p.mi?.trim() ?? ''
  const parts = first ? [first, mi, last].filter(Boolean) : [mi, last].filter(Boolean)
  return parts.join(' ').trim() || ''
}


/**
 * When running in browser, DDF is fetched via our API to avoid CORS with external Supabase.
 * Chunks large requests to prevent timeouts.
 */
async function fetchDdfViaApi(
  insuredNames: string[],
  carrier: string
): Promise<Map<string, DailyDealFlowInfo>> {
  const CHUNK_SIZE = 200 // Process 200 names per request to avoid timeouts
  const allResults = new Map<string, DailyDealFlowInfo>()
  
  if (insuredNames.length > CHUNK_SIZE) {
    console.log(`[Deal Tracker] Chunking DDF fetch: ${insuredNames.length} names into ${Math.ceil(insuredNames.length / CHUNK_SIZE)} requests`)
  }
  
  // Chunk the names array
  for (let i = 0; i < insuredNames.length; i += CHUNK_SIZE) {
    const chunk = insuredNames.slice(i, i + CHUNK_SIZE)
    const res = await fetch('/api/ddf-lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ carrier, names: chunk }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('[Deal Tracker] DDF API error:', data.error || res.statusText)
      throw new Error(data.error || `DDF lookup failed: ${res.status}`)
    }
    const results = data.results || {}
    Object.entries(results).forEach(([k, v]) => {
      const val = (v as { call_center?: string | null; phone_number?: string | null; draft_date?: string | null }) || {}
      allResults.set(k, {
        call_center: val.call_center ?? null,
        phone_number: val.phone_number ?? null,
        draft_date: val.draft_date ?? null,
      })
    })
    const withData = Object.values(results).filter((v: any) => v?.call_center || v?.phone_number).length
    if (chunk.length > 0 && withData === 0) {
      console.warn('[Deal Tracker] DDF API returned no call_center/phone for', chunk.length, 'names (carrier:', carrier, '). Check server logs for [ddf-lookup] and that external DDF has rows for this carrier.')
    }
    
    // Log progress for large batches
    if (insuredNames.length > CHUNK_SIZE) {
      console.log(`[Deal Tracker] DDF fetch progress: ${Math.min(i + CHUNK_SIZE, insuredNames.length)}/${insuredNames.length} names`)
    }
  }
  
  return allResults
}

const DDF_FETCH_LIMIT = 5000
/** Supabase project default max rows per request; we paginate to get more */
const SUPABASE_PAGE_SIZE = 1000

/**
 * Fetch all rows by paginating with .range(from, to).
 * queryFactory() must return a query with .order() so range is deterministic.
 */
export async function fetchAllPaginated<T = any>(queryFactory: () => any): Promise<T[]> {
  const acc: T[] = []
  let from = 0
  while (true) {
    const to = from + SUPABASE_PAGE_SIZE - 1
    const { data, error } = await queryFactory().range(from, to)
    if (error) throw error
    const chunk = (data ?? []) as T[]
    acc.push(...chunk)
    if (chunk.length < SUPABASE_PAGE_SIZE) break
    from = to + 1
  }
  return acc
}

/**
 * Fetch raw daily_deal_flow rows for a carrier (server-side only).
 * Exported for /api/ddf-lookup to cache and reuse across chunked requests.
 */
export async function getDdfRecordsForCarrier(
  externalSupabase: ReturnType<typeof createClient>,
  carrier: string
): Promise<{
  insured_name?: string | null
  lead_vendor?: string | null
  lead_vendor_name?: string | null
  client_phone_number?: string | null
  phone_number?: string | null
  carrier?: string | null
  draft_date?: string | null
}[]> {
  const carrierUpper = (carrier || '').toUpperCase()
  const isAmam = carrierUpper === 'AMAM' || carrierUpper === 'ANAM' || carrierUpper.includes('AMERICAN AMICABLE')
  // External DDF table may not have lead_vendor_name or phone_number; use only columns that exist there
  let query = externalSupabase
    .from('daily_deal_flow')
    .select('insured_name, lead_vendor, client_phone_number, carrier, draft_date')
    .order('created_at', { ascending: false })
    .limit(DDF_FETCH_LIMIT)
  if (isAmam) {
    query = query.or('carrier.ilike.%AMAM%,carrier.ilike.%ANAM%,carrier.ilike.%American%')
  } else if (carrierUpper === 'LIBERTY') {
    query = query.ilike('carrier', '%Liberty%')
  } else if (carrierUpper === 'COREBRIDGE') {
    query = query.ilike('carrier', '%Corebridge%')
  } else {
    query = query.ilike('carrier', carrier)
  }
  const { data, error } = await query
  if (error || !data) return []
  return data as {
    insured_name?: string | null
    lead_vendor?: string | null
    lead_vendor_name?: string | null
    client_phone_number?: string | null
    phone_number?: string | null
    carrier?: string | null
    draft_date?: string | null
  }[]
}

/**
 * Match insured names against already-fetched DDF records. Used by API with cached records.
 */
export function matchDdfNamesToRecords(
  allRecords: {
    insured_name?: string | null
    lead_vendor?: string | null
    lead_vendor_name?: string | null
    client_phone_number?: string | null
    phone_number?: string | null
    draft_date?: string | null
  }[],
  insuredNames: string[]
): Map<string, DailyDealFlowInfo> {
  const resultMap = new Map<string, DailyDealFlowInfo>()
  if (!insuredNames?.length || !allRecords?.length) return resultMap

  const normalizedNames = insuredNames.map(n => normalizeNameForSearch(n))
  // Use original names for extractNameParts so "Last, First MI" (e.g. HART, RAYMOND L) is parsed correctly
  const nameParts = insuredNames.map(n => extractNameParts((n ?? '').trim()))
  type DailyDealFlowRecord = typeof allRecords[0]
  const getCallCenter = (r: DailyDealFlowRecord): string | null =>
    ((r.lead_vendor ?? r.lead_vendor_name ?? null) && String(r.lead_vendor ?? r.lead_vendor_name ?? '').trim()) || null
  const getPhone = (r: DailyDealFlowRecord): string | null =>
    ((r.client_phone_number ?? r.phone_number ?? null) && String(r.client_phone_number ?? r.phone_number ?? '').trim()) || null
  const hasContact = (r: DailyDealFlowRecord) => !!(getCallCenter(r) || getPhone(r))
  const pickBestMatch = (matches: DailyDealFlowRecord[]): DailyDealFlowRecord | null => {
    if (!matches?.length) return null
    const withData = matches.find(hasContact)
    return withData ?? matches[0]
  }
  const exactMap = new Map<string, DailyDealFlowRecord[]>()
  const firstLastMap = new Map<string, DailyDealFlowRecord[]>()
  const firstNameMap = new Map<string, DailyDealFlowRecord[]>()
  const lastNameMap = new Map<string, DailyDealFlowRecord[]>()
  for (const record of allRecords as DailyDealFlowRecord[]) {
    const recordName = normalizeNameForSearch(record.insured_name || '')
    const recordParts = extractNameParts(recordName)
    if (recordName) {
      if (!exactMap.has(recordName)) exactMap.set(recordName, [])
      exactMap.get(recordName)!.push(record)
    }
    if (recordParts.firstName && recordParts.lastName) {
      const key = recordParts.firstLastKey
      if (!firstLastMap.has(key)) firstLastMap.set(key, [])
      firstLastMap.get(key)!.push(record)
    }
    if (recordParts.firstName) {
      const key = recordParts.firstName.toLowerCase()
      if (!firstNameMap.has(key)) firstNameMap.set(key, [])
      firstNameMap.get(key)!.push(record)
    }
    if (recordParts.lastName) {
      const key = recordParts.lastName.toLowerCase()
      if (!lastNameMap.has(key)) lastNameMap.set(key, [])
      lastNameMap.get(key)!.push(record)
    }
  }
  for (let i = 0; i < normalizedNames.length; i++) {
    const normalizedName = normalizedNames[i]
    const parts = nameParts[i]
    let bestMatch: DailyDealFlowRecord | null = null
    let bestScore = 0
    const exactMatches = exactMap.get(normalizedName)
    if (exactMatches?.length) {
      bestMatch = pickBestMatch(exactMatches)
      bestScore = 100
    } else if (parts.firstName && parts.lastName && parts.firstLastKey) {
      const matches = firstLastMap.get(parts.firstLastKey)
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 80
      }
    }
    if (!bestMatch && parts.firstName && parts.lastName) {
      const lastNameKey = parts.lastName.toLowerCase()
      const lastMatches = lastNameMap.get(lastNameKey)
      if (lastMatches?.length) {
        const policyFirst = parts.firstName.toLowerCase()
        const fuzzyMatches = lastMatches.filter(r => {
          const rName = normalizeNameForSearch(r.insured_name || '')
          const rParts = extractNameParts(rName)
          const rFirst = (rParts.firstName || '').toLowerCase()
          return rFirst.length > 0 && editDistance(policyFirst, rFirst) <= 2
        })
        if (fuzzyMatches.length) {
          bestMatch = pickBestMatch(fuzzyMatches)
          bestScore = 55
        }
      }
    }
    if (!bestMatch && parts.firstName) {
      const matches = firstNameMap.get(parts.firstName.toLowerCase())
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 60
      }
    }
    if (!bestMatch && parts.lastName) {
      const matches = lastNameMap.get(parts.lastName.toLowerCase())
      if (matches?.length) {
        bestMatch = pickBestMatch(matches)
        bestScore = 50
      }
    }
    if (!bestMatch && parts.firstName && parts.lastName) {
      const policyFirst = parts.firstName.toLowerCase()
      const policyLast = parts.lastName.toLowerCase()
      const fuzzyBoth = (allRecords as DailyDealFlowRecord[]).filter(r => {
        const rName = normalizeNameForSearch(r.insured_name || '')
        const rParts = extractNameParts(rName)
        const rFirst = (rParts.firstName || '').toLowerCase()
        const rLast = (rParts.lastName || '').toLowerCase()
        if (!rFirst || !rLast) return false
        return editDistance(policyFirst, rFirst) <= 2 && editDistance(policyLast, rLast) <= 2
      })
      if (fuzzyBoth.length) {
        bestMatch = pickBestMatch(fuzzyBoth)
        bestScore = 52
      }
    }
    if (bestMatch && bestScore >= 50) {
      resultMap.set(normalizedName, {
        call_center: getCallCenter(bestMatch) ?? null,
        phone_number: getPhone(bestMatch) ?? null,
        draft_date: bestMatch.draft_date != null ? String(bestMatch.draft_date).trim() : null,
      })
    }
  }
  return resultMap
}

/**
 * Bulk fetch daily_deal_flow records (server-side implementation).
 * Exported for use by /api/ddf-lookup so the browser never calls external Supabase (avoids CORS).
 */
export async function doBulkFetchDailyDealFlowInfo(
  externalSupabase: ReturnType<typeof createClient>,
  insuredNames: string[],
  carrier: string
): Promise<Map<string, DailyDealFlowInfo>> {
  const resultMap = new Map<string, DailyDealFlowInfo>()
  if (!insuredNames || insuredNames.length === 0) return resultMap

  try {
    const normalizedNames = insuredNames.map(n => normalizeNameForSearch(n))
    // Use original names for extractNameParts so "Last, First MI" (e.g. HART, RAYMOND L) matches "Raymond Lee Hart"
    const nameParts = insuredNames.map(n => extractNameParts((n ?? '').trim()))
    
    console.log('[Deal Tracker] Bulk fetching daily_deal_flow for carrier:', carrier, 'names:', normalizedNames.length)
    
    // STEP 1: Fetch DDF records for carrier (getDdfRecordsForCarrier only – no direct query here)
    console.log('[Deal Tracker] Step 1: Filtering daily_deal_flow records by carrier:', carrier)
    const ddfRecords = await getDdfRecordsForCarrier(externalSupabase, carrier)
    if (!ddfRecords || ddfRecords.length === 0) {
      console.log('[Deal Tracker] No daily_deal_flow records found for carrier:', carrier)
      return resultMap
    }

    // Type assertion for external database records
    type DailyDealFlowRecord = {
      insured_name?: string | null
      lead_vendor?: string | null
      lead_vendor_name?: string | null
      client_phone_number?: string | null
      phone_number?: string | null
      carrier?: string | null
      draft_date?: string | null
    }
    const typedRecords = ddfRecords as DailyDealFlowRecord[]
    const getCallCenter = (r: DailyDealFlowRecord) =>
      (r.lead_vendor ?? r.lead_vendor_name ?? null) && String(r.lead_vendor ?? r.lead_vendor_name ?? '').trim() || null
    const getPhone = (r: DailyDealFlowRecord) =>
      (r.client_phone_number ?? r.phone_number ?? null) && String(r.client_phone_number ?? r.phone_number ?? '').trim() || null
    const hasContact = (r: DailyDealFlowRecord) => !!(getCallCenter(r) || getPhone(r))
    const pickBestMatch = (matches: DailyDealFlowRecord[]): DailyDealFlowRecord | null => {
      if (!matches?.length) return null
      const withData = matches.find(hasContact)
      return withData ?? matches[0]
    }
    const exactMap = new Map<string, DailyDealFlowRecord[]>()
    const firstLastMap = new Map<string, DailyDealFlowRecord[]>()
    const firstNameMap = new Map<string, DailyDealFlowRecord[]>()
    const lastNameMap = new Map<string, DailyDealFlowRecord[]>()
    // Build lookup maps from records (O(n) instead of O(n*m) later)
    for (const record of typedRecords) {
      const recordName = normalizeNameForSearch(record.insured_name || '')
      const recordParts = extractNameParts(recordName)
      
      // Exact match map
      if (recordName) {
        if (!exactMap.has(recordName)) exactMap.set(recordName, [])
        exactMap.get(recordName)!.push(record)
      }
      
      // First + Last map (canonical key so "Diane Walker" and "Walker, Diane" match)
      if (recordParts.firstName && recordParts.lastName && recordParts.firstLastKey) {
        const key = recordParts.firstLastKey
        if (!firstLastMap.has(key)) firstLastMap.set(key, [])
        firstLastMap.get(key)!.push(record)
      }
      
      // First name map
      if (recordParts.firstName) {
        const key = recordParts.firstName.toLowerCase()
        if (!firstNameMap.has(key)) firstNameMap.set(key, [])
        firstNameMap.get(key)!.push(record)
      }
      
      // Last name map
      if (recordParts.lastName) {
        const key = recordParts.lastName.toLowerCase()
        if (!lastNameMap.has(key)) lastNameMap.set(key, [])
        lastNameMap.get(key)!.push(record)
      }
    }

    console.log('[Deal Tracker] Step 2 complete: Lookup maps built from carrier-filtered records')
    
    // STEP 3: Match each policy name using lookup maps (only matches within carrier-filtered records)
    console.log('[Deal Tracker] Step 3: Matching', normalizedNames.length, 'names against carrier-filtered records...')
    let strategyUsed: string = 'none'
    for (let i = 0; i < normalizedNames.length; i++) {
      const normalizedName = normalizedNames[i]
      const parts = nameParts[i]
      strategyUsed = 'none'

      let bestMatch: any = null
      let bestScore = 0

      // Strategy 1: Exact match (highest priority)
      const exactMatches = exactMap.get(normalizedName)
      if (exactMatches && exactMatches.length > 0) {
        bestMatch = exactMatches[0] // Take first (most recent due to ordering)
        bestScore = 100
      }
      // Strategy 2: First + Last name match (canonical key for "First Last" vs "Last, First")
      else if (parts.firstName && parts.lastName && parts.firstLastKey) {
        const matches = firstLastMap.get(parts.firstLastKey)
        if (matches && matches.length > 0) {
          bestMatch = matches[0]
          bestScore = 80
        }
      }
      // Strategy 2b: Last name + fuzzy first name (handles typos: Lakeysha vs Lekeysha vs Leteysha)
      if (!bestMatch && parts.firstName && parts.lastName) {
        const lastNameKey = parts.lastName.toLowerCase()
        const lastMatches = lastNameMap.get(lastNameKey)
        if (lastMatches && lastMatches.length > 0) {
          const policyFirst = parts.firstName.toLowerCase()
          const fuzzyMatches = lastMatches.filter((r: DailyDealFlowRecord) => {
            const rName = normalizeNameForSearch(r.insured_name || '')
            const rParts = extractNameParts(rName)
            const rFirst = (rParts.firstName || '').toLowerCase()
            return rFirst.length > 0 && editDistance(policyFirst, rFirst) <= 2
          })
          if (fuzzyMatches.length > 0) {
            bestMatch = pickBestMatch(fuzzyMatches)
            bestScore = 55
            strategyUsed = 'fuzzyFirst'
          }
        }
      }
      // Strategy 3: First name match
      else if (parts.firstName) {
        const key = parts.firstName.toLowerCase()
        const matches = firstNameMap.get(key)
        if (matches && matches.length > 0) {
          bestMatch = matches[0]
          bestScore = 60
        }
      }
      // Strategy 4: Last name match
      else if (parts.lastName) {
        const key = parts.lastName.toLowerCase()
        const matches = lastNameMap.get(key)
        if (matches && matches.length > 0) {
          bestMatch = matches[0]
          bestScore = 50
        }
      }

      // Only use match if score is reasonable (>= 50)
      if (bestMatch && bestScore >= 50) {
        resultMap.set(normalizedName, {
          call_center: getCallCenter(bestMatch) ?? null,
          phone_number: getPhone(bestMatch) ?? null,
          draft_date: bestMatch.draft_date != null ? String(bestMatch.draft_date).trim() : null,
        })
      }
    }

    console.log('[Deal Tracker] Bulk fetch matched', resultMap.size, 'out of', normalizedNames.length, 'names')
    return resultMap
  } catch (error) {
    console.error('[Deal Tracker] Error in bulk fetch:', error)
    return resultMap
  }
}

/**
 * Bulk fetch daily_deal_flow records for multiple insured names at once.
 * In the browser we call /api/ddf-lookup (server proxy) to avoid CORS with external Supabase.
 */
export async function bulkFetchDailyDealFlowInfo(
  insuredNames: string[],
  carrier: string
): Promise<Map<string, DailyDealFlowInfo>> {
  if (!insuredNames || insuredNames.length === 0) {
    return new Map()
  }
  if (typeof window !== 'undefined') {
    return fetchDdfViaApi(insuredNames, carrier)
  }
  return doBulkFetchDailyDealFlowInfo(getExternalSupabaseClient(), insuredNames, carrier)
}

/**
 * Fetch call center and phone number from daily_deal_flow table (single lookup)
 * Uses flexible name matching to handle variations in name formatting
 * NOTE: For bulk operations, use bulkFetchDailyDealFlowInfo instead
 */
export async function fetchDailyDealFlowInfo(
  insuredName: string | null,
  carrier: string
): Promise<{ call_center: string | null; phone_number: string | null; draft_date: string | null }> {
  if (!insuredName) {
    return { call_center: null, phone_number: null, draft_date: null }
  }

  try {
    const externalSupabase = getExternalSupabaseClient()
    const normalizedName = normalizeNameForSearch(insuredName)
    const { firstName, lastName, allParts } = extractNameParts(normalizedName)
    
    console.log('[Deal Tracker] Searching daily_deal_flow:', {
      originalName: insuredName,
      normalizedName,
      firstName,
      lastName,
      carrier,
    })

    // Try multiple search strategies for better matching
    // Note: Carrier name might be "Aetna" in daily_deal_flow, so try both exact and case-insensitive
    let data: any = null
    let error: any = null

    // Strategy 1: Try exact match first (case-insensitive, full name)
    console.log('[Deal Tracker] Strategy 1: Exact match')
    let result = await externalSupabase
      .from('daily_deal_flow')
      .select('lead_vendor, client_phone_number, draft_date')
      .ilike('insured_name', normalizedName)
      .ilike('carrier', carrier) // Case-insensitive carrier match
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!result.error && result.data) {
      data = result.data
      error = null
    }

    // Strategy 2: Try with partial name match (first + last)
    if ((error || !data) && firstName && lastName && firstName !== lastName) {
      console.log('[Deal Tracker] Strategy 2: First + Last name match')
      const firstLastPattern = `${firstName}%${lastName}`
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', firstLastPattern)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 3: Try partial match with first name
    if ((error || !data) && firstName && firstName.length > 2) {
      console.log('[Deal Tracker] Strategy 3: First name partial match')
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', `${firstName}%`)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 4: Try last name match
    if ((error || !data) && lastName && lastName.length > 2) {
      console.log('[Deal Tracker] Strategy 4: Last name match')
      result = await externalSupabase
        .from('daily_deal_flow')
        .select('lead_vendor, client_phone_number, draft_date')
        .ilike('insured_name', `%${lastName}`)
        .ilike('carrier', carrier)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      
      if (!result.error && result.data) {
        data = result.data
        error = null
      }
    }

    // Strategy 5: Try fuzzy match with any significant name part
    if ((error || !data) && allParts.length > 0) {
      console.log('[Deal Tracker] Strategy 5: Fuzzy match with name parts')
      for (const part of allParts) {
        if (part.length > 2) {
          result = await externalSupabase
            .from('daily_deal_flow')
            .select('lead_vendor, client_phone_number, draft_date')
            .ilike('insured_name', `%${part}%`)
            .ilike('carrier', carrier)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          
          if (!result.error && result.data) {
            data = result.data
            error = null
            break
          }
        }
      }
    }

    if (error || !data) {
      console.warn(
        `[Deal Tracker] No daily_deal_flow entry found after all strategies for insured_name: ${insuredName}, carrier: ${carrier}`
      )
      return { call_center: null, phone_number: null, draft_date: null }
    }

    // Type assertion for external database response
    const ddfData = data as { lead_vendor?: string | null; client_phone_number?: string | null; draft_date?: string | null } | null

    console.log('[Deal Tracker] Found daily_deal_flow match:', {
      insuredName,
      call_center: ddfData?.lead_vendor,
      phone_number: ddfData?.client_phone_number,
    })

    return {
      call_center: ddfData?.lead_vendor || null,
      phone_number: ddfData?.client_phone_number || null,
      draft_date: ddfData?.draft_date != null ? String(ddfData.draft_date).trim() : null,
    }
  } catch (error) {
    console.error('[Deal Tracker] Error fetching daily_deal_flow info:', error)
    return { call_center: null, phone_number: null, draft_date: null }
  }
}

/**
 * Process Aetna commission files and update deal tracker entries
 * Updates existing entries with commission data, or creates new ones if policy exists
 */
export async function processAetnaCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAetnaCommissionsForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  // Get carrier information
  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AETNA'
  const carrierCode = carrier.code || 'AETNA'
  const carrierId = carrier.id

  // Fetch all commissions from the uploaded file
  console.log('[Deal Tracker] Fetching commissions from aetna_commissions...')
  const { data: commissions, error: commissionsError } = await supabase
    .from('aetna_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (commissionsError) {
    console.error('[Deal Tracker] Error fetching commissions:', commissionsError)
    throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
  }

  if (!commissions || commissions.length === 0) {
    console.warn('[Deal Tracker] No commissions found for file_id:', fileId)
    return []
  }

  console.log('[Deal Tracker] Commissions found:', commissions.length)

  // Get unique policy numbers from commissions
  const policyNumbers = Array.from(new Set(commissions.map(c => c.policy_number)))
  
  // Fetch existing deal_tracker entries for these policy numbers
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing entries:', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  // Group commissions by policy_number
  // For deal_value, we should SUM all commission amounts for the same policy
  // But keep the latest commission for other fields (sales_agent, writing_number, etc.)
  const commissionMap = new Map<string, any>()
  const commissionPositiveMap = new Map<string, number>() // Sum of positive commission amounts
  const commissionChargebackMap = new Map<string, number>() // Sum of negative commission amounts (<= 0)
  
  commissions.forEach(comm => {
    const policyNum = comm.policy_number
    if (!policyNum) {
      console.warn('[Deal Tracker] Skipping commission with no policy_number:', comm.id)
      return
    }
    
    const existing = commissionMap.get(policyNum)
    
    // Sum commission amounts, separating positive and negative (chargebacks)
    const commAmount = comm.commissionamount != null 
      ? (typeof comm.commissionamount === 'string' ? parseFloat(comm.commissionamount) : comm.commissionamount)
      : 0
    if (!isNaN(commAmount)) {
      if (commAmount > 0) {
        const currentPos = commissionPositiveMap.get(policyNum) || 0
        commissionPositiveMap.set(policyNum, currentPos + commAmount)
      } else if (commAmount < 0) {
        const currentCb = commissionChargebackMap.get(policyNum) || 0
        commissionChargebackMap.set(policyNum, currentCb + commAmount)
      }
    }
    
    // Use latest commission for other fields (sales_agent, writing_number, etc.)
    if (!existing || (comm.created_at && existing.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })
  
  console.log('[Deal Tracker] Commission aggregation complete:', {
    uniquePolicies: commissionMap.size,
    totalCommissions: commissions.length,
    samplePositive: Array.from(commissionPositiveMap.entries()).slice(0, 5).map(([pn, amt]) => ({ policy: pn, amount: amt })),
    sampleChargebacks: Array.from(commissionChargebackMap.entries()).slice(0, 5).map(([pn, amt]) => ({ policy: pn, amount: amt })),
  })

  // Batch fetch all policies for commissions that don't have deal_tracker entries
  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(
    pn => !existingMap.has(pn)
  )

  let policiesMap = new Map<string, any>()
  if (missingPolicyNumbers.length > 0) {
    console.log('[Deal Tracker] Batch fetching', missingPolicyNumbers.length, 'policies for new entries...')
    const { data: policies, error: policiesError } = await supabase
      .from('aetna_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', missingPolicyNumbers)

    if (!policiesError && policies) {
      policies.forEach(p => {
        policiesMap.set(p.policy_number, p)
      })
      console.log('[Deal Tracker] Found', policies.length, 'policies for new entries')
    }
  }

  // Bulk fetch status mappings and daily_deal_flow for new entries (if needed)
  let statusMappingMap = new Map<string, string>()
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  
  if (missingPolicyNumbers.length > 0) {
    statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
    const policyNamesForDDF = Array.from(policiesMap.values())
      .map(p => p.insuredname)
      .filter(name => name && name.trim().length > 0)
    if (policyNamesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName)
    }
  }

  // Create preview entries for updates/new entries
  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    
    // Calculate financials for this policy:
    // - deal_value: sum of POSITIVE commissions. If that sum is <= 0 and there is an existing row,
    //   KEEP the existing deal_value (do not overwrite with a negative or zero).
    // - charge_back: sum of NEGATIVE commissions (can be null if none).
    const positiveAmount = commissionPositiveMap.get(policyNumber)
    const chargeBack: number | null = commissionChargebackMap.get(policyNumber) ?? null
    let dealValue: number | null
    if (positiveAmount != null && positiveAmount > 0) {
      dealValue = positiveAmount
    } else if (existing && existing.deal_value != null) {
      // No positive commissions in this batch – preserve prior deal_value
      dealValue =
        typeof existing.deal_value === 'number'
          ? existing.deal_value
          : parseFloat(String(existing.deal_value))
    } else {
      dealValue = null
    }
    const ccValue: number | null =
      dealValue !== null && dealValue !== undefined ? dealValue / 2 : null

    console.log(`[Deal Tracker] Processing commission for policy ${policyNumber}:`, {
      existing: !!existing,
      dealValue,
      ccValue,
      singleCommissionAmount: commission.commissionamount,
      positiveAmount,
      chargeBack,
    })

    if (existing) {
      // Update existing entry - policy_status stays from mapping; status considers deal_value and charge_back
      const effectiveChargeBack = chargeBack ?? existing.charge_back ?? null
      const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)
      const entry: DealTrackerPreviewEntry = {
        ...existing,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        policy_status: existing.policy_status,
        status: derivedStatus,
        sales_agent: commission.writingagentname || existing.sales_agent,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
        effective_date: existing.effective_date,
        source_commission_table: 'aetna_commissions',
        source_commission_id: commission.id,
        isNew: false,
        isUpdated: true,
      }
      previewEntries.push(entry)
    } else {
      // Check if policy exists (to create new deal_tracker entry)
      const policy = policiesMap.get(commission.policy_number)
      
      if (policy) {
        // Policy exists but no deal_tracker entry - create new one
        const originalStatus = policy.statusdisplaytext || policy.statuscategory
        const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null

        // Get daily_deal_flow info from bulk fetch map
        const normalizedName = normalizeNameForSearch(policy.insuredname || '')
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        const callCenter = ddfInfo?.call_center || null
        const phoneNumber = ddfInfo?.phone_number || null
        const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

        const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
        const entry: DealTrackerPreviewEntry = {
          agency_carrier_id: agencyCarrierId,
          name: policy.insuredname || null,
          tasks: null,
          ghl_name: null,
          ghl_stage: null,
          policy_status: mappedStatus,
          deal_creation_date: policy.apprecddate || policy.issuedate || null,
          policy_number: commission.policy_number,
          carrier: carrierName,
          carrier_id: carrier.id,
          deal_value: dealValue,
          cc_value: ccValue,
          charge_back: chargeBack,
          notes: null,
          status: derivedStatus,
          last_updated: new Date().toISOString(),
          sales_agent: policy.agentcompletename || commission.writingagentname || null,
          writing_number: policy.agentnumber || commission.writingagentnumber || null,
          commission_type: commission.commissiontype || null,
          effective_date: effectiveDateFromDdf || commission.effectivedate || null,
          call_center: callCenter,
          phone_number: phoneNumber,
          cc_pmt_ws: null,
          cc_cb_ws: null,
          carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
          policy_type: policy.product || null,
          daily_deal_flow_fetched: !!callCenter || !!phoneNumber,
          daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
          source_policy_table: 'aetna_policies',
          source_policy_id: policy.id,
          source_commission_table: 'aetna_commissions',
          source_commission_id: commission.id,
          isNew: true,
          isUpdated: false,
        }
        previewEntries.push(entry)
      }
      // If no policy exists, skip (can't create deal_tracker entry without policy)
    }
  }

  console.log('[Deal Tracker] Commission processing complete:', {
    totalEntries: previewEntries.length,
    newEntries: previewEntries.filter(e => e.isNew).length,
    updatedEntries: previewEntries.filter(e => e.isUpdated && !e.isNew).length,
    sampleEntries: previewEntries.slice(0, 3).map(e => ({
      policy_number: e.policy_number,
      isNew: e.isNew,
      isUpdated: e.isUpdated,
      deal_value: e.deal_value,
      cc_value: e.cc_value,
    })),
  })
  return previewEntries
}

/**
 * Process Aetna carrier files and create deal tracker entries
 */
export async function processAetnaFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAetnaFilesForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  // Get carrier information
  console.log('[Deal Tracker] Fetching agency_carrier info...')
  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AETNA'
  const carrierCode = carrier.code || 'AETNA'
  const carrierId = carrier.id // UUID from carriers table - use this for status mapping

  console.log('[Deal Tracker] Carrier info:', {
    carrierName,
    carrierCode,
    carrierId,
    agencyCarrierId,
  })

  // Fetch all policies from the uploaded file (paginated to exceed Supabase 1000-row default)
  console.log('[Deal Tracker] Fetching policies from aetna_policies...')
  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('aetna_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  console.log('[Deal Tracker] Policies found:', { count: policies?.length || 0, fileId, agencyCarrierId })

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)
  console.log('[Deal Tracker] Fetching commissions for', policyNumbers.length, 'policies')

  let commissions: any[] = []
  try {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('aetna_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (commissionsError: any) {
    console.warn('[Deal Tracker] Failed to fetch commissions:', commissionsError?.message)
  }
  console.log('[Deal Tracker] Commissions found:', commissions?.length || 0)

  const commissionMap = new Map<string, any>()
  commissions.forEach(comm => {
    if (!commissionMap.has(comm.policy_number) ||
        (comm.created_at && commissionMap.get(comm.policy_number)?.created_at < comm.created_at)) {
      commissionMap.set(comm.policy_number, comm)
    }
  })

  let existingEntries: any[] = []
  try {
    existingEntries = await fetchAllPaginated(() =>
      supabase
        .from('deal_tracker')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (existingError: any) {
    console.warn(`Failed to fetch existing entries: ${existingError?.message}`)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  // OPTIMIZATION: Bulk fetch status mappings once (instead of querying for each policy)
  console.log('[Deal Tracker] Bulk fetching status mappings...')
  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  console.log('[Deal Tracker] Status mappings loaded:', statusMappingMap.size, 'mappings')

  // BULK FETCH DDF only for policies that don't already have call_center/phone (skip re-lookup for already-filled rows)
  const policiesNeedingDdf = policies.filter(p => {
    const ex = existingMap.get(p.policy_number)
    return !ex || (ex.call_center == null && ex.phone_number == null)
  })
  const uniqueInsuredNames = Array.from(new Set(
    policiesNeedingDdf.map(p => (p.insuredname || '').trim()).filter(n => n.length > 0)
  ))
  const skipCount = policies.length - policiesNeedingDdf.length
  console.log('[Deal Tracker] Bulk fetching daily_deal_flow for', uniqueInsuredNames.length, 'names (skip', skipCount, 'policies already have call_center/phone)...')
  const dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, carrierName)
  console.log('[Deal Tracker] Bulk fetch complete. Found matches for', dailyDealFlowMap.size, 'out of', uniqueInsuredNames.length, 'names')

  // Process each policy and create deal tracker entries
  console.log('[Deal Tracker] Processing', policies.length, 'policies...')
  const previewEntries: DealTrackerPreviewEntry[] = []

  for (let i = 0; i < policies.length; i++) {
    const policy = policies[i]
    if (i < 3) {
      console.log(`[Deal Tracker] Processing policy ${i + 1}/${policies.length}:`, {
        policy_number: policy.policy_number,
        insuredname: policy.insuredname,
      })
    }
    const commission = commissionMap.get(policy.policy_number)
    const existing = existingMap.get(policy.policy_number)

    // Map policy status using cached mapping (NO database query!)
    const originalStatus = policy.statusdisplaytext || policy.statuscategory
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null
    if (i < 3) {
      console.log(`[Deal Tracker] Status mapping for policy ${i + 1}:`, {
        original: originalStatus,
        mapped: mappedStatus,
        carrierId,
      })
    }

    // Use existing call_center/phone if already set (no re-lookup); else look up DDF for new matches
    const alreadyHasDdf = existing?.call_center != null || existing?.phone_number != null
    let callCenter: string | null
    let phoneNumber: string | null
    let effectiveDateFromDdf: string | null = null
    if (alreadyHasDdf) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
      if (i < 3) console.log(`[Deal Tracker] policy ${i + 1}: using existing DDF (skip lookup)`)
    } else {
      const normalizedName = normalizeNameForSearch(policy.insuredname || '')
      const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
      if (i < 3) {
        console.log(`[Deal Tracker] daily_deal_flow lookup for policy ${i + 1}:`, {
          insuredname: policy.insuredname,
          normalizedName,
          found: !!ddfInfo,
          callCenter,
          phoneNumber,
        })
      }
    }

    // Calculate deal value and CC value.
    // IMPORTANT business rule:
    // - Only update deal_value when the new value is POSITIVE.
    // - When dealValue is 0 or negative, keep the existing deal_value / cc_value in deal_tracker.
    // - When processing policy files without commissions, also preserve existing financials.
    let dealValue: number | null = null
    let ccValue: number | null = null
    if (commission && commission.commissionamount != null) {
      const raw = typeof commission.commissionamount === 'string'
        ? parseFloat(commission.commissionamount)
        : commission.commissionamount
      const parsed = Number.isNaN(raw as number) ? null : (raw as number)
      if (parsed != null && parsed > 0) {
        // Positive commission: update deal tracker financials
        dealValue = parsed
        ccValue = parsed / 2
      } else if (existing) {
        // 0 or negative commission: treat as chargeback/zero, but do NOT overwrite existing amounts
        dealValue = existing.deal_value != null
          ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value)
          : null
        ccValue = existing.cc_value != null
          ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value)
          : (dealValue != null ? dealValue / 2 : null)
        if (Number.isNaN(dealValue as number)) dealValue = null
        if (Number.isNaN(ccValue as number)) ccValue = null
      } else {
        // No existing row and non-positive commission: start with null financials in deal tracker
        dealValue = null
        ccValue = null
      }
    } else if (existing && existing.deal_value != null) {
      // Policy-only flow, keep previously set commission values
      dealValue = typeof existing.deal_value === 'string'
        ? parseFloat(existing.deal_value)
        : existing.deal_value
      ccValue = existing.cc_value != null
        ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value)
        : (dealValue != null ? dealValue / 2 : null)
      if (Number.isNaN(dealValue as number)) dealValue = null
      if (Number.isNaN(ccValue as number)) ccValue = null
    }

    // Effective date preference:
    // 1) draft_date from daily_deal_flow (when available)
    // 2) commission.effectivedate (when we have a commission)
    // 3) existing.effective_date (so policy-only runs don't clear it)
    const effectiveDate =
      effectiveDateFromDdf ||
      (commission?.effectivedate ?? null) ||
      (existing?.effective_date ?? null)

    const derivedStatus = statusFromDealValue(dealValue)
    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: policy.insuredname || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: policy.apprecddate || policy.issuedate || null,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: existing?.charge_back ?? null,
      notes: null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentcompletename || commission?.writingagentname || null,
      writing_number: policy.agentnumber || commission?.writingagentnumber || null,
      commission_type: commission?.commissiontype || null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
      policy_type: policy.product || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'aetna_policies',
      source_policy_id: policy.id,
      source_commission_table: commission ? 'aetna_commissions' : null,
      source_commission_id: commission?.id || null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Processing complete. Total entries:', previewEntries.length)
  console.log('[Deal Tracker] Sample entry:', previewEntries[0] || 'none')

  return previewEntries
}

/**
 * Process AMAM carrier policy files and create deal tracker entries
 */
export async function processAmamFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmamFilesForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('amam_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching AMAM policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No AMAM policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)
  let commissions: any[] = []
  try {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('amam_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (commissionsError: any) {
    console.warn('[Deal Tracker] Failed to fetch AMAM commissions:', commissionsError?.message)
  }

  const commissionMap = new Map<string, any>()
  commissions.forEach(comm => {
    if (!commissionMap.has(comm.policy_number) ||
        (comm.created_at && commissionMap.get(comm.policy_number)?.created_at < comm.created_at)) {
      commissionMap.set(comm.policy_number, comm)
    }
  })

  let existingEntries: any[] = []
  try {
    existingEntries = await fetchAllPaginated(() =>
      supabase
        .from('deal_tracker')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
  } catch (existingError: any) {
    console.warn('[Deal Tracker] Failed to fetch existing deal_tracker entries:', existingError?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  // Only fetch DDF for policies that don't already have call_center/phone (skip re-lookup for already-filled rows)
  const policiesNeedingDdfAmam = policies.filter(p => {
    const ex = existingMap.get(p.policy_number)
    return !ex || (ex.call_center == null && ex.phone_number == null)
  })
  const uniqueInsuredNamesAmam = Array.from(new Set(
    policiesNeedingDdfAmam.map(p => buildAmamInsuredName(p)).filter(n => n.length > 0)
  ))
  const skipCountAmam = policies.length - policiesNeedingDdfAmam.length
  console.log('[Deal Tracker] AMAM: carrier=', carrierName, '| names to DDF=', uniqueInsuredNamesAmam.length, '| skip (already have DDF)=', skipCountAmam)
  console.log('[Deal Tracker] AMAM: sample names sent to DDF (first 10):', uniqueInsuredNamesAmam.slice(0, 10))
  const dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(uniqueInsuredNamesAmam, carrierName)
  console.log('[Deal Tracker] AMAM: DDF map size after fetch:', dailyDealFlowMap.size, 'of', uniqueInsuredNamesAmam.length, 'names')

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const commission = commissionMap.get(policy.policy_number)
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null

    // Use existing call_center/phone if already set (no re-lookup); else look up DDF
    const alreadyHasDdf = existing?.call_center != null || existing?.phone_number != null
    let callCenter: string | null
    let phoneNumber: string | null
    let effectiveDateFromDdf: string | null = null
    if (alreadyHasDdf) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      const normalizedName = normalizeNameForSearch(insuredName)
      const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }

    const entryIndex = previewEntries.length
    if (entryIndex < 3) {
      console.log('[Deal Tracker] AMAM policy sample', entryIndex + 1, '| insuredName:', insuredName, '| normalized:', normalizeNameForSearch(insuredName), '| ddfFound:', !!(callCenter || phoneNumber), '| call_center:', callCenter ?? '(empty)', '| phone:', phoneNumber ?? '(empty)')
    }

    const dealValue = commission?.advance != null
      ? (typeof commission.advance === 'string' ? parseFloat(commission.advance) : commission.advance)
      : null
    const ccValue = dealValue != null ? dealValue / 2 : null
    const dealCreationDate = policy.policydate_raw || policy.app_date_raw || null
    const effectiveDate = effectiveDateFromDdf || null

    const derivedStatus = statusFromDealValue(dealValue)
    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: commission?.writingagent ?? null,
      commission_type: commission?.action ?? null,
      effective_date: commission?.issdate ?? null,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: commission ? 'amam_commissions' : null,
      source_commission_id: commission?.id ?? null,
      isNew: !existing,
      isUpdated: !!existing,
    }
    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] AMAM policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Build AMAM deal tracker preview from in-memory policy rows (deferred write until confirm).
 * Commission data will be empty; source_policy_id/source_commission_id set on confirm after insert.
 */
export async function processAmamFilesForDealTrackerFromRows(
  agencyCarrierId: string,
  fileId: string,
  policyRows: any[]
): Promise<DealTrackerPreviewEntry[]> {
  if (!policyRows || policyRows.length === 0) return []
  const totalStart = Date.now()

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id
  const policyNumbers = policyRows.map((p: any) => p.policy_number)
  const commissionMap = new Map<string, any>()

  let stepStart = Date.now()
  const { data: existingEntries } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)
  console.log('[Deal Tracker] FromRows: existing deal_tracker fetch', policyNumbers.length, 'policies took', Math.round((Date.now() - stepStart) / 1000), 's')
  const existingMap = new Map<string, any>()
  if (existingEntries) existingEntries.forEach((e: any) => existingMap.set(e.policy_number, e))

  stepStart = Date.now()
  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  console.log('[Deal Tracker] FromRows: status mappings took', Math.round((Date.now() - stepStart) / 1000), 's')

  const policiesNeedingDdfAmam = policyRows.filter((p: any) => {
    const ex = existingMap.get(p.policy_number)
    return !ex || (ex.call_center == null && ex.phone_number == null)
  })
  const uniqueInsuredNamesAmam = Array.from(new Set(
    policiesNeedingDdfAmam.map((p: any) => buildAmamInsuredName(p)).filter((n: string) => n.length > 0)
  ))
  if (uniqueInsuredNamesAmam.length > 0) {
    console.log('[Deal Tracker] FromRows: fetching DDF for', uniqueInsuredNamesAmam.length, 'names (slow step for large files)...')
  }
  stepStart = Date.now()
  const dailyDealFlowMap = uniqueInsuredNamesAmam.length > 0
    ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNamesAmam, carrierName)
    : new Map<string, DailyDealFlowInfo>()
  if (uniqueInsuredNamesAmam.length > 0) {
    console.log('[Deal Tracker] FromRows: DDF fetch took', Math.round((Date.now() - stepStart) / 1000), 's')
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  for (const policy of policyRows) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null
    const alreadyHasDdf = existing?.call_center != null || existing?.phone_number != null
    let callCenter: string | null
    let phoneNumber: string | null
    let effectiveDateFromDdf: string | null = null
    if (alreadyHasDdf) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      const normalizedName = normalizeNameForSearch(insuredName)
      const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }
    const dealCreationDate = policy.policydate_raw || policy.app_date_raw || null
    const effectiveDate = effectiveDateFromDdf || null
    const derivedStatus = statusFromDealValue(null)
    previewEntries.push({
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: null,
      cc_value: null,
      notes: null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'amam_policies',
      source_policy_id: null,
      source_commission_table: null,
      source_commission_id: null,
      isNew: !existing,
      isUpdated: !!existing,
    })
  }
  console.log('[Deal Tracker] FromRows: policy preview built in', Math.round((Date.now() - totalStart) / 1000), 's total')
  return previewEntries
}

/**
 * Process AMAM commission files and update deal tracker entries
 */
export async function processAmamCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmamCommissionsForDealTracker called', {
    agencyCarrierId,
    fileId,
  })

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) {
    console.error('[Deal Tracker] Failed to fetch agency_carrier:', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  const { data: commissions, error: commissionsError } = await supabase
    .from('amam_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (commissionsError) {
    console.error('[Deal Tracker] Error fetching AMAM commissions:', commissionsError)
    throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
  }

  if (!commissions || commissions.length === 0) {
    console.warn('[Deal Tracker] No AMAM commissions found for file_id:', fileId)
    return []
  }

  const policyNumbers = Array.from(new Set(commissions.map(c => c.policy_number)))
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing entries:', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissions.forEach(comm => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const amount = comm.advance != null
      ? (typeof comm.advance === 'string' ? parseFloat(comm.advance) : comm.advance)
      : 0
    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + (Number.isNaN(amount) ? 0 : amount))
    if (!commissionMap.has(policyNum) || (comm.created_at && commissionMap.get(policyNum)?.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })

  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(pn => !existingMap.has(pn))
  const existingNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const ex = existingMap.get(pn)
    return ex && ex.call_center == null && ex.phone_number == null
  })
  const allPolicyNumbersNeedingDDF = Array.from(new Set([...missingPolicyNumbers, ...existingNeedingDDF]))
  const existingCount = Array.from(commissionMap.keys()).filter(pn => existingMap.has(pn)).length
  console.log('[Deal Tracker] AMAM commissions: commissions=', commissionMap.size, '| in deal_tracker=', existingCount, '| missing (new)=', missingPolicyNumbers.length, '| existing needing DDF=', existingNeedingDDF.length)

  let policiesMap = new Map<string, any>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const { data: policies } = await supabase
      .from('amam_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', allPolicyNumbersNeedingDDF)
    if (policies) {
      policies.forEach(p => {
        policiesMap.set(p.policy_number, p)
      })
    }
    console.log('[Deal Tracker] AMAM commissions: loaded', policiesMap.size, 'policy rows from amam_policies for', allPolicyNumbersNeedingDDF.length, 'policy numbers needing DDF')
  }

  let statusMappingMap = new Map<string, string>()
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  if (missingPolicyNumbers.length > 0) {
    statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  }
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = Array.from(policiesMap.values())
      .map(p => buildAmamInsuredName(p))
      .filter(name => name.length > 0)
    if (policyNamesForDDF.length > 0) {
      console.log('[Deal Tracker] AMAM commissions: fetching DDF for', policyNamesForDDF.length, 'names (missing + existing without call_center/phone) | sample:', policyNamesForDDF.slice(0, 5))
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName)
      console.log('[Deal Tracker] AMAM commissions: DDF map size:', dailyDealFlowMap.size, 'of', policyNamesForDDF.length)
    } else {
      console.log('[Deal Tracker] AMAM commissions: no policy names for DDF – upload policy file first so amam_policies has rows for these policy numbers')
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  let newEntryLogCount = 0

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const totalAmount = commissionAmountsMap.get(policyNumber)
    const dealValue = totalAmount !== undefined && totalAmount !== null
      ? totalAmount
      : (commission.advance != null ? (typeof commission.advance === 'string' ? parseFloat(commission.advance) : commission.advance) : null)
    const ccValue = dealValue != null ? dealValue / 2 : null

    if (existing) {
      let callCenter = existing.call_center
      let phoneNumber = existing.phone_number
      let dailyDealFlowFetched = existing.daily_deal_flow_fetched
      let dailyDealFlowFetchedAt = existing.daily_deal_flow_fetched_at
      const policy = policiesMap.get(policyNumber)
      if (policy && (callCenter == null && phoneNumber == null)) {
        const insuredName = buildAmamInsuredName(policy)
        const normalizedName = normalizeNameForSearch(insuredName)
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        if (ddfInfo) {
          callCenter = ddfInfo.call_center ?? null
          phoneNumber = ddfInfo.phone_number ?? null
          dailyDealFlowFetched = !!(callCenter || phoneNumber)
          dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
        }
      }
      previewEntries.push({
        ...existing,
        deal_value: dealValue,
        cc_value: ccValue,
        writing_number: commission.writingagent ?? existing.writing_number,
        commission_type: commission.action ?? existing.commission_type,
        effective_date: commission.issdate !== null && commission.issdate !== undefined ? commission.issdate : existing.effective_date,
        call_center: callCenter,
        phone_number: phoneNumber,
        daily_deal_flow_fetched: dailyDealFlowFetched,
        daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
        source_commission_table: 'amam_commissions',
        source_commission_id: commission.id,
        isNew: false,
        isUpdated: true,
      })
      continue
    }

    const policy = policiesMap.get(policyNumber)
    if (!policy) continue

    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = dailyDealFlowMap.get(normalizedName)
    const callCenter = ddfInfo?.call_center ?? null
    const phoneNumber = ddfInfo?.phone_number ?? null
    const dealCreationDate = policy.policydate_raw || policy.app_date_raw || null

    if (newEntryLogCount < 3) {
      console.log('[Deal Tracker] AMAM commission new-entry sample', newEntryLogCount + 1, '| insuredName:', insuredName, '| normalized:', normalizedName, '| ddfFound:', !!(callCenter || phoneNumber), '| call_center:', callCenter ?? '(empty)', '| phone:', phoneNumber ?? '(empty)')
      newEntryLogCount++
    }

    const derivedStatus = statusFromDealValue(dealValue)
    previewEntries.push({
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: dealCreationDate,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: commission.writingagent || null,
      commission_type: commission.action || null,
      effective_date: commission.issdate || null,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: 'amam_commissions',
      source_commission_id: commission.id,
      isNew: true,
      isUpdated: false,
    })
  }

  console.log('[Deal Tracker] AMAM commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Build AMAM commission deal tracker preview from in-memory commission rows (deferred write until confirm).
 * Loads policies from DB for names/DDF; source_commission_id set on confirm after insert.
 */
export async function processAmamCommissionsForDealTrackerFromRows(
  agencyCarrierId: string,
  fileId: string,
  commissionRows: any[]
): Promise<DealTrackerPreviewEntry[]> {
  if (!commissionRows || commissionRows.length === 0) return []

  const { data: agencyCarrier, error: acError } = await supabase
    .from('agency_carriers')
    .select(`
      id,
      carrier_id,
      carriers (
        id,
        name,
        code
      )
    `)
    .eq('id', agencyCarrierId)
    .single()

  if (acError || !agencyCarrier) throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AMAM'
  const carrierCode = carrier.code || 'AMAM'
  const carrierId = carrier.id

  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissionRows.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const amount = comm.advance != null ? (typeof comm.advance === 'string' ? parseFloat(comm.advance) : comm.advance) : 0
    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + (Number.isNaN(amount) ? 0 : amount))
    if (!commissionMap.has(policyNum) || (comm.created_at && commissionMap.get(policyNum)?.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })

  const policyNumbers = Array.from(commissionMap.keys())
  const { data: existingEntries } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)
  const existingMap = new Map<string, any>()
  if (existingEntries) existingEntries.forEach((e: any) => existingMap.set(e.policy_number, e))

  const missingPolicyNumbers = Array.from(commissionMap.keys()).filter(pn => !existingMap.has(pn))
  const existingNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const ex = existingMap.get(pn)
    return ex && ex.call_center == null && ex.phone_number == null
  })
  const allPolicyNumbersNeedingDDF = Array.from(new Set([...missingPolicyNumbers, ...existingNeedingDDF]))
  let policiesMap = new Map<string, any>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const { data: policies } = await supabase
      .from('amam_policies')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .in('policy_number', allPolicyNumbersNeedingDDF)
    if (policies) policies.forEach((p: any) => policiesMap.set(p.policy_number, p))
  }

  let statusMappingMap = new Map<string, string>()
  if (missingPolicyNumbers.length > 0) {
    statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  }
  let dailyDealFlowMap = new Map<string, DailyDealFlowInfo>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = Array.from(policiesMap.values()).map((p: any) => buildAmamInsuredName(p)).filter((n: string) => n.length > 0)
    if (policyNamesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []
  let newEntryLogCount = 0

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const totalAmount = commissionAmountsMap.get(policyNumber)
    const dealValue = totalAmount !== undefined && totalAmount !== null ? totalAmount : (commission.advance != null ? (typeof commission.advance === 'string' ? parseFloat(commission.advance) : commission.advance) : null)
    const ccValue = dealValue != null ? dealValue / 2 : null

    if (existing) {
      let callCenter = existing.call_center
      let phoneNumber = existing.phone_number
      let dailyDealFlowFetched = existing.daily_deal_flow_fetched
      let dailyDealFlowFetchedAt = existing.daily_deal_flow_fetched_at
      const policy = policiesMap.get(policyNumber)
      if (policy && (callCenter == null && phoneNumber == null)) {
        const insuredName = buildAmamInsuredName(policy)
        const normalizedName = normalizeNameForSearch(insuredName)
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        if (ddfInfo) {
          callCenter = ddfInfo.call_center ?? null
          phoneNumber = ddfInfo.phone_number ?? null
          dailyDealFlowFetched = !!(callCenter || phoneNumber)
          dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
        }
      }
      previewEntries.push({
        ...existing,
        deal_value: dealValue,
        cc_value: ccValue,
        writing_number: commission.writingagent ?? existing.writing_number,
        commission_type: commission.action ?? existing.commission_type,
        effective_date: commission.issdate !== null && commission.issdate !== undefined ? commission.issdate : existing.effective_date,
        call_center: callCenter,
        phone_number: phoneNumber,
        daily_deal_flow_fetched: dailyDealFlowFetched,
        daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
        source_commission_table: 'amam_commissions',
        source_commission_id: null,
        isNew: false,
        isUpdated: true,
      })
      continue
    }

    const policy = policiesMap.get(policyNumber)
    if (!policy) continue

    const insuredName = buildAmamInsuredName(policy)
    const originalStatus = policy.status_raw || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = dailyDealFlowMap.get(normalizedName)
    const callCenter = ddfInfo?.call_center ?? null
    const phoneNumber = ddfInfo?.phone_number ?? null
    const dealCreationDate = policy.policydate_raw || policy.app_date_raw || null
    previewEntries.push({
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: dealCreationDate,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentname_raw || null,
      writing_number: commission.writingagent || null,
      commission_type: commission.action || null,
      effective_date: commission.issdate || null,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.plan || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
      source_policy_table: 'amam_policies',
      source_policy_id: policy.id,
      source_commission_table: 'amam_commissions',
      source_commission_id: null,
      isNew: true,
      isUpdated: false,
    })
  }
  return previewEntries
}

/**
 * Derive policy_status from deal_value per business rules:
 * Rule-based Status helper (for `status` column, NOT `policy_status`).
 * - deal_value null or 0 -> "NOT yet paid"
 * - deal_value negative -> "Charge Back"
 * - deal_value positive -> "Paid"
 */
export function statusFromDealValue(
  dealValue: number | null | undefined,
): string | null {
  if (dealValue == null) return 'NOT yet paid'
  const num = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
  if (Number.isNaN(num)) return 'NOT yet paid'
  if (num < 0) return 'Charge Back'
  if (num === 0) return 'NOT yet paid'
  return 'Paid'
}

/**
 * Derive status from deal_value and charge_back. If there is a chargeback (negative amount),
 * status is "Charge Back" regardless of deal_value; otherwise same as statusFromDealValue(deal_value).
 */
export function statusFromDealValueAndChargeback(
  dealValue: number | null | undefined,
  chargeBack: number | null | undefined,
): string | null {
  const cb = chargeBack != null ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack))) : null
  if (cb != null && !Number.isNaN(cb) && cb < 0) return 'Charge Back'
  return statusFromDealValue(dealValue)
}

/**
 * Save deal tracker entries to database using batched upserts.
 * Uses onConflict (agency_carrier_id, policy_number) so inserts + updates
 * happen in a few bulk calls instead of hundreds of individual updates.
 * - When incoming deal_value is 0, we preserve existing deal_value and policy_status (do not overwrite with 0).
   * - `policy_status` comes from carrier_status_mapping (mapped status from carrier).
   * - `status` is derived from deal_value via statusFromDealValue (NOT yet paid / Charge Back / Paid).
 */
export async function saveDealTrackerEntries(
  entries: DealTrackerEntry[] | DealTrackerPreviewEntry[],
  options?: { onProgress?: (msg: string) => void }
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (!entries || entries.length === 0) {
    return { inserted: 0, updated: 0, failed: 0 }
  }

  const log = (msg: string) => {
    console.log('[Deal Tracker]', msg)
    options?.onProgress?.(msg)
  }

  log(`Starting batch save for ${entries.length.toLocaleString()} entries...`)

  // Clean entries: remove preview-only and auto-managed fields
  const now = new Date().toISOString()
  let cleanEntries = entries.map(entry => {
    const { isNew, isUpdated, id, created_at, updated_at, ...dbEntry } = entry as any
    return {
      ...dbEntry,
      updated_at: now,
    }
  })

  // When incoming deal_value is 0, preserve existing deal_value and policy_status (do not overwrite with 0)
  const needsDealValuePreserve = cleanEntries.filter(
    e => e.agency_carrier_id && e.policy_number && (e.deal_value === 0 || e.deal_value === '0')
  )
  if (needsDealValuePreserve.length > 0) {
    const keySet = new Set(needsDealValuePreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsDealValuePreserve.map(e => e.agency_carrier_id))]
    const existingMap = new Map<string, { deal_value: number | null; policy_status: string | null }>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, deal_value, policy_status')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows) {
          const key = `${row.agency_carrier_id}\0${row.policy_number}`
          if (keySet.has(key)) {
            const dv = row.deal_value != null ? (typeof row.deal_value === 'string' ? parseFloat(row.deal_value) : row.deal_value) : null
            existingMap.set(key, { deal_value: Number.isNaN(dv as number) ? null : (dv as number), policy_status: row.policy_status ?? null })
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if (!e.agency_carrier_id || !e.policy_number) return e
      const key = `${e.agency_carrier_id}\0${e.policy_number}`
      if (e.deal_value !== 0 && e.deal_value !== '0') return e
      const preserved = existingMap.get(key)
      if (preserved == null) return e
      return { ...e, deal_value: preserved.deal_value, policy_status: preserved.policy_status }
    })
  }

  // Derive rule-based status from deal_value and charge_back (NOT yet paid / Charge Back / Paid)
  cleanEntries = cleanEntries.map(e => {
    const dv = e.deal_value != null ? (typeof e.deal_value === 'number' ? e.deal_value : parseFloat(String(e.deal_value))) : null
    const cb = e.charge_back != null ? (typeof e.charge_back === 'number' ? e.charge_back : parseFloat(String(e.charge_back))) : null
    const status = statusFromDealValueAndChargeback(dv, cb)
    return { ...e, status }
  })

  // Preserve effective_date from DB when incoming is null/empty (e.g. DDF-sourced value should not be overwritten on updates)
  const needsEffectiveDatePreserve = cleanEntries.filter(
    e => (e.effective_date == null || e.effective_date === '') && e.agency_carrier_id && e.policy_number
  )
  if (needsEffectiveDatePreserve.length > 0) {
    const keySet = new Set(needsEffectiveDatePreserve.map(e => `${e.agency_carrier_id}\0${e.policy_number}`))
    const agencyCarrierIds = [...new Set(needsEffectiveDatePreserve.map(e => e.agency_carrier_id))]
    const existingMap = new Map<string, string>()
    const CHUNK = 100
    for (let i = 0; i < agencyCarrierIds.length; i += CHUNK) {
      const ids = agencyCarrierIds.slice(i, i + CHUNK)
      const { data: rows } = await supabase
        .from('deal_tracker')
        .select('agency_carrier_id, policy_number, effective_date')
        .in('agency_carrier_id', ids)
      if (rows) {
        for (const row of rows) {
          if (row.effective_date != null && row.effective_date !== '' && keySet.has(`${row.agency_carrier_id}\0${row.policy_number}`)) {
            existingMap.set(`${row.agency_carrier_id}\0${row.policy_number}`, row.effective_date)
          }
        }
      }
    }
    cleanEntries = cleanEntries.map(e => {
      if ((e.effective_date != null && e.effective_date !== '') || !e.agency_carrier_id || !e.policy_number) return e
      const preserved = existingMap.get(`${e.agency_carrier_id}\0${e.policy_number}`)
      if (preserved == null) return e
      return { ...e, effective_date: preserved }
    })
  }

  const BATCH_SIZE = 500
  let saved = 0
  let failed = 0

  const totalBatches = Math.ceil(cleanEntries.length / BATCH_SIZE)

  for (let i = 0; i < cleanEntries.length; i += BATCH_SIZE) {
    const batchNum = i / BATCH_SIZE + 1
    const batch = cleanEntries.slice(i, i + BATCH_SIZE)
    log(`Saving batch ${batchNum}/${totalBatches} (${batch.length.toLocaleString()} rows)...`)

    const { error } = await supabase
      .from('deal_tracker')
      .upsert(batch, { onConflict: 'agency_carrier_id,policy_number', ignoreDuplicates: false })

    if (error) {
      console.error('[Deal Tracker] Batch save failed:', error)
      failed += batch.length
      log(`Batch ${batchNum} failed: ${error.message || 'unknown error'}`)
    } else {
      saved += batch.length
      log(`Saved ${saved.toLocaleString()}/${cleanEntries.length.toLocaleString()} rows`)
    }
  }

  log(`Batch save complete. Saved ${saved.toLocaleString()} rows, failed ${failed.toLocaleString()}.`)

  // We no longer distinguish inserted vs updated here; both are "saved".
  return { inserted: saved, updated: 0, failed }
}

/**
 * Fallback: Save entries individually (slower but more reliable)
 */
async function saveDealTrackerEntriesIndividual(
  entries: DealTrackerEntry[] | DealTrackerPreviewEntry[]
): Promise<{ inserted: number; updated: number; failed: number }> {
  let inserted = 0
  let updated = 0
  let failed = 0

  for (const entry of entries) {
    try {
      const { isNew, isUpdated, id, created_at, updated_at, ...dbEntry } = entry as any
      
      const { data: existing, error: checkError } = await supabase
        .from('deal_tracker')
        .select('id')
        .eq('agency_carrier_id', dbEntry.agency_carrier_id)
        .eq('policy_number', dbEntry.policy_number)
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') {
        console.error(`Failed to check existing entry for policy ${dbEntry.policy_number}:`, checkError)
      }

      if (existing) {
        const { error } = await supabase
          .from('deal_tracker')
          .update(dbEntry)
          .eq('id', existing.id)

        if (error) {
          console.error(`Failed to update entry for policy ${dbEntry.policy_number}:`, error)
          failed++
        } else {
          updated++
        }
      } else {
        const { error } = await supabase
          .from('deal_tracker')
          .insert(dbEntry)

        if (error) {
          console.error(`Failed to insert entry for policy ${dbEntry.policy_number}:`, error)
          failed++
        } else {
          inserted++
        }
      }
    } catch (error) {
      console.error(`Error processing entry for policy ${(entry as any).policy_number}:`, error)
      failed++
    }
  }

  return { inserted, updated, failed }
}

/**
 * Get all deal tracker entries.
 * When limit > 1000, fetches in pages (Supabase returns at most 1000 rows per request).
 */
export async function getDealTrackerEntries(filters?: {
  agency_carrier_id?: string
  carrier?: string
  policy_status?: string
  limit?: number
  offset?: number
}) {
  const requestedLimit = filters?.limit ?? 1000
  const offset = filters?.offset ?? 0

  const buildQuery = () => {
    let q = supabase
      .from('deal_tracker')
      .select(`
        *,
        agency_carriers (
          id,
          agencies (
            id,
            name
          ),
          carriers (
            id,
            name
          )
        )
      `)
      .order('created_at', { ascending: false })

    if (filters?.agency_carrier_id) {
      q = q.eq('agency_carrier_id', filters.agency_carrier_id)
    }
    if (filters?.carrier) {
      q = q.eq('carrier', filters.carrier)
    }
    if (filters?.policy_status) {
      q = q.eq('policy_status', filters.policy_status)
    }
    return q
  }

  const enrichStatus = (row: any) => ({
    ...row,
    status: statusFromDealValueAndChargeback(row?.deal_value, row?.charge_back) ?? row?.status,
  })

  // Supabase caps at 1000 rows per request; paginate when we need more
  if (requestedLimit > SUPABASE_PAGE_SIZE) {
    const allRows = await fetchAllPaginated(() => buildQuery())
    const withOffset = offset > 0 ? allRows.slice(offset, offset + requestedLimit) : allRows.slice(0, requestedLimit)
    return withOffset.map(enrichStatus)
  }

  let query = buildQuery()
  if (requestedLimit) {
    query = query.limit(requestedLimit)
  }
  if (offset > 0) {
    query = query.range(offset, offset + (requestedLimit || 100) - 1)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to fetch deal tracker entries: ${error.message}`)
  }

  return (data || []).map(enrichStatus)
}
