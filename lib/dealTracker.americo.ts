import { supabase } from './supabaseClient'
import type { DealTrackerPreviewEntry } from './dealTracker'
import {
  bulkFetchStatusMappings,
  bulkFetchGhlStageMappings,
  fetchAllPaginated,
  bulkFetchDailyDealFlowInfo,
  normalizeNameForSearch,
  statusFromDealValueAndChargeback,
  getChangedFieldsAndPrevious,
  carrierStatusUnchanged,
  policyNeedsDdfLookup,
  resolvePolicyStatusFromCarrierMapping,
  calculateCcValue,
  resolveCommissionPreviewDealValue,
} from './dealTracker'
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview } from './calendarDate'

function normalizePolicyNumberSoft(value: any): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

/**
 * Process Americo policy files and create deal tracker entries.
 *
 * Policy-only: unlike MOH/Aetna/etc., there is no americo_commissions table yet
 * (the Americo agent portal has no bulk commission-dollar export we've found a
 * source for) — see lib/uploadLogic.ts's buildAmericoPolicyRows for context.
 * Deal Value therefore has nowhere to come from on a first upload; it's left
 * null (same as any other carrier's "policy uploaded, no commission yet" case)
 * and preserved from any existing deal_tracker row on re-uploads, exactly like
 * MOH's policy-only fallback. Sales Agent / Writing # come directly off the
 * policy row (americo_policies already has Agent/Agent #), unlike carriers
 * where those only appear on the commission file.
 */
export async function processAmericoFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmericoFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Americo):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Americo'
  const carrierCode = carrier.code || 'AMERICO'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('americo_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching Americo policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No Americo policies found for file_id:', fileId)
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
    console.warn('[Deal Tracker] Failed to fetch existing Americo deal_tracker entries:', existingError?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach(entry => {
      existingMap.set(normalizePolicyNumberSoft(entry.policy_number), entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p =>
    policyNeedsDdfLookup(existingMap.get(normalizePolicyNumberSoft(p.policy_number)))
  )
  const uniqueInsuredNames = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => (p.insured ?? '').trim())
        .filter((n: string) => n.length > 0)
    )
  )

  const skipCount = policies.length - policiesNeedingDdf.length
  console.log('[Deal Tracker] Americo: carrier=', carrierName, '| names to DDF=', uniqueInsuredNames.length, '| skip (already have DDF)=', skipCount)

  const dailyDealFlowMap =
    uniqueInsuredNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, ddfCarrier)
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  console.log('[Deal Tracker] Americo: DDF map size after fetch:', dailyDealFlowMap.size, 'of', uniqueInsuredNames.length, 'names')

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const existing = existingMap.get(normalizePolicyNumberSoft(policy.policy_number))
    const insuredName = (policy.insured ?? '').trim()
    const originalStatus = policy.policy_status || policy.original_status || null

    const alreadyHasDdfContact = existing?.call_center != null || existing?.phone_number != null
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = dailyDealFlowMap.get(normalizedName) || null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdfContact) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      callCenter = ddfInfo?.call_center ?? null
      phoneNumber = ddfInfo?.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

    // No commission source yet — preserve whatever deal_value/charge_back already
    // exists on deal_tracker (same as any other carrier's policy-only upload);
    // otherwise leave null until a commission file exists for Americo.
    const dealValue: number | null = existing?.deal_value != null
      ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value)
      : null
    const chargeBack: number | null = existing?.charge_back ?? null

    const ccValue = calculateCcValue(
      dealValue,
      existing?.deal_creation_date ??
        (policy.received_date as string | undefined) ??
        (policy.effective_date as string | undefined) ??
        null
    )

    // Deal date: Received Date is the closest Americo analog to "when the deal came in".
    const dealCreationDate =
      (policy.received_date as string | undefined) ||
      (policy.effective_date as string | undefined) ||
      null

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy?.effective_date,
    )
    const dealCreationDateForGhl = existing?.deal_creation_date ?? dealCreationDate

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)

    const shouldPreserveMappedStatus = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!shouldPreserveMappedStatus,
      existing?.policy_status
    )

    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate: dealCreationDateForGhl,
      dealValue,
      chargeBack,
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
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBack,
      notes: existing?.notes ?? null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: policy.agent_name ?? existing?.sales_agent ?? null,
      writing_number: policy.agent_number ?? existing?.writing_number ?? null,
      commission_type: null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.product ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'americo_policies',
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

  console.log('[Deal Tracker] Americo policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Transaction types whose `amt` counts as actual commission dollars paid this
 * period. Confirmed against a real statement: summing only ADVNCE9 rows exactly
 * matches the statement's own "AMOUNT PAID TO AGENT VIA EFT" total. PAID1 rows
 * are an earned/offset entry against the outstanding advance balance, not new
 * cash paid this period, so they're stored (for record-keeping) but excluded
 * here. Add more codes here if a future statement shows a genuine chargeback
 * transaction type distinct from these two.
 */
const DEAL_VALUE_TRANSACTION_TYPES = new Set(['ADVNCE9'])

/**
 * Process Americo commission PDF files and update deal tracker entries.
 * Commission-driven flow, mirrors processMohCommissionsForDealTracker: updates
 * existing rows and creates new ones when a commission references a policy_number
 * not yet in deal_tracker.
 */
export async function processAmericoCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processAmericoCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (Americo commissions):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'Americo'
  const carrierCode = carrier.code || 'AMERICO'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    const { data: fetched, error: commissionsError } = await supabase
      .from('americo_commissions')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .eq('file_id', fileId)

    if (commissionsError) {
      console.error('[Deal Tracker] Error fetching Americo commissions:', commissionsError)
      throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
    }

    if (!fetched || fetched.length === 0) {
      console.warn('[Deal Tracker] No Americo commissions found for file_id:', fileId)
      return []
    }
    commissions = fetched
  }

  const policyNumbers = Array.from(
    new Set(
      commissions
        .map((c: any) => normalizePolicyNumberSoft(c.policy_number))
        .filter(Boolean)
    )
  )

  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbers)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing Americo deal_tracker entries (commissions):', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      existingMap.set(normalizePolicyNumberSoft(entry.policy_number), entry)
    })
  }

  // Fetch Americo policies for these policy numbers (fills in insured name,
  // carrier status, product, effective/received dates) - the commission file's
  // name_desc is only an abbreviated last name, not reliable on its own.
  let policiesMap = new Map<string, any>()
  if (policyNumbers.length > 0) {
    const policies = await fetchAllPaginated(() =>
      supabase
        .from('americo_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
    policies.forEach((p: any) => {
      policiesMap.set(normalizePolicyNumberSoft(p.policy_number), p)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  // Aggregate commissions per policy: sum only DEAL_VALUE_TRANSACTION_TYPES rows,
  // but keep a representative row (preferring an ADVNCE9 row) for source linkage
  // and group-level agent info.
  const dealValueSumMap = new Map<string, number>()
  const representativeRowMap = new Map<string, any>()
  commissions.forEach((comm: any) => {
    const policyNum = normalizePolicyNumberSoft(comm.policy_number)
    if (!policyNum) return

    if (DEAL_VALUE_TRANSACTION_TYPES.has(comm.transaction_type)) {
      const amountRaw = comm.amt != null ? (typeof comm.amt === 'string' ? parseFloat(comm.amt) : comm.amt) : 0
      const amount = Number.isNaN(amountRaw) ? 0 : amountRaw
      dealValueSumMap.set(policyNum, (dealValueSumMap.get(policyNum) || 0) + amount)

      const existingRep = representativeRowMap.get(policyNum)
      if (!existingRep || DEAL_VALUE_TRANSACTION_TYPES.has(existingRep.transaction_type) === false) {
        representativeRowMap.set(policyNum, comm)
      }
    } else if (!representativeRowMap.has(policyNum)) {
      representativeRowMap.set(policyNum, comm)
    }
  })

  const allPolicyNumbersNeedingDDF = Array.from(representativeRowMap.keys()).filter(pn => {
    const existing = existingMap.get(pn)
    return policyNeedsDdfLookup(existing)
  })

  let dailyDealFlowMap = new Map<
    string,
    { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
  >()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const namesForDdf = allPolicyNumbersNeedingDDF
      .map(pn => (policiesMap.get(pn)?.insured ?? '').trim())
      .filter((n: string) => n.length > 0)

    if (namesForDdf.length > 0) {
      console.log('[Deal Tracker] Americo commissions: fetching DDF for', namesForDdf.length, 'names')
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(namesForDdf, ddfCarrier)
    } else {
      console.log('[Deal Tracker] Americo commissions: no policy names for DDF - upload the policy file first so americo_policies has rows for these policy numbers')
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const [policyNumber, comm] of representativeRowMap.entries()) {
    const existing = existingMap.get(policyNumber)
    const policy = policiesMap.get(policyNumber)

    const insuredName = (policy?.insured ?? '').trim() || null
    const originalStatus = policy?.policy_status || existing?.carrier_status || existing?.policy_status || null
    const totalAmount = dealValueSumMap.get(policyNumber)

    let dealValue: number | null = totalAmount != null ? totalAmount : null
    let chargeBack: number | null = existing?.charge_back ?? null

    // 0 or missing this-upload amount: preserve prior deal_value/charge_back
    // (a policy can appear in a statement via PAID1-only rows with no ADVNCE9,
    // e.g. an ongoing offset with no new advance this period).
    if (dealValue == null || dealValue === 0) {
      const existingDeal =
        existing?.deal_value != null
          ? (typeof existing.deal_value === 'number' ? existing.deal_value : parseFloat(String(existing.deal_value)))
          : null
      dealValue = Number.isNaN(existingDeal as number) ? null : existingDeal
      chargeBack = existing?.charge_back ?? null
    }

    // Guard: deal_value must never go negative from a single upload; route any
    // negative net into charge_back instead (mirrors every other carrier).
    if (existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number' ? existing.deal_value : parseFloat(String(existing.deal_value)))
            : null
        dealValue = existingDeal
        const existingCb = chargeBack != null ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack))) : 0
        const newCb = existingCb + numericDeal
        chargeBack = Number.isNaN(newCb) ? numericDeal : newCb
      }
    } else if (!existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        dealValue = null
        chargeBack = numericDeal
      }
    }

    const americoCcFallbackDate =
      existing?.deal_creation_date ??
      (policy?.received_date as string | undefined) ??
      (comm.transaction_date as string | undefined) ??
      (policy?.effective_date as string | undefined) ??
      null

    // Once a positive deal_value is on deal_tracker, lock it - later uploads
    // (e.g. the PAID1 offset trickling in) must not silently change it.
    const positivePreview = resolveCommissionPreviewDealValue(
      existing?.deal_value,
      existing?.cc_value,
      dealValue != null && dealValue > 0 ? dealValue : null,
      americoCcFallbackDate,
    )
    if (positivePreview.preserved) {
      dealValue = positivePreview.dealValue
    }
    const ccValue = positivePreview.preserved
      ? positivePreview.ccValue
      : calculateCcValue(dealValue, americoCcFallbackDate)

    let callCenter = existing?.call_center ?? null
    let phoneNumber = existing?.phone_number ?? null
    let dailyDealFlowFetched = existing?.daily_deal_flow_fetched ?? false
    let dailyDealFlowFetchedAt = existing?.daily_deal_flow_fetched_at ?? null
    let effectiveDateFromDdf: string | null = null
    let ddfInfo: { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null } | null = null

    if (insuredName) {
      const normalizedName = normalizeNameForSearch(insuredName)
      ddfInfo = dailyDealFlowMap.get(normalizedName) ?? null
      if (ddfInfo && callCenter == null && phoneNumber == null) {
        callCenter = ddfInfo.call_center ?? null
        phoneNumber = ddfInfo.phone_number ?? null
        dailyDealFlowFetched = !!(callCenter || phoneNumber)
        dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
      }
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }

    const dealCreationDate =
      (policy?.received_date as string | undefined) ||
      (comm.transaction_date as string | undefined) ||
      (policy?.effective_date as string | undefined) ||
      null
    const dealCreationDateForGhl = existing?.deal_creation_date ?? dealCreationDate

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy?.effective_date,
    )

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
    const statusUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!statusUnchanged,
      existing?.policy_status
    )

    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate: dealCreationDateForGhl,
      dealValue,
      chargeBack,
      commissionType: comm.transaction_type ?? null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: policyStatusResolved,
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBack,
      notes: existing?.notes ?? null,
      status: derivedStatus,
      last_updated: new Date().toISOString(),
      sales_agent: comm.agent_name ?? policy?.agent_name ?? existing?.sales_agent ?? null,
      writing_number: comm.agent_number ?? policy?.agent_number ?? existing?.writing_number ?? null,
      commission_type: comm.transaction_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy?.product ?? null,
      daily_deal_flow_fetched: dailyDealFlowFetched,
      daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
      source_policy_table: policy ? 'americo_policies' : (existing?.source_policy_table ?? null),
      source_policy_id: policy?.id ?? (existing?.source_policy_id ?? null),
      source_commission_table: 'americo_commissions',
      source_commission_id: comm.id,
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

  console.log('[Deal Tracker] Americo commissions processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
