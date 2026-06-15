/**
 * Deal Tracker processing for AFLAC (Safe Harbor).
 * Policy and commission table layout matches Aetna (aflac_policies / aflac_commissions).
 */

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
  resolvePolicyStatusFromCarrierMapping,
  policyNeedsDdfLookup,
  calculateCcValue,
  resolveCommissionPreviewDealValue,
  policyFinancialsFromAetnaStylePolicy,
  resolvePolicyFinancialsForDealTracker,
} from './dealTracker'
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview } from './calendarDate'

/**
 * Process AFLAC policy files and create deal tracker entries.
 * Same flow as Aetna: policies from aflac_policies, optional commissions from aflac_commissions, DDF lookup.
 */
export async function processAflacFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAflacFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (AFLAC):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AFLAC'
  const carrierCode = carrier.code || 'AFLAC'
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('aflac_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching AFLAC policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No AFLAC policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number)

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
    console.warn('[Deal Tracker] Failed to fetch existing AFLAC deal_tracker entries:', (existingError as Error)?.message)
  }

  const existingMap = new Map<string, any>()
  existingEntries?.forEach((entry: any) => existingMap.set(entry.policy_number, entry))

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  // Same as Aetna/AMAM: fetch DDF when contact OR effective_date is missing (need draft_date for effective_date).
  const policiesNeedingDdf = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
  const uniqueInsuredNames = Array.from(
    new Set(policiesNeedingDdf.map(p => (p.insuredname || '').trim()).filter(n => n.length > 0))
  )
  const dailyDealFlowMap =
    uniqueInsuredNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, carrierName)
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)

    const originalStatus = policy.statusdisplaytext || policy.statuscategory
    const normalizedName = normalizeNameForSearch(policy.insuredname || '')
    const ddfInfo = normalizedName ? dailyDealFlowMap.get(normalizedName) ?? null : null
    const alreadyHasDdf = existing?.call_center != null || existing?.phone_number != null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdf) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
    }

    // Policy uploads must never derive financials from commission tables.
    // Keep existing deal/cc values for existing rows; new rows start null.
    let dealValue: number | null = null
    let ccValue: number | null = null
    if (existing && existing.deal_value != null) {
      dealValue =
        typeof existing.deal_value === 'string'
          ? parseFloat(existing.deal_value)
          : existing.deal_value
      ccValue =
        existing.cc_value != null
          ? typeof existing.cc_value === 'string'
            ? parseFloat(existing.cc_value)
            : existing.cc_value
          : dealValue != null ? calculateCcValue(dealValue, existing?.deal_creation_date ?? (policy.apprecddate || policy.issuedate || null)) : null
      if (Number.isNaN(dealValue as number)) dealValue = null
      if (Number.isNaN(ccValue as number)) ccValue = null
    }

    // Effective date: keep stored value; if empty use DDF draft_date then policy issue date (same as Aetna/AMAM).
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      ddfInfo?.draft_date ?? null,
      policy.issuedate as string | undefined,
    )

    const derivedStatus = statusFromDealValue(dealValue)
    const chargeBackForEntry = existing?.charge_back ?? null
    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, chargeBackForEntry)
        ? (existing.status ?? derivedStatus)
        : derivedStatus

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
    const dealCreationDateForGhl =
      existing?.deal_creation_date ?? (policy.apprecddate || policy.issuedate || null)
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate: dealCreationDateForGhl,
      dealValue,
      commissionType: existing?.commission_type || null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: policy.insuredname || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: policyStatusResolved,
      // Preserve existing deal_creation_date when present
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      ...policyFinancialsFromAetnaStylePolicy(policy),
      charge_back: chargeBackForEntry,
      notes: existing?.notes ?? null,
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agentcompletename || existing?.sales_agent || null,
      writing_number: policy.agentnumber || existing?.writing_number || null,
      commission_type: existing?.commission_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
      policy_type: policy.product || null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'aflac_policies',
      source_policy_id: policy.id,
      source_commission_table: existing?.source_commission_table ?? null,
      source_commission_id: existing?.source_commission_id ?? null,
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

  console.log('[Deal Tracker] AFLAC policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process AFLAC commission file and create/update deal tracker entries.
 * Same rules as Aetna: positive sum = deal_value, negative sum = charge_back, preserve existing deal_value when no positive.
 */
export async function processAflacCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAflacCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (AFLAC):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'AFLAC'
  const carrierCode = carrier.code || 'AFLAC'
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('aflac_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )

    if (!commissions || commissions.length === 0) {
      console.warn('[Deal Tracker] No AFLAC commissions found for file_id:', fileId)
      return []
    }
  }

  const policyNumbers = Array.from(new Set(commissions.map((c: any) => c.policy_number).filter(Boolean)))

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
    console.warn('[Deal Tracker] Failed to fetch existing AFLAC deal_tracker entries:', e?.message)
  }

  const existingMap = new Map<string, any>()
  existingEntries?.forEach((entry: any) => existingMap.set(entry.policy_number, entry))

  const commissionMap = new Map<string, any>()
  const commissionPositiveMap = new Map<string, number>()
  const commissionChargebackMap = new Map<string, number>()

  commissions.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const commAmount =
      comm.commissionamount != null
        ? typeof comm.commissionamount === 'string'
          ? parseFloat(comm.commissionamount)
          : comm.commissionamount
        : 0
    if (!Number.isNaN(commAmount)) {
      if (commAmount > 0) {
        commissionPositiveMap.set(policyNum, (commissionPositiveMap.get(policyNum) || 0) + commAmount)
      } else if (commAmount < 0) {
        commissionChargebackMap.set(policyNum, (commissionChargebackMap.get(policyNum) || 0) + commAmount)
      }
    }
    if (
      !commissionMap.has(policyNum) ||
      (comm.created_at && commissionMap.get(policyNum)?.created_at < comm.created_at)
    ) {
      commissionMap.set(policyNum, comm)
    }
  })

  const allCommissionPolicyNumbers = Array.from(new Set(commissionMap.keys()))
  const missingPolicyNumbers = allCommissionPolicyNumbers.filter(pn => !existingMap.has(pn))

  let policiesMap = new Map<string, any>()
  if (allCommissionPolicyNumbers.length > 0) {
    const policies = await fetchAllPaginated(() =>
      supabase
        .from('aflac_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', allCommissionPolicyNumbers)
    )
    policies?.forEach((p: any) => policiesMap.set(p.policy_number, p))
  }

  // Needed for BOTH existing and new rows in commission uploads so policy_status/ghl_stage
  // re-map when carrier status changed (same behavior as Aetna).
  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)
  let dailyDealFlowMap = new Map<
    string,
    { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
  >()
  if (missingPolicyNumbers.length > 0) {
    const policyNamesForDDF = Array.from(policiesMap.values())
      .map((p: any) => p.insuredname)
      .filter((name: string) => name && name.trim().length > 0)
    if (policyNamesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, carrierName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const positiveAmount = commissionPositiveMap.get(policyNumber)
    const chargeBack: number | null = commissionChargebackMap.get(policyNumber) ?? null

    const { dealValue, ccValue } = resolveCommissionPreviewDealValue(
      existing?.deal_value,
      existing?.cc_value,
      positiveAmount,
      existing?.deal_creation_date ?? policiesMap.get(policyNumber)?.apprecddate ?? policiesMap.get(policyNumber)?.issuedate ?? null,
    )

    const effectiveChargeBack = chargeBack ?? existing?.charge_back ?? null
    const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)

    if (existing) {
      const policy = policiesMap.get(policyNumber)
      const carrierStatusForGhl =
        policy?.statusdisplaytext ??
        policy?.statuscategory ??
        existing.carrier_status ??
        null
      const carrierUnchanged = carrierStatusUnchanged(existing, carrierStatusForGhl)
      const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
        statusMappingMap,
        carrierStatusForGhl,
        !!carrierUnchanged,
        existing.policy_status
      )
      const effectiveDate = mergeEffectiveDateWithPendingRoll(
        carrierStatusForGhl,
        existing.policy_status ?? null,
        existing.effective_date,
        null,
      )
      const dealCreationDateForGhl =
        existing.deal_creation_date ??
        policy?.apprecddate ??
        policy?.issuedate ??
        null
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierStatusForGhl,
        allMappings: ghlStageMappingMap,
        effectiveDate,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
        dealCreationDate: dealCreationDateForGhl,
        dealValue,
        chargeBack: effectiveChargeBack,
        commissionType: commission.commissiontype || existing.commission_type || null,
        existingGhlStage: existing.ghl_stage ?? null,
        carrierCode,
      })
      const policyFinancials = resolvePolicyFinancialsForDealTracker(policy, existing, 'aetna')
      const entry: DealTrackerPreviewEntry = {
        ...existing,
        ghl_stage: mappedGhlStage ?? existing.ghl_stage,
        carrier_status: carrierStatusForGhl,
        deal_value: dealValue,
        cc_value: ccValue,
        ...policyFinancials,
        charge_back: effectiveChargeBack,
        policy_status: policyStatusResolved,
        status: derivedStatus,
        sales_agent: commission.writingagentname || existing.sales_agent,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
        effective_date: effectiveDate,
        source_commission_table: 'aflac_commissions',
        source_commission_id: commission.id,
        isNew: false,
        isUpdated: true,
      }
      const newSnapshot = {
        ...existing,
        deal_value: dealValue,
        cc_value: ccValue,
        ...policyFinancials,
        charge_back: effectiveChargeBack,
        status: derivedStatus,
        sales_agent: commission.writingagentname || existing.sales_agent,
        writing_number: commission.writingagentnumber || existing.writing_number,
        commission_type: commission.commissiontype || existing.commission_type,
      } as Record<string, unknown>
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(
        existing as Record<string, unknown>,
        newSnapshot
      )
      entry.changedFields = changedFields
      entry.previousValues = previousValues
      previewEntries.push(entry)
    } else {
      const policy = policiesMap.get(policyNumber)
      if (policy) {
        const originalStatus = policy.statusdisplaytext || policy.statuscategory
        const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
          statusMappingMap,
          originalStatus,
          false,
          undefined
        )
        const normalizedName = normalizeNameForSearch(policy.insuredname || '')
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        const callCenter = ddfInfo?.call_center ?? null
        const phoneNumber = ddfInfo?.phone_number ?? null
        const effectiveDateFromDdf = ddfInfo?.draft_date ?? null
        const effectiveForGhl = mergeEffectiveDateWithPendingRoll(
          originalStatus,
          policyStatusResolved,
          null,
          effectiveDateFromDdf,
        )
        const dealCreationDateNew = policy.apprecddate || policy.issuedate || null
        const mappedGhlStage = resolveGhlStage({
          carrierStatus: originalStatus,
          allMappings: ghlStageMappingMap,
          effectiveDate: effectiveForGhl,
          effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(null, effectiveForGhl),
          dealCreationDate: dealCreationDateNew,
          dealValue,
          commissionType: commission.commissiontype || null,
          existingGhlStage: null,
          carrierCode,
        })

        const entry: DealTrackerPreviewEntry = {
          agency_carrier_id: agencyCarrierId,
          name: policy.insuredname || null,
          tasks: null,
          ghl_name: null,
          ghl_stage: mappedGhlStage,
          policy_status: policyStatusResolved,
          deal_creation_date: dealCreationDateNew,
          policy_number: policyNumber,
          carrier: carrierName,
          carrier_id: carrier.id,
          deal_value: dealValue,
          cc_value: ccValue,
          ...policyFinancialsFromAetnaStylePolicy(policy),
          charge_back: effectiveChargeBack,
          notes: null,
          status: derivedStatus,
          last_updated: new Date().toISOString(),
          sales_agent: policy.agentcompletename || commission.writingagentname || null,
          writing_number: policy.agentnumber || commission.writingagentnumber || null,
          commission_type: commission.commissiontype || null,
          // Commission upload must not set effective_date for AFLAC.
          effective_date: null,
          call_center: callCenter,
          phone_number: phoneNumber,
          cc_pmt_ws: null,
          cc_cb_ws: null,
          carrier_status: policy.statusdisplaytext || policy.statuscategory || null,
          policy_type: policy.product || null,
          daily_deal_flow_fetched: !!(callCenter || phoneNumber),
          daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
          source_policy_table: 'aflac_policies',
          source_policy_id: policy.id,
          source_commission_table: 'aflac_commissions',
          source_commission_id: commission.id,
          isNew: true,
          isUpdated: false,
        }
        previewEntries.push(entry)
      }
    }
  }

  console.log('[Deal Tracker] AFLAC commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
