import { supabase } from './supabaseClient'
import type { DealTrackerPreviewEntry } from './dealTracker'
import {
  bulkFetchStatusMappings,
  bulkFetchGhlStageMappings,
  fetchAllPaginated,
  bulkFetchDailyDealFlowInfo,
  normalizeNameForSearch,
  statusFromDealValue,
  statusFromDealValueAndChargeback,
  getChangedFieldsAndPrevious,
  financialsUnchanged,
  carrierStatusUnchanged,
  policyNeedsDdfLookup,
  resolvePolicyStatusFromCarrierMapping,
} from './dealTracker'
import { resolveGhlStage } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview, mergeEffectiveDate } from './calendarDate'

function buildSentinelInsuredName(p: { client_name?: string | null }): string {
  return (p.client_name ?? '').toString().trim()
}

function normalizePolicyNumber(value: unknown): string {
  const raw = (value == null ? '' : String(value)).trim()
  if (!raw) return ''
  if (/^\d+$/.test(raw) && raw.length === 6) return `0${raw}`
  return raw
}

/** Policy-only Sentinel processing: create/update deal tracker rows from sentinel_policies. */
export async function processSentinelFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processSentinelFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Sentinel):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Sentinel'
  const carrierCode = carrier.code || 'SENTINEL'
  // Daily Deal Flow carrier name is fixed for Sentinel.
  const ddfCarrier = 'Sentinel Security Life'
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('sentinel_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching Sentinel policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No Sentinel policies found for file_id:', fileId)
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
    console.warn('[Deal Tracker] Failed to fetch existing Sentinel deal_tracker entries:', (existingError as Error)?.message)
  }

  const existingMap = new Map<string, any>()
  existingEntries?.forEach((entry: any) => existingMap.set(entry.policy_number, entry))

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
  const uniqueNames = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => buildSentinelInsuredName(p))
        .filter(n => n.length > 0)
    )
  )

  console.log('[Deal Tracker] Sentinel: policies needing DDF:', policiesNeedingDdf.length, '| unique insured names:', uniqueNames.length, '| sample:', uniqueNames.slice(0, 5))

  const dailyDealFlowMap =
    uniqueNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueNames, ddfCarrier)
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildSentinelInsuredName(policy)
    const originalStatus = policy.status || null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = insuredName ? dailyDealFlowMap.get(normalizedName) || null : null
    let callCenter: string | null = existing?.call_center ?? null
    let phoneNumber: string | null = existing?.phone_number ?? null
    if (callCenter == null && phoneNumber == null && ddfInfo) {
      callCenter = ddfInfo.call_center ?? null
      phoneNumber = ddfInfo.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

    let dealValue: number | null =
      existing?.deal_value != null
        ? typeof existing.deal_value === 'string'
          ? parseFloat(existing.deal_value)
          : existing.deal_value
        : null
    let ccValue: number | null =
      dealValue != null
        ? existing?.cc_value != null
          ? typeof existing.cc_value === 'string'
            ? parseFloat(existing.cc_value)
            : existing.cc_value
          : dealValue / 2
        : null

    const dealCreationDateFromPolicy = (policy.issue_date as string | undefined) || null
    const effectiveDateFromPolicy = (policy.issue_date as string | undefined) || null

    // Preserve the deal creation date already stored in the DB.
    // Only use the policy file's issue_date when there is no existing date.
    const dealCreationDate =
      (existing?.deal_creation_date as string | null | undefined) ||
      dealCreationDateFromPolicy ||
      null

    const effectiveDate = mergeEffectiveDate(
      existing?.effective_date,
      effectiveDateFromDdf,
      effectiveDateFromPolicy,
    )

    const statusUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!statusUnchanged,
      existing?.policy_status
    )

    // Re-resolve GHL stage even when raw carrier status is unchanged so that
    // time-based transitions still trigger.
    // Manual stages are protected inside resolveGhlStage().
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealValue,
      commissionType: null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: policyStatusResolved,
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: existing?.notes ?? null,
      status:
        existing && financialsUnchanged(existing, dealValue, null)
          ? existing.status ?? statusFromDealValue(dealValue)
          : statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: policy.writing_agent_name ?? null,
      writing_number: policy.writing_agent_code ?? null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.product_description ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber)
        ? new Date().toISOString()
        : existing?.daily_deal_flow_fetched_at ?? null,
      source_policy_table: 'sentinel_policies',
      source_policy_id: policy.id,
      source_commission_table: null,
      source_commission_id: null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(
        existing as Record<string, unknown>,
        entry as unknown as Record<string, unknown>
      )
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Sentinel policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/** Commission-driven Sentinel processing using Payable Comm as the commission amount. */
export async function processSentinelCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processSentinelCommissionsForDealTracker called', {
    agencyCarrierId,
    fileId,
    fromMemory: !!(commissionsOverride && commissionsOverride.length > 0),
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Sentinel):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Sentinel'
  const carrierCode = carrier.code || 'SENTINEL'
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('sentinel_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('row_number', { ascending: true })
    )

    if (!commissions || commissions.length === 0) {
      console.warn('[Deal Tracker] No Sentinel commissions found for file_id:', fileId)
      return []
    }
  }

  const policyNumbers = Array.from(
    new Set(commissions.map((c: any) => normalizePolicyNumber(c.policy_number)).filter(Boolean))
  )

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
  } catch (e: any) {
    console.warn('[Deal Tracker] Failed to fetch existing Sentinel deal_tracker entries:', e?.message)
  }

  const existingMap = new Map<string, any>()
  existingEntries?.forEach((entry: any) => {
    const pn = normalizePolicyNumber(entry.policy_number)
    if (pn) existingMap.set(pn, entry)
  })

  const latestRowByPolicy = new Map<string, any>()
  const posMap = new Map<string, number>()
  const negMap = new Map<string, number>()

  for (const comm of commissions) {
    const policyNum = normalizePolicyNumber(comm.policy_number)
    if (!policyNum) continue

    const amt =
      comm.payable_commission != null
        ? typeof comm.payable_commission === 'string'
          ? parseFloat(comm.payable_commission)
          : comm.payable_commission
        : 0
    if (!Number.isNaN(amt) && typeof amt === 'number') {
      if (amt > 0) posMap.set(policyNum, (posMap.get(policyNum) || 0) + amt)
      else if (amt < 0) negMap.set(policyNum, (negMap.get(policyNum) || 0) + amt)
    }

    if (!latestRowByPolicy.has(policyNum)) latestRowByPolicy.set(policyNum, comm)
  }

  // Load policies for any policies that don't yet exist in deal_tracker
  const missingPolicyNumbers = Array.from(latestRowByPolicy.keys()).filter(
    pn => !existingMap.has(pn)
  )

  let policiesMap = new Map<string, any>()
  if (missingPolicyNumbers.length > 0) {
    const policies = await fetchAllPaginated(() =>
      supabase
        .from('sentinel_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', missingPolicyNumbers)
    )
    policies?.forEach((p: any) => policiesMap.set(p.policy_number, p))
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  let dailyDealFlowMap = new Map<
    string,
    { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
  >()
  if (missingPolicyNumbers.length > 0) {
    const policyNamesForDDF = Array.from(policiesMap.values())
      .map((p: any) => p.client_name)
      .filter((name: string) => name && name.trim().length > 0)
    if (policyNamesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const [policyNum, latest] of latestRowByPolicy.entries()) {
    const existing = existingMap.get(policyNum)

    const pos = posMap.get(policyNum) ?? 0
    const neg = negMap.get(policyNum) ?? 0

    const positiveAmount = pos > 0 ? pos : null
    const batchChargeBack = neg < 0 ? neg : null

    let dealValue: number | null
    if (positiveAmount != null && positiveAmount > 0) {
      dealValue = positiveAmount
    } else if (existing && existing.deal_value != null) {
      dealValue =
        typeof existing.deal_value === 'number'
          ? existing.deal_value
          : parseFloat(String(existing.deal_value))
    } else {
      dealValue = null
    }

    const existingCbRaw =
      existing && (existing as any).charge_back != null
        ? typeof (existing as any).charge_back === 'number'
          ? (existing as any).charge_back
          : parseFloat(String((existing as any).charge_back))
        : null

    let effectiveChargeBack: number | null = null
    if (batchChargeBack != null) {
      if (existingCbRaw != null && !Number.isNaN(existingCbRaw)) {
        effectiveChargeBack = existingCbRaw + batchChargeBack
      } else {
        effectiveChargeBack = batchChargeBack
      }
    } else if (existingCbRaw != null && !Number.isNaN(existingCbRaw)) {
      effectiveChargeBack = existingCbRaw
    }

    let ccValue: number | null =
      dealValue != null && !Number.isNaN(dealValue) ? dealValue / 2 : null

    if (Number.isNaN(ccValue as number)) ccValue = null

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, effectiveChargeBack)
        ? existing.status ?? derivedStatus
        : derivedStatus

    const policy = policiesMap.get(policyNum)
    const nameFromPolicy = policy?.client_name ?? null
    const salesAgentFromPolicy = policy?.writing_agent_name ?? null

    const nameForEntry = existing?.name ?? nameFromPolicy ?? latest.client_name ?? null
    const salesAgentForEntry =
      existing?.sales_agent && existing.sales_agent.toString().trim()
        ? existing.sales_agent
        : salesAgentFromPolicy ?? latest.writing_agent_name ?? null

    const statementDate = (latest.statement_date ?? '').toString().trim() || null

    let callCenter: string | null = existing?.call_center ?? null
    let phoneNumber: string | null = existing?.phone_number ?? null
    let effectiveDateFromDdf: string | null = null
    let ddfInfo:
      | { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
      | null = null
    if (!existing && policy && (callCenter == null && phoneNumber == null)) {
      const normalizedName = normalizeNameForSearch(policy.client_name || '')
      ddfInfo = dailyDealFlowMap.get(normalizedName) || null
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }

    const effectiveDate = mergeEffectiveDate(existing?.effective_date, effectiveDateFromDdf, statementDate)
    const carrierStatusForGhl = existing?.carrier_status ?? policy?.status ?? null
    const statusUnchanged = existing && carrierStatusUnchanged(existing, carrierStatusForGhl)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      carrierStatusForGhl,
      !!statusUnchanged,
      existing?.policy_status
    )
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: carrierStatusForGhl,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealValue,
      chargeBack: effectiveChargeBack,
      commissionType: null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: nameForEntry,
      tasks: existing?.tasks ?? null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage ?? existing?.ghl_stage ?? null,
      policy_status: policyStatusResolved,
      deal_creation_date: existing?.deal_creation_date ?? policy?.issue_date ?? statementDate,
      policy_number: policyNum,
      carrier: carrierName,
      carrier_id: carrierId,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: effectiveChargeBack,
      notes: existing?.notes ?? null,
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: salesAgentForEntry,
      writing_number: existing?.writing_number ?? policy?.writing_agent_code ?? latest.writing_agent_number ?? null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: positiveAmount ?? existing?.cc_pmt_ws ?? null,
      cc_cb_ws: effectiveChargeBack ?? existing?.cc_cb_ws ?? null,
      carrier_status: existing?.carrier_status ?? policy?.status ?? null,
      policy_type: existing?.policy_type ?? policy?.product_description ?? null,
      daily_deal_flow_fetched: existing?.daily_deal_flow_fetched ?? !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at:
        existing?.daily_deal_flow_fetched_at ??
        ((callCenter || phoneNumber) ? new Date().toISOString() : null),
      source_policy_table: existing?.source_policy_table ?? (policy ? 'sentinel_policies' : null),
      source_policy_id: existing?.source_policy_id ?? policy?.id ?? null,
      source_commission_table: 'sentinel_commissions',
      source_commission_id: latest.id != null ? latest.id : null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(
        existing as Record<string, unknown>,
        entry as unknown as Record<string, unknown>
      )
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Sentinel commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

