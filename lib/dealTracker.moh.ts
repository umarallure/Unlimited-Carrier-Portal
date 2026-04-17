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
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview } from './calendarDate'

/**
 * Build insured name from MOH policy fields for DDF lookup.
 * MOH stores a single insured name string (and optional second insured); prefer primary.
 */
function buildMohInsuredName(p: { insured_nme?: string | null; insured2_nme?: string | null }): string {
  const primary = (p.insured_nme ?? '').trim()
  const secondary = (p.insured2_nme ?? '').trim()
  return (primary || secondary || '').trim()
}

function normalizePolicyNumberSoft(value: any): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function normalizeStatusKey(v: unknown): string {
  const s = (v == null ? '' : String(v)).trim()
  return s.replace(/\s+/g, ' ')
}

function normalizePolicyStatusForMappedGhlStageLocal(
  mappedGhlStage: string | null | undefined,
  policyStatus: string | null | undefined,
): string | null {
  if (!mappedGhlStage) return policyStatus ?? null
  const stage = mappedGhlStage.trim().toLowerCase()
  if (stage === 'pending lapse' || stage.startsWith('pending lapse ')) return 'Pending Lapse'
  if (
    stage === 'fdpf pending reason' ||
    stage === 'fdpf insufficient funds' ||
    stage === 'fdpf incorrect banking info' ||
    stage === 'issued - pending first draft'
  ) {
    return 'Issued Not Paid'
  }
  return policyStatus ?? null
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
      const key = normalizePolicyNumberSoft(entry.policy_number)
      existingMap.set(key, entry)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const policiesNeedingDdf = policies.filter(p =>
    policyNeedsDdfLookup(existingMap.get(normalizePolicyNumberSoft(p.policy_number)))
  )
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
      : new Map<
          string,
          { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
        >()

  console.log('[Deal Tracker] MOH: DDF map size after fetch:', dailyDealFlowMap.size, 'of', uniqueInsuredNamesMoh.length, 'names')

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const commission = commissionMap.get(policy.policy_number)
    const existing = existingMap.get(normalizePolicyNumberSoft(policy.policy_number))
    const insuredName = buildMohInsuredName(policy)
    const originalStatus = policy.policy_status_nme || null
    // Use existing call_center/phone if already set; else use DDF. Always read draft_date from bulk map when fetched (fill missing effective_date).
    const alreadyHasDdfContact = existing?.call_center != null || existing?.phone_number != null
    const normalizedNameMoh = normalizeNameForSearch(insuredName)
    const ddfInfoMoh = dailyDealFlowMap.get(normalizedNameMoh) || null
    let callCenter: string | null
    let phoneNumber: string | null
    if (alreadyHasDdfContact) {
      callCenter = existing!.call_center
      phoneNumber = existing!.phone_number
    } else {
      callCenter = ddfInfoMoh?.call_center ?? null
      phoneNumber = ddfInfoMoh?.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfoMoh?.draft_date ?? null

    const rawDealValue =
      commission && commission.comm_amt != null
        ? (typeof commission.comm_amt === 'string' ? parseFloat(commission.comm_amt) : commission.comm_amt)
        : null
    let dealValue: number | null = Number.isNaN(rawDealValue as any) ? null : rawDealValue
    let chargeBack: number | null = existing?.charge_back ?? null

    // Policy-only OR 0-commission: preserve existing deal_value/cc_value so we don't wipe financials.
    // Business rule: a 0 commission in MOH should behave like "no commission" (do not change deal_value / status).
    if ((dealValue == null || dealValue === 0) && existing) {
      dealValue = existing.deal_value != null
        ? (typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value)
        : null
      chargeBack = existing.charge_back ?? null
      if (Number.isNaN(dealValue as number)) dealValue = null
    }

    // Business rule: deal_value must never become negative when updating an existing policy.
    if (existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = existingDeal
        const existingCb =
          chargeBack != null
            ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack)))
            : 0
        chargeBack = existingCb + numericDeal
      }
    } else if (!existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        dealValue = null
        chargeBack = numericDeal
      }
    }

    const ccValue = dealValue != null ? dealValue / 2 : null

    // Deal date: CARRIER_RECEIVED (application_received_dte) is the deal date for MOH
    const dealCreationDate =
      (policy.application_received_dte as string | undefined) ||
      (commission?.activity_date as string | undefined) ||
      (commission?.issue_date as string | undefined) ||
      (policy.policy_issue_dte as string | undefined) ||
      (policy.policy_effective_dte as string | undefined) ||
      null

    // Effective date: keep deal_tracker value; else DDF draft_date; else policy/commission fallbacks (deal date stays on deal_creation_date).
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy?.policy_effective_dte,
      commission?.issue_date,
    )
    const dealCreationDateForGhl = existing?.deal_creation_date ?? dealCreationDate

    const entryIndex = previewEntries.length
    if (entryIndex < 3) {
      console.log('[Deal Tracker] MOH policy sample', entryIndex + 1, '| insuredName:', insuredName, '| ddfFound:', !!(callCenter || phoneNumber), '| dealValue:', dealValue, '| commActivityType:', commission?.activity_type ?? null)
    }

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)

    const shouldPreserveMappedStatus = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!shouldPreserveMappedStatus,
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
      dealCreationDate: dealCreationDateForGhl,
      dealValue,
      commissionType: commission?.activity_type ?? null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfoMoh?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: policyStatusResolved,
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBack,
      notes: (commission?.comments != null && String(commission.comments).trim() !== '') ? commission.comments : (existing?.notes ?? null),
      status: (existing && financialsUnchanged(existing, dealValue, chargeBack)) ? (existing.status ?? (derivedStatus ?? statusFromDealValue(dealValue))) : (derivedStatus ?? statusFromDealValue(dealValue)),
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

  console.log('[Deal Tracker] MOH policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process MOH commission files and update deal tracker entries.
 * Commission-driven flow similar to AMAM commissions: updates existing rows and creates new ones when needed.
 */
export async function processMohCommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string,
  commissionsOverride?: ReadonlyArray<Record<string, unknown>>
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processMohCommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (MOH commissions):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'MOH'
  const carrierCode = carrier.code || 'MOH'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let commissions: any[]
  if (commissionsOverride && commissionsOverride.length > 0) {
    commissions = commissionsOverride as any[]
  } else {
    const { data: fetched, error: commissionsError } = await supabase
      .from('moh_commissions')
      .select('*')
      .eq('agency_carrier_id', agencyCarrierId)
      .eq('file_id', fileId)

    if (commissionsError) {
      console.error('[Deal Tracker] Error fetching MOH commissions:', commissionsError)
      throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
    }

    if (!fetched || fetched.length === 0) {
      console.warn('[Deal Tracker] No MOH commissions found for file_id:', fileId)
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
      const key = normalizePolicyNumberSoft(entry.policy_number)
      existingMap.set(key, entry)
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
      const key = normalizePolicyNumberSoft(p.policy_number)
      policiesMap.set(key, p)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  // Aggregate commissions per policy
  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissions.forEach((comm: any) => {
    const policyNumRaw = comm.policy_number
    const policyNum = normalizePolicyNumberSoft(policyNumRaw)
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

  const allPolicyNumbersNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const existing = existingMap.get(pn)
    return policyNeedsDdfLookup(existing)
  })

  let dailyDealFlowMap = new Map<
    string,
    { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
  >()
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
    const originalStatus = policy?.policy_status_nme || existing?.carrier_status || existing?.policy_status || null
    const totalAmount = commissionAmountsMap.get(policyNumber)
    let dealValue: number | null = totalAmount != null ? totalAmount : null
    let chargeBack: number | null = existing?.charge_back ?? null

    // 0-commission net amount should behave like "no commission" for existing rows:
    // keep prior deal_value / charge_back and therefore preserve rule-based Status.
    if (existing && (dealValue == null || dealValue === 0)) {
      const existingDeal =
        existing.deal_value != null
          ? (typeof existing.deal_value === 'number'
              ? existing.deal_value
              : parseFloat(String(existing.deal_value)))
          : null
      dealValue = Number.isNaN(existingDeal as number) ? null : existingDeal
      chargeBack = existing.charge_back ?? null
    }

    // Business rule: deal_value must never become negative when updating an existing policy.
    // If net commission is negative, preserve prior deal_value and put the negative in charge_back.
    if (existing && dealValue != null) {
      const numericDeal = typeof dealValue === 'number' ? dealValue : parseFloat(String(dealValue))
      if (!Number.isNaN(numericDeal) && numericDeal < 0) {
        const existingDeal =
          existing.deal_value != null
            ? (typeof existing.deal_value === 'number'
                ? existing.deal_value
                : parseFloat(String(existing.deal_value)))
            : null
        dealValue = existingDeal
        const existingCb =
          chargeBack != null
            ? (typeof chargeBack === 'number' ? chargeBack : parseFloat(String(chargeBack)))
            : 0
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

    const ccValue = dealValue != null ? dealValue / 2 : null

    let callCenter = existing?.call_center ?? null
    let phoneNumber = existing?.phone_number ?? null
    let dailyDealFlowFetched = existing?.daily_deal_flow_fetched ?? false
    let dailyDealFlowFetchedAt = existing?.daily_deal_flow_fetched_at ?? null
    let effectiveDateFromDdf: string | null = null

    let ddfInfo:
      | { call_center: string | null; phone_number: string | null; draft_date: string | null; lead_name: string | null }
      | null = null

    if (policy) {
      const nameForDdf = buildMohInsuredName(policy)
      const normalizedName = normalizeNameForSearch(nameForDdf)
      ddfInfo = dailyDealFlowMap.get(normalizedName) ?? null
      if (ddfInfo && callCenter == null && phoneNumber == null) {
        callCenter = ddfInfo.call_center ?? null
        phoneNumber = ddfInfo.phone_number ?? null
        dailyDealFlowFetched = !!(callCenter || phoneNumber)
        dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
      }
      effectiveDateFromDdf = ddfInfo?.draft_date ?? null
    }

    // Deal date: CARRIER_RECEIVED (application_received_dte) is the deal date for MOH
    const dealCreationDate =
      (policy?.application_received_dte as string | undefined) ||
      (comm.activity_date as string | undefined) ||
      (comm.issue_date as string | undefined) ||
      (policy?.policy_issue_dte as string | undefined) ||
      (policy?.policy_effective_dte as string | undefined) ||
      null

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.policy_status ?? null,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy?.policy_effective_dte,
      comm.issue_date,
    )
    const dealCreationDateForGhl = existing?.deal_creation_date ?? dealCreationDate

    const derivedStatus = statusFromDealValueAndChargeback(dealValue, chargeBack)
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
      dealCreationDate: dealCreationDateForGhl,
      dealValue,
      chargeBack,
      commissionType: comm.activity_type ?? null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const normalizedPolicyStatus = normalizePolicyStatusForMappedGhlStageLocal(
      mappedGhlStage,
      policyStatusResolved,
    )

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? ddfInfo?.lead_name ?? null,
      ghl_stage: mappedGhlStage,
      policy_status: normalizedPolicyStatus,
      deal_creation_date: dealCreationDateForGhl,
      policy_number: policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      charge_back: chargeBack,
      notes: (comm.comments != null && String(comm.comments).trim() !== '') ? comm.comments : (existing?.notes ?? null),
      status: derivedStatus ?? statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: existing?.sales_agent ?? null,
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

  console.log('[Deal Tracker] MOH commissions processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

