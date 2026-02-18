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

/**
 * Bulk fetch all status mappings for a carrier (OPTIMIZED)
 * Returns a Map of status -> mapped_status for fast lookups
 */
async function bulkFetchStatusMappings(
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
 * Normalize name for better matching (remove extra spaces, handle middle initials)
 */
function normalizeNameForSearch(name: string): string {
  if (!name) return ''
  // Remove extra spaces, normalize to single spaces
  return name.replace(/\s+/g, ' ').trim()
}

/**
 * Extract first and last name for flexible matching
 */
function extractNameParts(fullName: string): { firstName: string; lastName: string; allParts: string[] } {
  const normalized = normalizeNameForSearch(fullName)
  const parts = normalized.split(' ').filter(p => p.length > 0)
  
  if (parts.length === 0) {
    return { firstName: '', lastName: '', allParts: [] }
  }
  
  const firstName = parts[0]
  const lastName = parts[parts.length - 1] // Last part is usually last name
  const allParts = parts.filter((p, i) => i === 0 || i === parts.length - 1) // First and last
  
  return { firstName, lastName, allParts }
}

/**
 * Bulk fetch daily_deal_flow records for multiple insured names at once
 * Returns a Map of normalized name -> { call_center, phone_number }
 */
async function bulkFetchDailyDealFlowInfo(
  insuredNames: string[],
  carrier: string
): Promise<Map<string, { call_center: string | null; phone_number: string | null }>> {
  const resultMap = new Map<string, { call_center: string | null; phone_number: string | null }>()
  
  if (!insuredNames || insuredNames.length === 0) {
    return resultMap
  }

  try {
    const externalSupabase = getExternalSupabaseClient()
    
    // Normalize all names and create search patterns
    const normalizedNames = insuredNames.map(n => normalizeNameForSearch(n))
    const nameParts = normalizedNames.map(n => extractNameParts(n))
    
    console.log('[Deal Tracker] Bulk fetching daily_deal_flow for carrier:', carrier, 'names:', normalizedNames.length)
    
    // STEP 1: FIRST filter by carrier (most important - reduces dataset significantly)
    console.log('[Deal Tracker] Step 1: Filtering daily_deal_flow records by carrier:', carrier)
    const { data: allRecords, error } = await externalSupabase
      .from('daily_deal_flow')
      .select('insured_name, lead_vendor, client_phone_number, carrier')
      .ilike('carrier', carrier) // Filter by carrier FIRST before any name matching
      .order('created_at', { ascending: false })
      .limit(10000) // Reasonable limit

    if (error) {
      console.error('[Deal Tracker] Error bulk fetching daily_deal_flow:', error)
      return resultMap
    }

    if (!allRecords || allRecords.length === 0) {
      console.log('[Deal Tracker] No daily_deal_flow records found for carrier:', carrier)
      return resultMap
    }

    // Type assertion for external database records
    type DailyDealFlowRecord = {
      insured_name: string | null
      lead_vendor: string | null
      client_phone_number: string | null
      carrier: string | null
    }
    const typedRecords = allRecords as DailyDealFlowRecord[]

    console.log('[Deal Tracker] Step 1 complete: Fetched', typedRecords.length, 'records filtered by carrier:', carrier)
    
    // STEP 2: Build lookup maps from carrier-filtered records only
    console.log('[Deal Tracker] Step 2: Building lookup maps from carrier-filtered records...')
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
      
      // First + Last map
      if (recordParts.firstName && recordParts.lastName) {
        const key = `${recordParts.firstName}|${recordParts.lastName}`.toLowerCase()
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
    for (let i = 0; i < normalizedNames.length; i++) {
      const normalizedName = normalizedNames[i]
      const parts = nameParts[i]
      
      let bestMatch: any = null
      let bestScore = 0

      // Strategy 1: Exact match (highest priority)
      const exactMatches = exactMap.get(normalizedName)
      if (exactMatches && exactMatches.length > 0) {
        bestMatch = exactMatches[0] // Take first (most recent due to ordering)
        bestScore = 100
      }
      // Strategy 2: First + Last name match
      else if (parts.firstName && parts.lastName) {
        const key = `${parts.firstName}|${parts.lastName}`.toLowerCase()
        const matches = firstLastMap.get(key)
        if (matches && matches.length > 0) {
          bestMatch = matches[0]
          bestScore = 80
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
          call_center: bestMatch.lead_vendor || null,
          phone_number: bestMatch.client_phone_number || null,
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
 * Fetch call center and phone number from daily_deal_flow table (single lookup)
 * Uses flexible name matching to handle variations in name formatting
 * NOTE: For bulk operations, use bulkFetchDailyDealFlowInfo instead
 */
export async function fetchDailyDealFlowInfo(
  insuredName: string | null,
  carrier: string
): Promise<{ call_center: string | null; phone_number: string | null }> {
  if (!insuredName) {
    return { call_center: null, phone_number: null }
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
      .select('lead_vendor, client_phone_number')
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
        .select('lead_vendor, client_phone_number')
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
        .select('lead_vendor, client_phone_number')
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
        .select('lead_vendor, client_phone_number')
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
            .select('lead_vendor, client_phone_number')
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
      console.warn(`[Deal Tracker] No daily_deal_flow entry found after all strategies for insured_name: ${insuredName}, carrier: ${carrier}`)
      return { call_center: null, phone_number: null }
    }

    // Type assertion for external database response
    const ddfData = data as { lead_vendor?: string | null; client_phone_number?: string | null } | null

    console.log('[Deal Tracker] Found daily_deal_flow match:', {
      insuredName,
      call_center: ddfData?.lead_vendor,
      phone_number: ddfData?.client_phone_number,
    })

    return {
      call_center: ddfData?.lead_vendor || null,
      phone_number: ddfData?.client_phone_number || null,
    }
  } catch (error) {
    console.error('[Deal Tracker] Error fetching daily_deal_flow info:', error)
    return { call_center: null, phone_number: null }
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
  const commissionAmountsMap = new Map<string, number>() // Track sum of commission amounts
  
  commissions.forEach(comm => {
    const policyNum = comm.policy_number
    if (!policyNum) {
      console.warn('[Deal Tracker] Skipping commission with no policy_number:', comm.id)
      return
    }
    
    const existing = commissionMap.get(policyNum)
    
    // Sum commission amounts (deal_value should be total of all commissions)
    // Handle null/undefined/string commission amounts
    const commAmount = comm.commissionamount != null 
      ? (typeof comm.commissionamount === 'string' ? parseFloat(comm.commissionamount) : comm.commissionamount)
      : 0
    const currentAmount = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, currentAmount + (isNaN(commAmount) ? 0 : commAmount))
    
    // Use latest commission for other fields (sales_agent, writing_number, etc.)
    if (!existing || (comm.created_at && existing.created_at < comm.created_at)) {
      commissionMap.set(policyNum, comm)
    }
  })
  
  console.log('[Deal Tracker] Commission aggregation complete:', {
    uniquePolicies: commissionMap.size,
    totalCommissions: commissions.length,
    sampleAmounts: Array.from(commissionAmountsMap.entries()).slice(0, 5).map(([pn, amt]) => ({ policy: pn, amount: amt })),
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
  let dailyDealFlowMap = new Map<string, { call_center: string | null; phone_number: string | null }>()
  
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
    
    // Calculate deal value (SUM of all commissions for this policy) and CC value
    const totalCommissionAmount = commissionAmountsMap.get(policyNumber)
    // Use totalCommissionAmount if it exists (even if 0), otherwise use single commission amount
    const dealValue = totalCommissionAmount !== undefined && totalCommissionAmount !== null 
      ? totalCommissionAmount 
      : (commission.commissionamount || null)
    const ccValue = dealValue !== null && dealValue !== undefined ? dealValue / 2 : null

    console.log(`[Deal Tracker] Processing commission for policy ${policyNumber}:`, {
      existing: !!existing,
      dealValue,
      ccValue,
      singleCommissionAmount: commission.commissionamount,
      totalCommissionAmount,
      commissionAmountsMapSize: commissionAmountsMap.size,
    })

    if (existing) {
      // Update existing entry - always update deal_value, cc_value, and effective_date from commissions
      const entry: DealTrackerPreviewEntry = {
        ...existing,
        deal_value: dealValue, // Always update from commission (even if null, to clear old values)
        cc_value: ccValue,
        sales_agent: commission.writingagentname || existing.sales_agent,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
        effective_date: commission.effectivedate !== null && commission.effectivedate !== undefined 
          ? commission.effectivedate 
          : existing.effective_date, // Update from commission if available, otherwise keep existing
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

        const entry: DealTrackerPreviewEntry = {
          agency_carrier_id: agencyCarrierId,
          name: policy.insuredname || null,
          tasks: null,
          ghl_name: null,
          ghl_stage: null,
          policy_status: mappedStatus,
          deal_creation_date: policy.issuedate || null,
          policy_number: commission.policy_number,
          carrier: carrierName,
          carrier_id: carrier.id,
          deal_value: dealValue,
          cc_value: ccValue,
          notes: null,
          status: null,
          last_updated: new Date().toISOString(),
          sales_agent: commission.writingagentname || null,
          writing_number: commission.writingagentnumber || null,
          commission_type: commission.commissiontype || null,
          effective_date: commission.effectivedate || null,
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

  // Fetch all policies from the uploaded file
  console.log('[Deal Tracker] Fetching policies from aetna_policies...')
  const { data: policies, error: policiesError } = await supabase
    .from('aetna_policies')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (policiesError) {
    console.error('[Deal Tracker] Error fetching policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError.message}`)
  }

  console.log('[Deal Tracker] Policies found:', {
    count: policies?.length || 0,
    fileId,
    agencyCarrierId,
  })

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No policies found for file_id:', fileId)
    return []
  }

  // Fetch commissions for matching policy numbers
  const policyNumbers = policies.map(p => p.policy_number)
  console.log('[Deal Tracker] Fetching commissions for', policyNumbers.length, 'policies')
  
  const { data: commissions, error: commissionsError } = await supabase
    .from('aetna_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (commissionsError) {
    console.warn('[Deal Tracker] Failed to fetch commissions:', commissionsError.message)
  } else {
    console.log('[Deal Tracker] Commissions found:', commissions?.length || 0)
  }

  // Create a map of policy_number -> commission
  const commissionMap = new Map<string, any>()
  if (commissions) {
    commissions.forEach(comm => {
      // Use the latest commission for each policy
      if (!commissionMap.has(comm.policy_number) || 
          (comm.created_at && commissionMap.get(comm.policy_number)?.created_at < comm.created_at)) {
        commissionMap.set(comm.policy_number, comm)
      }
    })
  }

  // Check existing deal tracker entries
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn(`Failed to fetch existing entries: ${existingError.message}`)
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

  // BULK FETCH: Get all daily_deal_flow records for all insured names at once
  console.log('[Deal Tracker] Bulk fetching daily_deal_flow records...')
  const uniqueInsuredNames = Array.from(new Set(
    policies
      .map(p => p.insuredname)
      .filter(name => name && name.trim().length > 0)
  ))
  
  console.log('[Deal Tracker] Unique insured names to search:', uniqueInsuredNames.length)
  
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

    // Get daily_deal_flow info from bulk fetch map (only if not already fetched)
    let callCenter: string | null = null
    let phoneNumber: string | null = null
    
    if (!existing || !existing.daily_deal_flow_fetched) {
      // Use bulk fetch map
      const normalizedName = normalizeNameForSearch(policy.insuredname || '')
      const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center || null
      phoneNumber = ddfInfo?.phone_number || null
      
      if (i < 3) {
        console.log(`[Deal Tracker] daily_deal_flow lookup for policy ${i + 1}:`, {
          insuredname: policy.insuredname,
          normalizedName,
          found: !!ddfInfo,
          callCenter,
          phoneNumber,
        })
      }
    } else {
      callCenter = existing.call_center
      phoneNumber = existing.phone_number
      if (i < 3) {
        console.log(`[Deal Tracker] Using existing daily_deal_flow for policy ${i + 1}`)
      }
    }

    // Calculate deal value and CC value
    const dealValue = commission?.commissionamount || null
    const ccValue = dealValue ? dealValue / 2 : null

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: policy.insuredname || null,
      tasks: null,
      ghl_name: null,
      ghl_stage: null,
      policy_status: mappedStatus,
      deal_creation_date: policy.issuedate || null,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: null,
      status: null,
      last_updated: new Date().toISOString(),
      sales_agent: commission?.writingagentname || null,
      writing_number: commission?.writingagentnumber || null,
      commission_type: commission?.commissiontype || null,
      effective_date: commission?.effectivedate || null,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
      policy_type: policy.product || null,
      daily_deal_flow_fetched: existing?.daily_deal_flow_fetched || false,
      daily_deal_flow_fetched_at: existing?.daily_deal_flow_fetched_at || null,
      source_policy_table: 'aetna_policies',
      source_policy_id: policy.id,
      source_commission_table: commission ? 'aetna_commissions' : null,
      source_commission_id: commission?.id || null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    // Update daily_deal_flow tracking if we fetched it
    if (!existing || !existing.daily_deal_flow_fetched) {
      entry.daily_deal_flow_fetched = true
      entry.daily_deal_flow_fetched_at = new Date().toISOString()
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Processing complete. Total entries:', previewEntries.length)
  console.log('[Deal Tracker] Sample entry:', previewEntries[0] || 'none')

  return previewEntries
}

/**
 * Save deal tracker entries to database (OPTIMIZED with batch operations)
 */
export async function saveDealTrackerEntries(
  entries: DealTrackerEntry[] | DealTrackerPreviewEntry[]
): Promise<{ inserted: number; updated: number; failed: number }> {
  if (!entries || entries.length === 0) {
    return { inserted: 0, updated: 0, failed: 0 }
  }

  console.log('[Deal Tracker] Starting batch save for', entries.length, 'entries...')
  
  // Clean entries: remove preview-only and auto-managed fields
  const cleanEntries = entries.map(entry => {
    const { isNew, isUpdated, id, created_at, updated_at, ...dbEntry } = entry as any
    return dbEntry
  })

  // OPTIMIZATION: Batch check all existing entries at once
  // Since we need to match on (agency_carrier_id, policy_number) pairs,
  // we'll fetch all entries for the agency_carrier_id and filter client-side
  const agencyCarrierId = cleanEntries[0]?.agency_carrier_id
  if (!agencyCarrierId) {
    console.error('[Deal Tracker] No agency_carrier_id found in entries')
    return { inserted: 0, updated: 0, failed: entries.length }
  }

  const policyNumbers = cleanEntries.map(e => e.policy_number)

  console.log('[Deal Tracker] Batch checking existing entries for', policyNumbers.length, 'policies...')
  const { data: existingEntries, error: checkError } = await supabase
    .from('deal_tracker')
    .select('id, agency_carrier_id, policy_number')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (checkError) {
    console.error('[Deal Tracker] Error checking existing entries:', checkError)
    // Fall back to individual operations if batch check fails
    return await saveDealTrackerEntriesIndividual(entries)
  }

  // Create a map of existing entries for fast lookup
  const existingMap = new Map<string, string>() // key: "agency_carrier_id|policy_number" -> id
  if (existingEntries) {
    existingEntries.forEach(entry => {
      const key = `${entry.agency_carrier_id}|${entry.policy_number}`
      existingMap.set(key, entry.id)
    })
  }

  console.log('[Deal Tracker] Found', existingMap.size, 'existing entries out of', cleanEntries.length)

  // Separate entries into inserts and updates
  const toInsert: any[] = []
  const toUpdate: Array<{ id: string; data: any }> = []

  for (const entry of cleanEntries) {
    const key = `${entry.agency_carrier_id}|${entry.policy_number}`
    const existingId = existingMap.get(key)
    
    if (existingId) {
      toUpdate.push({ id: existingId, data: entry })
    } else {
      toInsert.push(entry)
    }
  }

  console.log('[Deal Tracker] Batch operations:', {
    toInsert: toInsert.length,
    toUpdate: toUpdate.length,
  })

  let inserted = 0
  let updated = 0
  let failed = 0

  // OPTIMIZATION: Batch insert all new entries
  if (toInsert.length > 0) {
    // Supabase allows batch inserts up to 1000 rows, so we'll batch in chunks
    const BATCH_SIZE = 500
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE)
      const { error } = await supabase
        .from('deal_tracker')
        .insert(batch)

      if (error) {
        console.error(`[Deal Tracker] Batch insert failed (batch ${i / BATCH_SIZE + 1}):`, error)
        failed += batch.length
      } else {
        inserted += batch.length
        console.log(`[Deal Tracker] Batch inserted ${batch.length} entries (${inserted}/${toInsert.length})`)
      }
    }
  }

  // OPTIMIZATION: Batch update existing entries
  if (toUpdate.length > 0) {
    // For updates, we need to do them individually or use a stored procedure
    // But we can still batch the queries by grouping them
    const BATCH_SIZE = 100
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const batch = toUpdate.slice(i, i + BATCH_SIZE)
      
      // Use Promise.all for parallel updates (faster than sequential)
      const updatePromises = batch.map(async ({ id, data }) => {
        const { error } = await supabase
          .from('deal_tracker')
          .update(data)
          .eq('id', id)

        return { error, id }
      })

      const results = await Promise.all(updatePromises)
      results.forEach(({ error, id }) => {
        if (error) {
          console.error(`[Deal Tracker] Failed to update entry ${id}:`, error)
          failed++
        } else {
          updated++
        }
      })

      console.log(`[Deal Tracker] Batch updated ${batch.length} entries (${updated}/${toUpdate.length})`)
    }
  }

  console.log('[Deal Tracker] Batch save complete:', { inserted, updated, failed })
  return { inserted, updated, failed }
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
 * Get all deal tracker entries
 */
export async function getDealTrackerEntries(filters?: {
  agency_carrier_id?: string
  carrier?: string
  policy_status?: string
  limit?: number
  offset?: number
}) {
  let query = supabase
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
    query = query.eq('agency_carrier_id', filters.agency_carrier_id)
  }

  if (filters?.carrier) {
    query = query.eq('carrier', filters.carrier)
  }

  if (filters?.policy_status) {
    query = query.eq('policy_status', filters.policy_status)
  }

  if (filters?.limit) {
    query = query.limit(filters.limit)
  }

  if (filters?.offset) {
    query = query.range(filters.offset, (filters.offset + (filters.limit || 100)) - 1)
  }

  const { data, error } = await query

  if (error) {
    throw new Error(`Failed to fetch deal tracker entries: ${error.message}`)
  }

  return data
}
