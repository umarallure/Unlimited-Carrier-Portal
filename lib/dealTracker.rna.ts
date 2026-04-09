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
} from './dealTracker'
import { resolveGhlStage, mergeEffectiveDateWithPendingRoll } from './ghlStageResolver'
import { effectiveDateForThreeMonthRuleFromPreview, mergeEffectiveDate } from './calendarDate'

/**
 * Normalize RNA policy number for consistent matching with existing deal_tracker rows.
 * Strips leading zeros so both 000008204677 and 8204677 map to the same key.
 * Exported for Deal Tracker Compare and any tool that must key policies the same way as saves/upserts.
 */
export function normalizeRnaPolicyKey(value: string | null | undefined): string {
  if (!value) return ''
  const trimmed = String(value).trim()
  const stripped = trimmed.replace(/^0+/, '')
  return stripped || trimmed
}

/**
 * Build insured name from RNA policy for DDF lookup.
 */
function buildRnaInsuredName(p: { insured_name?: string | null }): string {
  return (p.insured_name ?? '').trim()
}

/**
 * Process RNA carrier policy files and create deal tracker entries.
 * Uses rna_policies + rna_commissions + DDF, same pattern as MOH.
 */
export async function processRNAFilesForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processRNAFilesForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (RNA):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'RNA'
  const carrierCode = carrier.code || 'RNA'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  let policies: any[]
  try {
    policies = await fetchAllPaginated(() =>
      supabase
        .from('rna_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .eq('file_id', fileId)
        .order('id', { ascending: true })
    )
  } catch (policiesError: any) {
    console.error('[Deal Tracker] Error fetching RNA policies:', policiesError)
    throw new Error(`Failed to fetch policies: ${policiesError?.message}`)
  }

  if (!policies || policies.length === 0) {
    console.warn('[Deal Tracker] No RNA policies found for file_id:', fileId)
    return []
  }

  const policyNumbers = policies.map(p => p.policy_number as string)
  const policyNumbersForExisting = Array.from(
    new Set([
      ...policyNumbers,
      ...policyNumbers.map(normalizeRnaPolicyKey).filter(n => n.length > 0),
    ])
  )

  let commissions: any[] = []
  try {
    commissions = await fetchAllPaginated(() =>
      supabase
        .from('rna_commissions')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('issue_date', { ascending: true })
    )
  } catch (commissionsError: any) {
    console.warn('[Deal Tracker] Failed to fetch RNA commissions:', (commissionsError as Error)?.message)
  }

  const commissionMap = new Map<string, any>()
  commissions.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return
    const existing = commissionMap.get(policyNum)
    const currDateStr = (comm.issue_date || comm.paid_to_date) as string | undefined
    const existingDateStr = existing ? (existing.issue_date || existing.paid_to_date) as string | undefined : undefined
    const currDate = currDateStr ? new Date(currDateStr) : null
    const existingDate = existingDateStr ? new Date(existingDateStr) : null
    if (!existing || (currDate && (!existingDate || currDate > existingDate))) {
      commissionMap.set(policyNum, comm)
    }
  })

  let existingEntries: any[] = []
  try {
    existingEntries = await fetchAllPaginated(() =>
      supabase
        .from('deal_tracker')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbersForExisting)
        .order('id', { ascending: true })
    )
  } catch (existingError: any) {
    console.warn('[Deal Tracker] Failed to fetch existing RNA deal_tracker entries:', (existingError as Error)?.message)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      const key = normalizeRnaPolicyKey(entry.policy_number)
      if (key) {
        existingMap.set(key, entry)
      }
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  // Only fetch DDF when we need something from it: call_center/phone, or deal date, or effective date (when empty).
  const policiesNeedingDdf = policies.filter(p => {
    const ex = existingMap.get(normalizeRnaPolicyKey(p.policy_number))
    const comm = commissionMap.get(p.policy_number)
    const needsContact = !ex || (ex.call_center == null && ex.phone_number == null)
    // Deal date on policy is application_entry_date; DDF only if still empty after existing + policy.
    const dealFromSource =
      ex?.deal_creation_date ||
      p.application_entry_date ||
      comm?.issue_date ||
      p.certificate_activation_date
    const effectiveFromSource = (p.certificate_activation_date as string | undefined) || (comm?.effective_date as string | undefined) || (comm?.issue_date as string | undefined) || ex?.effective_date
    const needsDealDate = !dealFromSource || String(dealFromSource).trim() === ''
    const needsEffectiveDate = !effectiveFromSource || String(effectiveFromSource).trim() === ''
    return needsContact || needsDealDate || needsEffectiveDate
  })
  const uniqueInsuredNames = Array.from(
    new Set(
      policiesNeedingDdf
        .map(p => buildRnaInsuredName(p))
        .filter(n => n.length > 0)
    )
  )

  const dailyDealFlowMap =
    uniqueInsuredNames.length > 0
      ? await bulkFetchDailyDealFlowInfo(uniqueInsuredNames, ddfCarrier)
      : new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }>()

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const policy of policies) {
    const normPolicyNumber = normalizeRnaPolicyKey(policy.policy_number)
    const commission = commissionMap.get(policy.policy_number)
    const existing = existingMap.get(normPolicyNumber)
    const insuredName = buildRnaInsuredName(policy)
    // Use current_contract_status_reason for policy_status (and GHL) mapping instead of current_contract_status
    const originalStatus = policy.current_contract_status_reason || null
    const carrierUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!carrierUnchanged,
      existing?.policy_status
    )
    const normalizedName = normalizeNameForSearch(insuredName)
    const ddfInfo = insuredName ? dailyDealFlowMap.get(normalizedName) || null : null
    let callCenter: string | null = existing?.call_center ?? null
    let phoneNumber: string | null = existing?.phone_number ?? null
    if (callCenter == null && phoneNumber == null && ddfInfo) {
      callCenter = ddfInfo.call_center ?? null
      phoneNumber = ddfInfo.phone_number ?? null
    }
    const effectiveDateFromDdf = ddfInfo?.draft_date ?? null

    const advance = commission?.advance_amount != null ? (typeof commission.advance_amount === 'string' ? parseFloat(commission.advance_amount) : commission.advance_amount) : 0
    const earned = commission?.earned_amount != null ? (typeof commission.earned_amount === 'string' ? parseFloat(commission.earned_amount) : commission.earned_amount) : 0
    const rawDealValue = commission ? (Number.isNaN(advance) ? 0 : advance) + (Number.isNaN(earned) ? 0 : earned) : null
    let dealValue: number | null = null
    if (rawDealValue != null && rawDealValue !== 0) {
      dealValue = rawDealValue
    } else if (existing && existing.deal_value != null) {
      dealValue = typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value
    }
    const ccValue = dealValue != null ? dealValue / 2 : null

    // Deal date: keep deal_tracker value if set; else RNA policy application_entry_date, then fallbacks.
    const dealCreationDate = mergeEffectiveDate(
      existing?.deal_creation_date,
      null,
      policy.application_entry_date,
      commission?.issue_date,
      policy.certificate_activation_date,
    )

    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.effective_date,
      effectiveDateFromDdf,
      policy.certificate_activation_date,
      commission?.effective_date,
      commission?.issue_date,
    )

    // Re-resolve GHL stage even when raw carrier status is unchanged so that
    // time-based transitions (draft/effective date) still trigger.
    // Manual stages are protected inside resolveGhlStage().
    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate,
      dealValue,
      commissionType: commission?.activity_type ?? null,
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
      policy_number: normPolicyNumber || policy.policy_number,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: (commission?.comments != null && String(commission.comments).trim() !== '') ? commission.comments : (existing?.notes ?? null),
      status: (existing && financialsUnchanged(existing, dealValue, null)) ? (existing.status ?? statusFromDealValue(dealValue)) : statusFromDealValue(dealValue),
      last_updated: new Date().toISOString(),
      sales_agent: commission?.agent_name ?? policy.agent_name ?? null,
      writing_number: commission?.agent_id ?? policy.agent_id ?? null,
      commission_type: commission?.activity_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status: originalStatus,
      policy_type: policy.product_id ?? commission?.product_id ?? null,
      daily_deal_flow_fetched: !!(callCenter || phoneNumber),
      daily_deal_flow_fetched_at: (callCenter || phoneNumber) ? new Date().toISOString() : (existing?.daily_deal_flow_fetched_at ?? null),
      source_policy_table: 'rna_policies',
      source_policy_id: policy.id,
      source_commission_table: commission ? 'rna_commissions' : null,
      source_commission_id: commission?.id ?? null,
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

  console.log('[Deal Tracker] RNA policy processing complete. Total entries:', previewEntries.length)
  return previewEntries
}

/**
 * Process RNA commission files and update deal tracker entries.
 * Commission-driven flow: one entry per policy with commissions; join to rna_policies when available.
 */
export async function processRNACommissionsForDealTracker(
  agencyCarrierId: string,
  fileId: string
): Promise<DealTrackerPreviewEntry[]> {
  console.log('[Deal Tracker] processRNACommissionsForDealTracker called', {
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
    console.error('[Deal Tracker] Failed to fetch agency_carrier (RNA commissions):', acError)
    throw new Error(`Failed to fetch agency_carrier: ${acError?.message}`)
  }

  const carrier = agencyCarrier.carriers as any
  const carrierName = carrier.name || 'RNA'
  const carrierCode = carrier.code || 'RNA'
  const ddfCarrier = carrierCode || carrierName
  const carrierId = carrier.id

  const { data: commissions, error: commissionsError } = await supabase
    .from('rna_commissions')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .eq('file_id', fileId)

  if (commissionsError) {
    console.error('[Deal Tracker] Error fetching RNA commissions:', commissionsError)
    throw new Error(`Failed to fetch commissions: ${commissionsError.message}`)
  }

  if (!commissions || commissions.length === 0) {
    console.warn('[Deal Tracker] No RNA commissions found for file_id:', fileId)
    return []
  }

  const policyNumbers = Array.from(new Set(commissions.map((c: any) => c.policy_number).filter(Boolean))) as string[]
  const policyNumbersForExisting = Array.from(
    new Set([
      ...policyNumbers,
      ...policyNumbers.map(normalizeRnaPolicyKey).filter(n => n.length > 0),
    ])
  )

  const { data: existingEntries, error: existingError } = await supabase
    .from('deal_tracker')
    .select('*')
    .eq('agency_carrier_id', agencyCarrierId)
    .in('policy_number', policyNumbersForExisting)

  if (existingError) {
    console.warn('[Deal Tracker] Failed to fetch existing RNA deal_tracker entries (commissions):', existingError)
  }

  const existingMap = new Map<string, any>()
  if (existingEntries) {
    existingEntries.forEach((entry: any) => {
      const key = normalizeRnaPolicyKey(entry.policy_number)
      if (key) {
        existingMap.set(key, entry)
      }
    })
  }

  let policiesMap = new Map<string, any>()
  if (policyNumbers.length > 0) {
    const policies = await fetchAllPaginated(() =>
      supabase
        .from('rna_policies')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .in('policy_number', policyNumbers)
        .order('id', { ascending: true })
    )
    policies.forEach((p: any) => {
      policiesMap.set(p.policy_number, p)
    })
  }

  const statusMappingMap = await bulkFetchStatusMappings(carrierId, carrierCode)
  const ghlStageMappingMap = await bulkFetchGhlStageMappings(carrierId, carrierCode)

  const commissionMap = new Map<string, any>()
  const commissionAmountsMap = new Map<string, number>()
  commissions.forEach((comm: any) => {
    const policyNum = comm.policy_number
    if (!policyNum) return

    const advance = comm.advance_amount != null ? (typeof comm.advance_amount === 'string' ? parseFloat(comm.advance_amount) : comm.advance_amount) : 0
    const earned = comm.earned_amount != null ? (typeof comm.earned_amount === 'string' ? parseFloat(comm.earned_amount) : comm.earned_amount) : 0
    const amount = (Number.isNaN(advance) ? 0 : advance) + (Number.isNaN(earned) ? 0 : earned)

    const current = commissionAmountsMap.get(policyNum) || 0
    commissionAmountsMap.set(policyNum, current + amount)

    const existing = commissionMap.get(policyNum)
    const currDateStr = (comm.issue_date || comm.paid_to_date) as string | undefined
    const existingDateStr = existing ? (existing.issue_date || existing.paid_to_date) as string | undefined : undefined
    const currDate = currDateStr ? new Date(currDateStr) : null
    const existingDate = existingDateStr ? new Date(existingDateStr) : null
    if (!existing || (currDate && (!existingDate || currDate > existingDate))) {
      commissionMap.set(policyNum, comm)
    }
  })

  // Only fetch DDF when we need something: call_center/phone or deal date or effective date (when empty).
  const allPolicyNumbersNeedingDDF = Array.from(commissionMap.keys()).filter(pn => {
    const existing = existingMap.get(normalizeRnaPolicyKey(pn))
    const policy = policiesMap.get(pn)
    const comm = commissionMap.get(pn)
    const needsContact = !existing || (existing.call_center == null && existing.phone_number == null)
    const dealFromSource =
      existing?.deal_creation_date ||
      policy?.application_entry_date ||
      comm?.issue_date ||
      policy?.certificate_activation_date
    const effectiveFromSource = (policy?.certificate_activation_date as string | undefined) || (comm?.effective_date as string | undefined) || (comm?.issue_date as string | undefined) || existing?.effective_date
    const needsDealDate = !dealFromSource || String(dealFromSource).trim() === ''
    const needsEffectiveDate = !effectiveFromSource || String(effectiveFromSource).trim() === ''
    return needsContact || needsDealDate || needsEffectiveDate
  })

  let dailyDealFlowMap = new Map<string, { call_center: string | null; phone_number: string | null; draft_date: string | null }>()
  if (allPolicyNumbersNeedingDDF.length > 0) {
    const policyNamesForDDF = allPolicyNumbersNeedingDDF
      .map(pn => {
        const policy = policiesMap.get(pn)
        if (!policy) return ''
        return buildRnaInsuredName(policy)
      })
      .filter((n: string) => n.length > 0)

    if (policyNamesForDDF.length > 0) {
        dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(policyNamesForDDF, ddfCarrier)
    } else {
      const namesFromComm = allPolicyNumbersNeedingDDF
        .map(pn => {
          const comm = commissionMap.get(pn)
          return (comm?.insured_name ?? '').trim()
        })
        .filter((n: string) => n.length > 0)
      if (namesFromComm.length > 0) {
        dailyDealFlowMap = await bulkFetchDailyDealFlowInfo(namesFromComm, ddfCarrier)
      }
    }
  }

  const previewEntries: DealTrackerPreviewEntry[] = []

  for (const [policyNumber, comm] of commissionMap.entries()) {
    const normPolicyNumber = normalizeRnaPolicyKey(policyNumber)
    const existing = existingMap.get(normPolicyNumber)
    const policy = policiesMap.get(policyNumber)

    const insuredName = policy ? buildRnaInsuredName(policy) : (comm.insured_name ?? null)
    const originalStatus =
      policy?.current_contract_status_reason ??
      policy?.current_contract_status ??
      existing?.carrier_status ??
      existing?.policy_status ??
      null
    const carrierUnchanged = existing && carrierStatusUnchanged(existing, originalStatus)
    const policyStatusResolved = resolvePolicyStatusFromCarrierMapping(
      statusMappingMap,
      originalStatus,
      !!carrierUnchanged,
      existing?.policy_status
    )

    const totalAmount = commissionAmountsMap.get(policyNumber)
    let dealValue: number | null = null
    if (totalAmount != null && totalAmount !== 0) {
      dealValue = totalAmount
    } else if (existing && existing.deal_value != null) {
      // 0 or null totalAmount behaves like \"no commission\" – keep existing deal_value.
      dealValue = typeof existing.deal_value === 'string' ? parseFloat(existing.deal_value) : existing.deal_value
    }
    let ccValue: number | null = null
    if (dealValue != null) {
      if (totalAmount != null && totalAmount !== 0) {
        ccValue = dealValue / 2
      } else if (existing && existing.cc_value != null) {
        ccValue = typeof existing.cc_value === 'string' ? parseFloat(existing.cc_value) : existing.cc_value
      } else {
        ccValue = dealValue / 2
      }
    }

    let callCenter = existing?.call_center ?? null
    let phoneNumber = existing?.phone_number ?? null
    let dailyDealFlowFetched = existing?.daily_deal_flow_fetched ?? false
    let dailyDealFlowFetchedAt = existing?.daily_deal_flow_fetched_at ?? null

    if (!callCenter && !phoneNumber) {
      const nameForDdf = policy ? buildRnaInsuredName(policy) : (comm.insured_name ?? '').trim()
      if (nameForDdf) {
        const normalizedName = normalizeNameForSearch(nameForDdf)
        const ddfInfo = dailyDealFlowMap.get(normalizedName)
        if (ddfInfo) {
          callCenter = ddfInfo.call_center ?? null
          phoneNumber = ddfInfo.phone_number ?? null
          dailyDealFlowFetched = !!(callCenter || phoneNumber)
          dailyDealFlowFetchedAt = (callCenter || phoneNumber) ? new Date().toISOString() : null
        }
      }
    }

    const ddfDraftDate =
      insuredName ? (dailyDealFlowMap.get(normalizeNameForSearch(insuredName))?.draft_date ?? null) : null

    // Deal date: keep deal_tracker if set; else policy application_entry_date, then fallbacks (not DDF draft).
    const dealCreationDate = mergeEffectiveDate(
      existing?.deal_creation_date,
      null,
      policy?.application_entry_date,
      comm.issue_date,
      policy?.certificate_activation_date,
    )
    const effectiveDate = mergeEffectiveDateWithPendingRoll(
      originalStatus,
      existing?.effective_date,
      ddfDraftDate,
      policy?.certificate_activation_date,
      comm.effective_date,
      comm.issue_date,
    )

    const statusForEntry =
      existing && financialsUnchanged(existing, dealValue, null)
        ? (existing.status ?? statusFromDealValue(dealValue))
        : statusFromDealValue(dealValue)

    const mappedGhlStage = resolveGhlStage({
      carrierStatus: originalStatus,
      allMappings: ghlStageMappingMap,
      effectiveDate,
      effectiveDateForThreeMonthRule: effectiveDateForThreeMonthRuleFromPreview(existing, effectiveDate),
      dealCreationDate,
      dealValue,
      commissionType: comm.activity_type ?? null,
      existingGhlStage: existing?.ghl_stage ?? null,
      carrierCode,
    })

    const entry: DealTrackerPreviewEntry = {
      agency_carrier_id: agencyCarrierId,
      name: insuredName || null,
      tasks: null,
      ghl_name: existing?.ghl_name ?? null,
      ghl_stage: mappedGhlStage ?? existing?.ghl_stage ?? null,
      policy_status: policyStatusResolved,
      deal_creation_date: dealCreationDate,
      policy_number: normPolicyNumber || policyNumber,
      carrier: carrierName,
      carrier_id: carrier.id,
      deal_value: dealValue,
      cc_value: ccValue,
      notes: (comm.comments != null && String(comm.comments).trim() !== '') ? comm.comments : (existing?.notes ?? null),
      status: statusForEntry,
      last_updated: new Date().toISOString(),
      sales_agent: existing?.sales_agent ?? policy?.agent_name ?? comm.agent_name ?? null,
      writing_number: existing?.writing_number ?? policy?.agent_id ?? comm.agent_id ?? null,
      commission_type: comm.activity_type ?? null,
      effective_date: effectiveDate,
      call_center: callCenter,
      phone_number: phoneNumber,
      cc_pmt_ws: null,
      cc_cb_ws: null,
      carrier_status:
        policy?.current_contract_status_reason ??
        policy?.current_contract_status ??
        existing?.carrier_status ??
        originalStatus,
      policy_type: policy?.product_id ?? comm.product_id ?? null,
      daily_deal_flow_fetched: dailyDealFlowFetched,
      daily_deal_flow_fetched_at: dailyDealFlowFetchedAt,
      source_policy_table: policy ? 'rna_policies' : null,
      source_policy_id: policy?.id ?? null,
      source_commission_table: 'rna_commissions',
      source_commission_id: comm.id,
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

  console.log('[Deal Tracker] RNA commissions processing complete. Total entries:', previewEntries.length)
  return previewEntries
}
