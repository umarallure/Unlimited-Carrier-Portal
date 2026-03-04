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
 * Build insured/owner name from Transamerica policy for DDF lookup.
 */
function buildTransamericaInsuredName(p: { insured_name?: string | null; owner_name?: string | null }): string {
  const insured = (p.insured_name ?? '').trim()
  const owner = (p.owner_name ?? '').trim()
  return (insured || owner || '').trim()
}

/**
 * Process Transamerica carrier policy files and create deal tracker entries.
 * Policy-only flow (commission upload not supported yet); optional DDF lookup.
 */
export async function processTransamericaFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processTransamericaFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Transamerica):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Transamerica'
  const carrierCode = carrier.code || 'TRANSAMERICA'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('transamerica_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching Transamerica policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No Transamerica policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number as string)

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
    console.warn('[Deal Tracker] Failed to fetch existing Transamerica deal_tracker entries:', (existingError as Error)?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p => {
    const ex = existingMap.get(p.policy_number)
    return !ex || (ex.call_center == null && ex.phone_number == null)
  })
  const uniqueNames = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => buildTransamericaInsuredName(p))
        .filter(n => n.length > 0)
    )
  )

  const dailyDealFlowMap =
    uniqueNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueNames, ddfCarrier)
      : new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }>()

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildTransamericaInsuredName(policy)
    const originalStatus = policy.status || null
    const mappedStatus = statusMappingMap.get(originalStatus || '') || originalStatus || null

    let callCenter: string | null = existing?.call_center ?? null
    let phoneNumber: string | null = existing?.phone_number ?? null
    let effectiveDateFromDdf: string | null = null
    if ((callCenter == null && phoneNumber == null) && insuredName) {
      const normalizedName = normalizeNameForSearch(insuredName)
      const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }

    let dealValue: number | null = existing?.deal_value != null ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value) : null
    let ccValue: number | null = dealValue != null ? (existing?.cc_value != null ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value) : dealValue / 2) : null

    const dealCreationDate =
      (policy.issue_date as string | undefined) || null

    const effectiveDate =
      effectiveDateFromDdf ||
      (policy.issue_date as string | undefined) ||
      null

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
      status: statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: null,
      writing_number: null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.product_type ?? policy.product_class ?? policy.product_code ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'transamerica_policies',
      source_policy_id: policy.id,
      source_commission_table: null,
      source_commission_id: null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Transamerica policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
