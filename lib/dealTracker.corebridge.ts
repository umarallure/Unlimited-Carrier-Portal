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
  calculateCcValue,
  resolveCommissionPreviewDealValue,
} from './dealTracker'
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview } from './calendarDate'

/**
 * Build insured name from Corebridge policy for DDF lookup.
 */
function buildCorebridgeInsuredName(p: { insured_name?: string | null }): string {
  return (p.insured_name ?? '').trim()
}

/**
 * Process Corebridge carrier policy files and create deal tracker entries.
 * Policy-only flow (commission not wired for deal tracker yet); optional DDF lookup.
 */
export async function processCorebridgeFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processCorebridgeFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Corebridge):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Corebridge'
  const carrierCode = carrier.code || 'COREBRIDGE'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('corebridge_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching Corebridge policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No Corebridge policies found for file_id:', fileId)
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
    console.warn('[Deal Tracker] Failed to fetch existing Corebridge deal_tracker entries:', (existingError as Error)?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      existingMap.set(entry.policy_number, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
  const uniqueNames = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => buildCorebridgeInsuredName(p))
        .filter(n => n.length > 0)
    )
  )

  console.log('[Deal Tracker] Corebridge: policies needing DDF:', policiesNeedingDdf.length, '| unique insured names:', uniqueNames.length, '| sample:', uniqueNames.slice(0, 5))

  const dailyDealFlowMap =
    uniqueNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueNames, ddfCarrier)
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  const ddfMatched = Array.from(dailyDealFlowMap.entries()).filter(([, v]) => v.call_center || v.phone_number).length
  if (uniqueNames.length > 0) {
    console.log('[Deal Tracker] Corebridge: DDF lookup done. Matched', ddfMatched, 'of', uniqueNames.length, 'names with call_center or phone_number')
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildCorebridgeInsuredName(policy)
    const originalStatus = (policy.policy_status as string) || null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = insuredName ? dailyDealFlowMap.get(normalizedName) || null : null
    let callCenter: string | null = existing?.call_center ?? null
    let phoneNumber: string | null = existing?.phone_number ?? null
    if (callCenter == null && phoneNumber == null && ddfInfo) {
      callCenter = ddfInfo.call_center ?? null
      phoneNumber = ddfInfo.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

    let dealValue: number | null = existing?.deal_value != null ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value) : null
    let ccValue: number | null = dealValue != null
      ? (existing?.cc_value != null
          ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value)
          : calculateCcValue(
              dealValue,
              existing?.deal_creation_date ??
                (policy.issue_date as string | undefined) ??
                (policy.submitted_date as string | undefined) ??
                null
            ))
      : null

    // Preserve existing deal creation date; only set from policy for new rows.
    const dealCreationDate =
      existing?.deal_creation_date ??
      ((policy.date_of_issue as string | undefined) || null)

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy.effective_date,
      policy.date_of_issue,
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
      dealCreationDate,
      dealValue,
      commissionType: null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: policyStatusResolved,
      deal_creation_date: dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: existing?.notes ?? null,
      status: (existing && financialsUnchanged(existing, dealValue, null)) ? (existing.status ?? statusFromDealValue(dealValue)) : statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: (policy.writing_servicing_agent as string) ?? null,
      writing_number: (policy.agent_number as string) ?? null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: (policy.product_type as string) ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'corebridge_policies',
      source_policy_id: policy.id,
      source_commission_table: null,
      source_commission_id: null,
      isNew: !existing,
      isUpdated: !!existing,
    }
    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }
    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Corebridge policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process Corebridge commission file and create/update deal tracker entries.
 * Mirrors Aetna/AMAM "commission-driven" update so the verification dialog appears.
 */
export async function processCorebridgeCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processCorebridgeCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Corebridge):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Corebridge'
  const carrierCode = carrier.code || 'COREBRIDGE'
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('corebridge_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('row_number', { ascending: true })
    )

    if (!commissions || commissions.length === 0) {
      console.warn('[Deal Tracker] No Corebridge commissions found for file_id:', fileId)
      return []
    }
  }

  const policyNumbers = Array.from(new Set(commissions.map((c: any) => c.policy_number).filter(Boolean)))
  if (policyNumbers.length === 0) return []

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
    console.warn('[Deal Tracker] Failed to fetch existing Corebridge deal_tracker entries:', e?.message)
  }

  const existingMap = new Map<string, any>()
  existingEntries?.forEach((entry: any) => existingMap.set(entry.policy_number, entry))

  console.log('[Deal Tracker Corebridge] Total commissions from DB for this file:', commissions.length)
  commissions.forEach((c: any) => {
    console.log('[Deal Tracker Corebridge]   DB row:', c.policy_number, '| comm_type:', c.comm_type, '| amount:', c.commission_amount)
  })

  // Aggregate commission amounts per policy (positive vs negative)
  const latestRowByPolicy = new Map<string, any>()
  const posMap = new Map<string, number>()
  const negMap = new Map<string, number>()
  for (const comm of commissions) {
    const policyNum = comm.policy_number
    if (!policyNum) continue

    const rawType = (comm.comm_type ?? '').toString().toUpperCase().trim()
    const isAdvanceType = rawType.length >= 4 && /^[A-Z]+AD$/.test(rawType)
    const isOverrideType = rawType === 'OVERRIDE' || rawType.includes('OVERRIDE')

    console.log('[Deal Tracker Corebridge]   Filter:', policyNum, '| rawType:', rawType, '| isAD:', isAdvanceType, '| isOverride:', isOverrideType, '| pass:', isAdvanceType || isOverrideType)

    const amt =
      comm.commission_amount != null
        ? (typeof comm.commission_amount === 'string' ? parseFloat(comm.commission_amount) : comm.commission_amount)
        : 0
    if (!Number.isNaN(amt) && typeof amt === 'number' && (isAdvanceType || isOverrideType)) {
      if (amt > 0) posMap.set(policyNum, (posMap.get(policyNum) || 0) + amt)
      else if (amt < 0) negMap.set(policyNum, (negMap.get(policyNum) || 0) + amt)
    }

    if (isAdvanceType || isOverrideType) {
      if (!latestRowByPolicy.has(policyNum)) latestRowByPolicy.set(policyNum, comm)
    }
  }

  console.log('[Deal Tracker Corebridge] Policies passing filter:', Array.from(latestRowByPolicy.keys()).join(', '))

  const policyNumbersNeedingDdf = Array.from(latestRowByPolicy.keys()).filter(policyNum =>
    policyNeedsDdfLookup(existingMap.get(policyNum))
  )
  let dailyDealFlowMap = new Map<
    string,
    { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
  >()
  if (policyNumbersNeedingDdf.length > 0) {
    const policyNamesForDdf = Array.from(
      new Set(
        policyNumbersNeedingDdf
          .map(policyNum => ((latestRowByPolicy.get(policyNum)?.insured_name ?? '').toString().trim()))
          .filter((name: string) => name.length > 0)
      )
    )
    if (policyNamesForDdf.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDdf, carrierName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const [policyNum, latest] of latestRowByPolicy.entries()) {
    const existing = existingMap.get(policyNum)
    const insuredName = (latest.insured_name ?? '').toString().trim() || null
    const salesAgent = (latest.agent_code ?? '').toString().trim() || null
    const statementDate = (latest.statement_date ?? '').toString().trim() || null
    const normalizedName = insuredName ? normalizeNameForSearch(insuredName) : null
    const ddfInfo = normalizedName ? dailyDealFlowMap.get(normalizedName) ?? null : null

    const pos = posMap.get(policyNum) ?? 0
    const neg = negMap.get(policyNum) ?? 0

    // Mirror Aetna/AMAM rules:
    // - deal_value is driven by summed POSITIVE commission amounts.
    // - If there is no positive amount in this batch but an existing deal_value
    //   already exists, we KEEP the existing deal_value instead of nulling it
    //   out or letting negatives flip it.
    // - Negative amounts are treated as chargebacks and accumulated on top of
    //   any existing charge_back.
    const positiveAmount = pos > 0 ? pos : null
    const batchChargeBack = neg < 0 ? neg : null

    const { dealValue: resolvedDv, ccValue: resolvedCc } = resolveCommissionPreviewDealValue(
      existing?.deal_value,
      (existing as any)?.cc_value,
      positiveAmount,
      existing?.deal_creation_date ?? null,
    )
    const dealValue: number | null = resolvedDv

    const existingCbRaw =
      existing && (existing as any).charge_back != null
        ? (typeof (existing as any).charge_back === 'number'
            ? (existing as any).charge_back
            : parseFloat(String((existing as any).charge_back)))
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

    let ccValue: number | null = resolvedCc
    if (Number.isNaN(ccValue as number)) ccValue = null

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, effectiveChargeBack)
        ? (existing.status ?? derivedStatus)
        : derivedStatus

    const nameForEntry = existing?.name ?? insuredName
    const salesAgentForEntry =
      existing?.sales_agent && existing.sales_agent.toString().trim()
        ? existing.sales_agent
        : salesAgent

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      // For commissions, never overwrite existing name from policy/deal_tracker.
      name: nameForEntry ?? null,
      tasks: existing?.tasks ?? null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: existing?.ghl_stage ?? null,
      policy_status: existing?.policy_status ?? null,
      deal_creation_date: existing?.deal_creation_date ?? statementDate,
      policy_number: policyNum,
      carrier: carrierName,
      carrier_id: carrierId,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: existing?.notes ?? null,
      // Status follows standard rules from deal value + chargeback; do not
      // overwrite when financials are unchanged.
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: salesAgentForEntry ?? null,
      writing_number: existing?.writing_number ?? null,
      commission_type: latest.comm_type ?? null,
      effective_date: existing?.effective_date ?? statementDate,
      call_center: existing?.call_center ?? null,
      phone_number: existing?.phone_number ?? null,
      cc_pmt_ws: positiveAmount ?? (existing?.cc_pmt_ws ?? null),
      cc_cb_ws: effectiveChargeBack ?? (existing?.cc_cb_ws ?? null),
      carrier_status: existing?.carrier_status ?? null,
      policy_type: existing?.policy_type ?? null,
      daily_deal_flow_fetched: existing?.daily_deal_flow_fetched ?? false,
      daily_deal_flow_fetched_at: existing?.daily_deal_flow_fetched_at ?? null,
      source_policy_table: existing?.source_policy_table ?? null,
      source_policy_id: existing?.source_policy_id ?? null,
      source_commission_table: 'corebridge_commissions',
      source_commission_id: latest.id != null ? latest.id : null,
      isNew: !existing,
      isUpdated: !!existing,
    }

    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(existing as unknown as Record<string, unknown>, entry as unknown as Record<string, unknown>)
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }

    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Corebridge commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
