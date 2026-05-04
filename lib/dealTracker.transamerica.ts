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
 * Build insured/owner name from Transamerica policy for DDF lookup.
 */
function buildTransamericaInsuredName(p: { insured_name?: string | null; owner_name?: string | null }): string {
  const insured = (p.insured_name ?? '').trim()
  const owner = (p.owner_name ?? '').trim()
  return (insured || owner || '').trim()
}

function hasExistingDealTrackerAgentField(value: unknown): boolean {
  if (value == null) return false
  return String(value).trim() !== ''
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
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p => policyNeedsDdfLookup(existingMap.get(p.policy_number)))
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
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(policy.policy_number)
    const insuredName = buildTransamericaInsuredName(policy)
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

    let dealValue: number | null = existing?.deal_value != null ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value) : null
    let ccValue: number | null = dealValue != null
      ? (existing?.cc_value != null
          ? (typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value)
          : calculateCcValue(dealValue, existing?.deal_creation_date ?? (policy.issue_date as string | undefined) ?? null))
      : null

    const dealCreationDate =
      (policy.issue_date as string | undefined) || null

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy.issue_date,
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
      deal_creation_date: existing?.deal_creation_date ?? dealCreationDate,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: existing?.notes ?? null,
      status: (existing && financialsUnchanged(existing, dealValue, null)) ? (existing.status ?? statusFromDealValue(dealValue)) : statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: hasExistingDealTrackerAgentField(existing?.sales_agent)
        ? String(existing.sales_agent).trim()
        : null,
      writing_number: hasExistingDealTrackerAgentField(existing?.writing_number)
        ? String(existing.writing_number).trim()
        : null,
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
    if (existing) {
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(
        existing as unknown as Record<string, unknown>,
        entry as unknown as Record<string, unknown>
      )
      entry.changedFields = changedFields
      entry.previousValues = previousValues
    }
    previewEntries.push(entry)
  }

  console.log('[Deal Tracker] Transamerica policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process Transamerica commission file rows into deal_tracker preview entries.
 * Aggregates positive/negative commission amounts per policy_number; pulls policy
 * context from `transamerica_policies` when available, falls back to commission row
 * insured_name + writing_agent_name for policies new to deal_tracker.
 */
export async function processTransamericaCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processTransamericaCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Transamerica commission):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Transamerica'
  const carrierCode = carrier.code || 'TRANSAMERICA'
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('transamerica_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )

    if (!commissions || commissions.length === 0) {
      console.warn('[Deal Tracker] No Transamerica commissions found for file_id:', fileId)
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
    console.warn('[Deal Tracker] Failed to fetch existing Transamerica deal_tracker entries:', e?.message)
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
      comm.comm_amount != null
        ? typeof comm.comm_amount === 'string'
          ? parseFloat(comm.comm_amount)
          : comm.comm_amount
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
        .from('transamerica_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', allCommissionPolicyNumbers)
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
    const namesForDDF: string[] = []
    for (const pn of missingPolicyNumbers) {
      const policy = policiesMap.get(pn)
      const comm = commissionMap.get(pn)
      const candidate = buildTransamericaInsuredName(policy ?? {}) || (comm?.insured_name ?? '').toString().trim()
      if (candidate) namesForDDF.push(candidate)
    }
    if (namesForDDF.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(namesForDDF, carrierName)
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const commission of commissionMap.values()) {
    const policyNumber = commission.policy_number
    const existing = existingMap.get(policyNumber)
    const policy = policiesMap.get(policyNumber)
    const positiveAmount = commissionPositiveMap.get(policyNumber)
    const chargeBack: number | null = commissionChargebackMap.get(policyNumber) ?? null

    const { dealValue, ccValue } = resolveCommissionPreviewDealValue(
      existing?.deal_value,
      existing?.cc_value,
      positiveAmount,
      existing?.deal_creation_date ?? policy?.issue_date ?? commission.issue_date ?? null,
    )

    const effectiveChargeBack = chargeBack ?? existing?.charge_back ?? null
    const derivedStatus = statusFromDealValueAndChargeback(dealValue, effectiveChargeBack)

    if (existing) {
      const carrierStatusForGhl = policy?.status ?? existing.carrier_status ?? null
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
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierStatusForGhl,
        allMappings: ghlStageMappingMap,
        effectiveDate,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
        dealCreationDate: existing.deal_creation_date ?? policy?.issue_date ?? null,
        dealValue,
        chargeBack: effectiveChargeBack,
        commissionType: commission.comm_type || existing.commission_type || null,
        existingGhlStage: existing.ghl_stage ?? null,
        carrierCode,
      })

      const entry: DealTrackerPreviewEntry = {
        ...existing,
        ghl_stage: mappedGhlStage ?? existing.ghl_stage,
        carrier_status: carrierStatusForGhl,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        policy_status: policyStatusResolved,
        status: derivedStatus,
        sales_agent: commission.writing_agent_name || existing.sales_agent,
        writing_number: commission.writing_agent_number || existing.writing_number,
        commission_type: commission.comm_type || existing.commission_type,
        effective_date: effectiveDate,
        commission_date: commission.statement_date ?? commission.paid_date ?? null,
        source_commission_table: 'transamerica_commissions',
        source_commission_id: commission.id,
        isNew: false,
        isUpdated: true,
      }
      const newSnapshot = {
        ...existing,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        status: derivedStatus,
        sales_agent: commission.writing_agent_name || existing.sales_agent,
        writing_number: commission.writing_agent_number || existing.writing_number,
        commission_type: commission.comm_type || existing.commission_type,
      } as Record<string, unknown>
      const { changedFields, previousValues } = getChangedFieldsAndPrevious(
        existing as Record<string, unknown>,
        newSnapshot
      )
      entry.changedFields = changedFields
      entry.previousValues = previousValues
      previewEntries.push(entry)
    } else {
      // New row: prefer policy data when present, otherwise fall back to commission row fields.
      const insuredName =
        buildTransamericaInsuredName(policy ?? {}) ||
        (commission.insured_name ?? '').toString().trim() ||
        null
      const carrierStatusForGhl = policy?.status ?? null
      const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
        statusMappingMap,
        carrierStatusForGhl,
        false,
        undefined
      )
      const normalizedName = normalizeNameForSearch(insuredName || '')
      const ddfInfo = normalizedName ? dailyDealFlowMap.get(normalizedName) : null
      const callCenter = ddfInfo?.call_center ?? null
      const phoneNumber = ddfInfo?.phone_number ?? null
      const effectiveDateFromDdf = ddfInfo?.draft_date ?? null
      const effectiveForGhl = mergeEffectiveDateWithPendingRoll(
        carrierStatusForGhl,
        policyStatusResolved,
        null,
        effectiveDateFromDdf,
        policy?.issue_date ?? commission.issue_date ?? null,
      )
      const dealCreationDateNew = policy?.issue_date ?? commission.issue_date ?? null
      const mappedGhlStage = resolveGhlStage({
        carrierStatus: carrierStatusForGhl,
        allMappings: ghlStageMappingMap,
        effectiveDate: effectiveForGhl,
        effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(null, effectiveForGhl),
        dealCreationDate: dealCreationDateNew,
        dealValue,
        chargeBack: effectiveChargeBack,
        commissionType: commission.comm_type || null,
        existingGhlStage: null,
        carrierCode,
      })

      const entry: DealTrackerPreviewEntry = {
        agency_carrier_id: agencyCarrierId,
        name: insuredName,
        tasks: null,
        ghl_name: ddfInfo?.lead_name ?? null,
        ghl_stage: mappedGhlStage,
        policy_status: policyStatusResolved,
        deal_creation_date: dealCreationDateNew,
        policy_number: policyNumber,
        carrier: carrierName,
        carrier_id: carrier.id,
        deal_value: dealValue,
        cc_value: ccValue,
        charge_back: effectiveChargeBack,
        notes: null,
        status: derivedStatus,
        last_updated: new Date().toISOString(),
        sales_agent: commission.writing_agent_name || null,
        writing_number: commission.writing_agent_number || null,
        commission_type: commission.comm_type || null,
        // Commission upload must not override effective_date for new rows;
        // the policy upload (or DDF backfill) is the source of truth.
        effective_date: null,
        commission_date: commission.statement_date ?? commission.paid_date ?? null,
        call_center: callCenter,
        phone_number: phoneNumber,
        cc_pmt_ws: null,
        cc_cb_ws: null,
        carrier_status: carrierStatusForGhl,
        policy_type: policy?.product_type ?? commission.product_type ?? null,
        daily_deal_flow_fetched: !!(callCenter || phoneNumber),
        daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : null,
        source_policy_table: policy ? 'transamerica_policies' : null,
        source_policy_id: policy?.id ?? null,
        source_commission_table: 'transamerica_commissions',
        source_commission_id: commission.id,
        isNew: true,
        isUpdated: false,
      }
      previewEntries.push(entry)
    }
  }

  console.log('[Deal Tracker] Transamerica commission processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
