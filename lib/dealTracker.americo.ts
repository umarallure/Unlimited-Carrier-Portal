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
  financialsUnchanged,
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
 * ghlStageResolver.ts's cancellation-text rule deliberately always prefers
 * "Chargeback Cancellation" whenever the carrier status text contains "cancel"
 * - by design, for every carrier, even when there's no actual negative
 * charge_back to justify a chargeback classification (see the "even if the
 * commission net looks like a chargeback" comment there). That's a shared
 * rule affecting every carrier, so it's not touched here. For Americo
 * specifically, "Cancelled" with no real chargeback signal should resolve to
 * Application Withdrawn instead - scoped to just this carrier by overriding
 * the resolved stage (and the paired policy_status label, so the two stay
 * consistent - same "Application Withdrawn" <-> "Withdrawn" pairing Aetna/AHL
 * already use) after the fact, rather than changing the shared rule.
 */
function overrideAmericoCancelledWithoutChargeback(
  mappedGhlStage: string | null,
  policyStatusResolved: string | null,
  originalStatus: string | null,
  chargeBack: number | null
): { ghlStage: string | null; policyStatus: string | null } {
  if (!originalStatus || !/cancel/i.test(originalStatus)) {
    return { ghlStage: mappedGhlStage, policyStatus: policyStatusResolved }
  }
  const hasRealChargeback = chargeBack != null && chargeBack < 0
  if (hasRealChargeback) {
    return { ghlStage: mappedGhlStage, policyStatus: policyStatusResolved }
  }
  if (mappedGhlStage === 'Chargeback Cancellation' || mappedGhlStage === 'Chargeback Failed Payment') {
    return { ghlStage: 'Application Withdrawn', policyStatus: 'Withdrawn' }
  }
  return { ghlStage: mappedGhlStage, policyStatus: policyStatusResolved }
}

/**
 * Process Americo policy files and create deal tracker entries.
 *
 * Policy-only: this function does not join against americo_commissions (unlike
 * AHL/Aetna/AMAM's policy-file processing, which does). A policy file upload
 * leaves Deal Value untouched — it's read only from any existing deal_tracker
 * row and preserved as-is, same as any other carrier's "policy uploaded, no
 * commission yet" case. Deal Value only actually gets set/updated via
 * processAmericoCommissionsForDealTracker below (the commission PDF path).
 * Sales Agent / Writing # come directly off the policy row (americo_policies
 * already has Agent/Agent #), unlike carriers where those only appear on the
 * commission file — so no commission join is needed here for that either.
 */
export async function processAmericoFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {

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

  // Fetch any americo_commissions already on file for these policies, so a
  // policy re-upload can also pick up a genuinely new deal_value if a
  // commission file was uploaded after the last policy upload - mirrors
  // AHL's policy-function commission join, adapted to Americo's multi-row-
  // per-policy commission structure (only ADVNCE9 rows count toward deal
  // value, same aggregation processAmericoCommissionsForDealTracker uses).
  let policyCommissions: any[] = []
  try {
    policyCommissions = await fetchAllPaginated(() =>
      supabase
        .from('americo_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
    )
  } catch (_) {}

  const commissionDealValueMap = new Map<string, number>()
  policyCommissions.forEach((comm: any) => {
    const pn = normalizePolicyNumberSoft(comm.policy_number)
    if (!pn || !DEAL_VALUE_TRANSACTION_TYPES.has(comm.transaction_type)) return
    const amountRaw = comm.amt != null ? (typeof comm.amt === 'string' ? parseFloat(comm.amt) : comm.amt) : 0
    const amount = Number.isNaN(amountRaw) ? 0 : amountRaw
    commissionDealValueMap.set(pn, (commissionDealValueMap.get(pn) || 0) + amount)
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
  // Exact policy-number match (tracking_id, decrypted) takes priority over
  // name-only fuzzy matching — same as AHL/Aetna/AMAM.
  const policyNumberByName = new Map<string, string>()
  policiesNeedingDdf.forEach(p => {
    const normalized = normalizeNameForSearch((p.insured ?? '').trim())
    if (normalized && p.policy_number) policyNumberByName.set(normalized, p.policy_number)
  })

  const skipCount = policies.length - policiesNeedingDdf.length
  const dailyDealFlowMap =
    uniqueInsuredNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, ddfCarrier, undefined, policyNumberByName)
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

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

    const americoCcFallbackDate =
      existing?.deal_creation_date ??
      (policy.received_date as string | undefined) ??
      (policy.effective_date as string | undefined) ??
      null

    // If a commission file for this policy already exists (uploaded before or
    // after this policy file), pick up its ADVNCE9-summed deal_value here too
    // - not just whatever existing.deal_value already has - same "lock in a
    // positive value" rule the commission function uses, so a policy re-upload
    // can't silently wipe/change a deal_value already confirmed by commission
    // data. Falls back to preserving existing.deal_value when there's no
    // commission on file yet (same as any other carrier's policy-only upload).
    const chargeBack: number | null = existing?.charge_back ?? null
    const commissionDealValue = commissionDealValueMap.get(normalizePolicyNumberSoft(policy.policy_number))
    let dealValue: number | null = existing?.deal_value != null
      ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value)
      : null
    let ccValue: number | null
    if (commissionDealValue != null && commissionDealValue > 0) {
      const positivePreview = resolveCommissionPreviewDealValue(
        existing?.deal_value,
        existing?.cc_value,
        commissionDealValue,
        americoCcFallbackDate,
      )
      dealValue = positivePreview.dealValue
      ccValue = positivePreview.ccValue
    } else {
      ccValue = calculateCcValue(dealValue, americoCcFallbackDate)
    }

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

    // Preserve a manually-adjusted `status` across a re-upload when nothing
    // financial actually changed (same as AHL/Aetna) — otherwise every policy
    // re-upload silently overwrites any manual status edit.
    const derivedStatus =
      existing && financialsUnchanged(existing, dealValue, chargeBack)
        ? (existing.status ?? statusFromDealValueAndChargeback(dealValue, chargeBack))
        : statusFromDealValueAndChargeback(dealValue, chargeBack)

    const shouldPreserveMappedStatus = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusMapped = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!shouldPreserveMappedStatus,
      existing?.policy_status
    )

    const ghlStageMapped = resolveGhlStage({
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
    const { ghlStage: mappedGhlStage, policyStatus: policyStatusResolved } = overrideAmericoCancelledWithoutChargeback(
      ghlStageMapped,
      policyStatusMapped,
      originalStatus,
      chargeBack
    )

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
    // Exact policy-number match (tracking_id, decrypted) takes priority over
    // name-only fuzzy matching — same as AHL/Aetna/AMAM.
    const policyNumberByName = new Map<string, string>()
    allPolicyNumbersNeedingDDF.forEach(pn => {
      const name = (policiesMap.get(pn)?.insured || existingMap.get(pn)?.name || '').trim()
      const normalized = normalizeNameForSearch(name)
      if (normalized && pn) policyNumberByName.set(normalized, pn)
    })

    if (namesForDdf.length > 0) {
      dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(namesForDdf, ddfCarrier, undefined, policyNumberByName)
    } else {
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
    const policyStatusMapped = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!statusUnchanged,
      existing?.policy_status
    )

    const ghlStageMapped = resolveGhlStage({
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
    const { ghlStage: mappedGhlStage, policyStatus: policyStatusResolved } = overrideAmericoCancelledWithoutChargeback(
      ghlStageMapped,
      policyStatusMapped,
      originalStatus,
      chargeBack
    )

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

  return previewEntries
}
