import { supabase } from './supabaseClient'
import type { DealTrackerPreviewEntry } from './dealTracker'
import {
  bulkFetchStatusMappings,
  fetchAllPaginated,
  bulkFetchDailyDealFlowInfo,
  normalizeNameForSearch,
  statusFromDealValue,
} from './dealTracker'

/**
 * Build insured name from MOH policy fields for DDF lookup.
 * MOH stores a single insured name string (and optional second insured); prefer primary.
 */
function buildMohInsuredName(p: { insured_nme?: string | null; insured2_nme?: string | null }): string {
  const primary = (p.insured_nme ?? '').trim()
  const secondary = (p.insured2_nme ?? '').trim()
  return (primary || secondary || '').trim()
}

/**
 * Process MOH carrier policy files and create deal tracker entries.
 * Uses moh_policies + moh_commissions + DDF, similar to AMAM/AETNA flows.
 */
export async function processMohFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processMohFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (MOH):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'MOH'
  const carrierCode = carrier.code || 'MOH'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  // Fetch MOH policies for this file (paged)
  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('moh_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching MOH policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No MOH policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)

  // Fetch MOH commissions for these policies (optional – some flows may be policy-only)
  let commissions: any[] = []
  try {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('moh_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('activity_date', { ascending: true })
    )
  } catch (commissionsError: any) {
    console.warn('[Deal Tracker] Failed to fetch MOH commissions:', commissionsError?.message)
  }

  // For each policy, keep the latest commission row (by Activity Date / Paid To / Issue Date)
  const commissionMap = new Map<string, any>()
  commissions.forEach(comm => {
    const policyNum = comm.policy_number
    if (!policyNum) return

    const existing = commissionMap.get(policyNum)
    const currDateStr = (comm.activity_date || comm.paid_to_date || comm.issue_date) as string | undefined
    const existingDateStr = existing ? (existing.activity_date || existing.paid_to_date || existing.issue_date) as string | undefined : undefined
    const currDate = currDateStr ? new Date(currDateStr) : null
    const existingDate = existingDateStr ? new Date(existingDateStr) : null

    if (!existing || (currDate && (!existingDate || currDate > existingDate))) {
      commissionMap.set(policyNum, comm)
    }
  })

  // Fetch existing deal_tracker entries so we know which rows are new vs updated
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
    console.warn('[Deal Tracker] Failed to fetch existing MOH deal_tracker entries:', existingError?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)

  // Only fetch DDF for policies that don't already have call_center/phone
  const policiesNeedingDdf = policies.filter(p => {
    const ex = existingMap.get(p.policy_number)
    return !ex || (ex.call_center == null && ex.phone_number == null)
  })
  const uniqueInsuredNamesMoh = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => buildMohInsuredName(p))
        .filter(n => n.length > 0)
    )
  )

  const skipCountMoh = policies.length - policiesNeedingDdf.length
  console.log('[Deal Tracker] MOH: carrier=', carrierName, '| names to DDF=', uniqueInsuredNamesMoh.length, '| skip (already have DDF)=', skipCountMoh)
  if (uniqueInsuredNamesMoh.length > 0) {
    console.log('[Deal Tracker] MOH: sample names sent to DDF (first 10):', uniqueInsuredNamesMoh.slice(0, 10))
  }

  const dailyDealFlowMap =
    uniqueInsuredNamesMoh.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNamesMoh, ddfCarrier)
      : new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }>()

  console.log('[Deal Tracker] MOH: DDF map size after fetch:', dailyDealFlowMap.size, 'of', uniqueInsuredNamesMoh.length, 'names')

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const commission = commissionMap.get(policy.policy_number)
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildMohInsuredName(policy)
    const originalStatus = policy.policy_status_nme || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null

    // Use existing call_center/phone if already set; else use DDF
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

    const rawDealValue =
      commission && commission.comm_amt != null
        ? (typeof commission.comm_amt === 'string' ? parseFloat(commission.comm_amt) : commission.comm_amt)
        : null
    const dealValue = Number.isNaN(rawDealValue as any) ? null : rawDealValue
    const ccValue = dealValue != null ? dealValue / 2 : null

    const dealCreationDate =
      (commission?.activity_date as string | undefined) ||
      (commission?.issue_date as string | undefined) ||
      (policy.policy_issue_dte as string | undefined) ||
      (policy.policy_effective_dte as string | undefined) ||
      null

    const effectiveDate =
      effectiveDateFromDdf ||
      (policy.policy_effective_dte as string | undefined) ||
      (commission?.issue_date as string | undefined) ||
      null

    const entryIndex = previewEntries.length
    if (entryIndex < 3) {
      console.log('[Deal Tracker] MOH policy sample', entryIndex + 1, '| insuredName:', insuredName, '| ddfFound:', !!(callCenter || phoneNumber), '| dealValue:', dealValue, '| commActivityType:', commission?.activity_type ?? null)
    }

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
      notes: commission?.comments ?? null,
      status: statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: commission?.paid_producer ?? policy.wrt_agt_nme ?? null,
      writing_number: commission?.prod_num ?? policy.wrt_agt_prod_num ?? null,
      commission_type: commission?.activity_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.product_desc ?? policy.product_type_nme ?? policy.plan_code ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'moh_policies',
      source_policy_id: policy.id,
      source_commission_table: commission ? 'moh_commissions' : null,
      source_commission_id: commission?.id ?? null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] MOH policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process MOH commission files and update deal tracker entries.
 * Commission-driven flow similar to AMAM commissions: updates existing rows and creates new ones when needed.
 */
export async function processMohCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processMohCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (MOH commissions):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'MOH'
  const carrierCode = carrier.code || 'MOH'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  const { data: commissions, error: commissionsError } = await supabase
    .from('moh_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (commissionsError) {
    console.error('[Deal Tracker] Error fetching MOH commissions:', commissionsError)
    throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
  }

  if (!commissions || commissions.length === 0) {
    console.warn('[Deal Tracker] No MOH commissions found for file_id:', fileId)
    return []
  }

  const policyNumbers = Array.from(new Set(commissions.map((c: any) => c.policy_number).filter(Boolean)))

  // Fetch existing deal_tracker entries for these policies
  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing MOH deal_tracker entries (commissions):', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  // Fetch MOH policies for these policy numbers (to fill in name/status/dates)
  let policiesMap = new Map<string, any>()
  if (policyNumbers.length > 0) {
    const policies = await fetchAllPaginated(() =>
      supabase
        .from('moh_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
    policies.forEach(p => {
      policiesMap.set(p.policy_number, p)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)

  // Aggregate commissions per policy
  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissions.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return

    const amountRaw = comm.comm_amt != null
      ? (typeof comm.comm_amt === 'string' ? parseFloat(comm.comm_amt) : comm.comm_amt)
      : 0
    const amount = Number.isNaN(amountRaw) ? 0 : amountRaw

    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + amount)

    const existing = commissionMap.get(policyNum)
    const currDateStr = (comm.activity_date || comm.paid_to_date || comm.issue_date) as string | undefined
    const existingDateStr = existing ? (existing.activity_date || existing.paid_to_date || existing.issue_date) as string | undefined : undefined
    const currDate = currDateStr ? new Date(currDateStr) : null
    const existingDate = existingDateStr ? new Date(existingDateStr) : null

    if (!existing || (currDate && (!existingDate || currDate > existingDate))) {
      commissionMap.set(policyNum, comm)
    }
  })

  // Figure out which policies need DDF
  const allPolicyNumbersNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const existing = existingMap.get(pn)
    return !existing || (existing.call_center == null && existing.phone_number == null)
  })

  let dailyDealFlowMap = new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = allPolicyNumbersNeedingDDF
      .map(pn => {
        const policy = policiesMap.get(pn)
        if (!policy) return ''
        return buildMohInsuredName(policy)
      })
      .filter((n: string) => n.length > 0)

    if (policyNamesForDDF.length > 0) {
      console.log('[Deal Tracker] MOH commissions: fetching DDF for', policyNamesForDDF.length, 'names | sample:', policyNamesForDDF.slice(0, 5))
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, ddfCarrier)
      console.log('[Deal Tracker] MOH commissions: DDF map size:', dailyDealFlowMap.size, 'of', policyNamesForDDF.length)
    } else {
      console.log('[Deal Tracker] MOH commissions: no policy names for DDF – upload policy file first so moh_policies has rows for these policy numbers')
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const [policyNumber, comm] of commissionMap.entries()) {
    const existing = existingMap.get(policyNumber)
    const policy = policiesMap.get(policyNumber)

    const insuredName = policy ? buildMohInsuredName(policy) : (comm.insureds_name ?? null)
    const originalStatus = policy?.policy_status_nme || existing?.policy_status || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null

    const totalAmount = commissionAmountsMap.get(policyNumber)
    const dealValue = totalAmount != null ? totalAmount : null
    const ccValue = dealValue != null ? dealValue / 2 : null

    let callCenter = existing?.call_center ?? null
    let phoneNumber = existing?.phone_number ?? null
    let dailyDealFlowFetched = existing?.daily_deal_flow_fetched ?? false
    let dailyDealFlowFetchedAt = existing?.daily_deal_flow_fetched_at ?? null

    if ((!callCenter && !phoneNumber) && policy) {
      const nameForDdf = buildMohInsuredName(policy)
      const normalizedName = normalizeNameForSearch(nameForDdf)
      const ddfInfo = dailyDealFlowMap.get(normalizedName)
      if (ddfInfo) {
        callCenter = ddfInfo.call_center ?? null
        phoneNumber = ddfInfo.phone_number ?? null
        dailyDealFlowFetched = !!(callCenter || phoneNumber)
        dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
      }
    }

    const dealCreationDate =
      (comm.activity_date as string | undefined) ||
      (comm.issue_date as string | undefined) ||
      (policy?.policy_issue_dte as string | undefined) ||
      (policy?.policy_effective_dte as string | undefined) ||
      null

    const effectiveDate =
      (policy?.policy_effective_dte as string | undefined) ||
      (comm.issue_date as string | undefined) ||
      null

    const entry: DealTrackerPreviewEntry = {
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
      notes: comm.comments ?? null,
      status: statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: comm.paid_producer ?? policy?.wrt_agt_nme ?? null,
      writing_number: comm.prod_num ?? policy?.wrt_agt_prod_num ?? null,
      commission_type: comm.activity_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy?.product_desc ?? policy?.product_type_nme ?? policy?.plan_code ?? null,
      daily_deal_flow_fetched: dailyDealFlowFetched,
      daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
      source_policy_table: policy ? 'moh_policies' : null,
      source_policy_id: policy?.id ?? null,
      source_commission_table: 'moh_commissions',
      source_commission_id: comm.id,
      isNew: !existing,
      isUpdated: !!existing,
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] MOH commissions processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

