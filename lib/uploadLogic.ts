/**
 * Shared upload logic: build rows, resolve tables, and perform the full upload pipeline.
 * Used by the tree-based upload page (and optionally the old upload page).
 */
import { supabase } from './supabaseClient'
import { parseFile } from './fileParser'

export type FileKind = 'Policy' | 'Commission'

export type ParsedRecord = {
  policyNumber: string
  data: Record<string, any>
}

export function parseNumber(value: any): number | null {
  if (value === null || value === undefined) return null
  const s = String(value).replace(/[^0-9.\-]/g, '').trim()
  if (!s) return null
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

/** Normalize policy number so same policy from different files/days matches for upsert (no date/time used). */
function normalizePolicyNumber(value: any): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

export function buildAmamPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(r.policyNumber),
      writingagent: d['WritingAgent'] ?? null,
      agentname_raw: d['AgentName'] ?? null,
      company: d['Company'] ?? null,
      status_raw: d['Status'] ?? null,
      dob_raw: d['DOB'] ?? null,
      policydate_raw: d['PolicyDate'] ?? null,
      paidtodate_raw: d['PaidtoDate'] ?? null,
      recvdate_raw: d['RecvDate'] ?? null,
      lastname: d['LastName'] ?? null,
      firstname: d['FirstName'] ?? null,
      mi: d['MI'] ?? null,
      plan: d['Plan'] ?? null,
      face_raw: d['Face'] ?? null,
      form: d['Form'] ?? null,
      mode_raw: d['Mode'] ?? null,
      modeprem_raw: d['ModePrem'] ?? null,
      address1: d['Address1'] ?? null,
      address2: d['Address2'] ?? null,
      address3: d['Address3'] ?? null,
      address4: d['Address4'] ?? null,
      state_raw: d['State'] ?? null,
      zip_raw: d['Zip'] ?? null,
      phone_raw: d['Phone'] ?? null,
      email_raw: d['Email'] ?? null,
      app_date_raw: d['App Date'] ?? null,
      wrtpct_raw: d['WrtPct'] ?? null,
      carrier_name: 'AMAM',
      source_file: fileName,
      source_format: 'AMAM_POLICY',
    }
  })
}

export function buildAmamCommissionRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      statement_date: d['RptDate'] ? d['RptDate'] : null,
      policy_number: normalizePolicyNumber(d['Policy'] ?? r.policyNumber),
      writingagent: d['WritingAgent'] ?? null,
      insured_name: d['Insured'] ?? null,
      plan: d['Plan'] ?? null,
      issdate: d['IssDate'] ?? null,
      sex: d['Sex'] ?? null,
      age: d['Age'] != null ? Number(d['Age']) : null,
      anz_prem: parseNumber(d['Anz Prem']),
      pfee_prem: parseNumber(d['PFee Prem']),
      pln: d['Pln'] ?? null,
      adv_rate: parseNumber(d['Adv Rate']),
      com_rate: parseNumber(d['Com Rate']),
      adj_rate: parseNumber(d['Adj Rate']),
      advance: parseNumber(d['Advance']),
      adv_pfee: parseNumber(d['Adv PFee']),
      adv_bal: parseNumber(d['Adv Bal']),
      action: d['Action'] ?? null,
      freq: d['Freq'] ?? null,
      source_file: fileName,
      source_format: 'AMAM_COMMISSION',
    }
  })
}

export function buildAetnaPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(d['POLICYNUMBER'] || r.policyNumber),
      companycode: d['COMPANYCODE'] ?? null,
      statuscategory: d['STATUSCATEGORY'] ?? null,
      statusdisplaytext: d['STATUSDISPLAYTEXT'] ?? null,
      product: d['PRODUCT'] ?? null,
      app_type: d['APP TYPE'] ?? null,
      apprecddate: d['APPRECDDATE'] ?? null,
      appsignaturedate: d['APPSIGNATUREDATE'] ?? null,
      origeffdate: d['ORIGEFFDATE'] ?? null,
      paidtodate: d['PAIDTODATE'] ?? null,
      issuedate: d['ISSUEDATE'] ?? null,
      termdate: d['TERMDATE'] ?? null,
      issuedpremium: parseNumber(d['ISSUEDPREMIUM']),
      currentannualpremium: parseNumber(d['CURRENTANNUALPREMIUM']),
      currentmodalpremium: parseNumber(d['CURRENTMODALPREMIUM']),
      draftday: d['DRAFTDAY'] ?? null,
      paymentmodedisplaytext: d['PAYMENTMODEDISPLAYTEXT'] ?? null,
      paymentmethoddisplaytext: d['PAYMENTMETHODDISPLAYTEXT'] ?? null,
      lastpaymentdate: d['LASTPAYMENTDATE'] ?? null,
      lastpayamt: parseNumber(d['LASTPAYAMT']),
      issuezip: d['ISSUEZIP'] ?? null,
      replacementind: d['REPLACEMENTIND'] ?? null,
      replcompanycode: d['REPLCOMPANYCODE'] ?? null,
      replpolicynumber: d['REPLPOLICYNUMBER'] ?? null,
      facevalue: parseNumber(d['FACEVALUE']),
      issuestate: d['ISSUESTATE'] ?? null,
      household_discount_pct: parseNumber(d['HOUSEHOLD DISCOUNT %']),
      multiple_policy_discount_pct: parseNumber(d['MULTIPLE POLICY DISCOUNT %']),
      longdescription: d['LONGDESCRIPTION'] ?? null,
      insuredname: d['INSUREDNAME'] ?? null,
      suffixtitle: d['SUFFIXTITLE'] ?? null,
      sex: d['SEX'] ?? null,
      birthdate: d['BIRTHDATE'] ?? null,
      addressline1: d['ADDRESSLINE1'] ?? null,
      addressline2: d['ADDRESSLINE2'] ?? null,
      addressline3: d['ADDRESSLINE3'] ?? null,
      city: d['CITY'] ?? null,
      state: d['STATE'] ?? null,
      postalcode: d['POSTALCODE'] ?? null,
      phone1: d['PHONE1'] ?? null,
      email: d['EMAIL'] ?? null,
      issueage: d['ISSUEAGE'] != null ? Number(d['ISSUEAGE']) : null,
      agentnumber: d['AGENTNUMBER'] ?? null,
      agentcompletename: d['AGENTCOMPLETENAME'] ?? null,
      splitlevel: d['SPLITLEVEL'] ?? null,
      split_pct: d['SPLIT %'] ?? null,
      original_status: d['STATUSDISPLAYTEXT'] ?? d['STATUSCATEGORY'] ?? null,
      status_normalized: null,
      source_file: fileName,
      source_format: 'AETNA_POLICY',
    }
  })
}

export function buildAetnaCommissionRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      company: d['COMPANY'] ?? null,
      commissiontype: d['COMMISSIONTYPE'] ?? null,
      writingagentnumber: d['WRITINGAGENTNUMBER'] ?? null,
      writingagentname: d['WRITINGAGENTNAME'] ?? null,
      client: d['CLIENT'] ?? null,
      policy_number: normalizePolicyNumber(d['POLICYNUMBER'] ?? r.policyNumber),
      commissioncategory: d['COMMISSIONCATEGORY'] ?? null,
      appdate: d['APPDATE'] ?? null,
      state: d['STATE'] ?? null,
      product: d['PRODUCT'] ?? null,
      effectivedate: d['EFFECTIVEDATE'] ?? null,
      premiumduedate: d['PREMIUMDUEDATE'] ?? null,
      commissionablepremium: parseNumber(d['COMMISSIONABLEPREMIUM']),
      split_pct: d['SPLIT%'] ?? null,
      rate_pct: d['RATE%'] ?? null,
      monthsadvanced: d['MONTHSADVANCED'] ?? null,
      commissionamount: parseNumber(d['COMMISSIONAMOUNT']),
      mode: d['MODE'] ?? null,
      replpoleffdate: d['REPLPOLEFFDATE'] ?? null,
      commissionpaiddate: d['COMMISSIONPAIDDATE'] ?? null,
      longdescription: d['LONGDESCRIPTION'] ?? null,
      statement_date: null,
      transaction_type: null,
      source_file: fileName,
      source_format: 'AETNA_COMMISSION',
    }
  })
}

export function buildTransamericaPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(d['Policy Number'] ?? r.policyNumber),
      status: d['Status'] ?? null,
      owner_name: d['Owner Name'] ?? null,
      product_type: d['Product Type'] ?? null,
      issue_state: d['Issue State'] ?? null,
      face_amount: parseNumber(d['Face Amount']),
      premium: parseNumber(d['Premium']),
      premium_due_date: d['Premium Due Date'] != null ? String(d['Premium Due Date']) : null,
      expiry_date: d['Expiry Date'] != null ? String(d['Expiry Date']) : null,
      billing_mode: d['Billing Mode'] ?? null,
      issue_date: d['Issue Date'] != null ? String(d['Issue Date']) : null,
      insured_name: d['Insured Name'] ?? null,
      product_class: d['Product Class'] ?? null,
      product_code: d['Product Code'] ?? null,
      owner_address_line_1: d['Owner Address Line 1'] ?? null,
      owner_address_line_2: d['Owner Address Line 2'] ?? null,
      owner_city: d['Owner City'] ?? null,
      owner_state_code: d['Owner State Code'] ?? null,
      owner_zip_code: d['Owner Zip Code'] ?? null,
      source_file: fileName,
      source_format: 'TRANSAMERICA_POLICY',
    }
  })
}

type TargetTable = 'aetna_policies' | 'aetna_commissions' | 'amam_policies' | 'amam_commissions' | 'transamerica_policies' | 'transamerica_commissions'

export function resolveTargetTable(carrierCode: string, fileType: FileKind): TargetTable {
  if (carrierCode === 'AETNA' && fileType === 'Policy') return 'aetna_policies'
  if (carrierCode === 'AETNA' && fileType === 'Commission') return 'aetna_commissions'
  if (carrierCode === 'AMAM' && fileType === 'Policy') return 'amam_policies'
  if (carrierCode === 'AMAM' && fileType === 'Commission') return 'amam_commissions'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'transamerica_policies'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'transamerica_commissions'
  throw new Error(`Unsupported carrier/file type combination: ${carrierCode} / ${fileType}`)
}

export function resolveSourceFormat(carrierCode: string, fileType: FileKind): string | null {
  if (carrierCode === 'AETNA' && fileType === 'Policy') return 'AETNA_POLICY'
  if (carrierCode === 'AETNA' && fileType === 'Commission') return 'AETNA_COMMISSION'
  if (carrierCode === 'AMAM' && fileType === 'Policy') return 'AMAM_POLICY'
  if (carrierCode === 'AMAM' && fileType === 'Commission') return 'AMAM_COMMISSION'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'TRANSAMERICA_POLICY'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'TRANSAMERICA_COMMISSION'
  return null
}

export interface UploadParams {
  agencyCarrierId: string
  agencyName: string
  carrierName: string
  carrierCode: string
  file: File
  fileType: FileKind
}

export async function executeUpload(params: UploadParams): Promise<{ success: true; count: number } | { success: false; error: string }> {
  const { agencyCarrierId, agencyName, carrierName, carrierCode, file, fileType } = params

  if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') {
    return { success: false, error: 'Transamerica commission files are not yet supported. Upload policy files only.' }
  }

  const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
  const filePath = `${agencyName}/${carrierName}/${fileType}/${sanitizedFilename}`

  const { error: storageError } = await supabase.storage
    .from('uic-documents')
    .upload(filePath, file, { upsert: true })
  if (storageError) return { success: false, error: storageError.message }

  const sourceFormat = resolveSourceFormat(carrierCode, fileType)
  const { data: fileRow, error: fileError } = await supabase
    .from('files')
    .insert({
      agency_carrier_id: agencyCarrierId,
      file_type: fileType,
      original_filename: file.name,
      storage_path: filePath,
      source_format: sourceFormat,
    })
    .select()
    .single()

  if (fileError || !fileRow) return { success: false, error: fileError?.message || 'Failed to create file record' }

  const parseResult = await parseFile(file) as { records: ParsedRecord[]; totalRecords: number }
  if (!parseResult.records.length) return { success: false, error: 'No records found in the file.' }

  const targetTable = resolveTargetTable(carrierCode, fileType)
  let rows: any[] = []

  if (carrierCode === 'AMAM' && fileType === 'Policy') rows = buildAmamPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AMAM' && fileType === 'Commission') rows = buildAmamCommissionRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AETNA' && fileType === 'Policy') rows = buildAetnaPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AETNA' && fileType === 'Commission') rows = buildAetnaCommissionRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') rows = buildTransamericaPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)

  if (!rows.length) return { success: false, error: 'File parsed but no mappable records were found.' }

  const BATCH_SIZE = 500
  const isPolicyTable = targetTable === 'aetna_policies' || targetTable === 'amam_policies' || targetTable === 'transamerica_policies'
  const now = new Date().toISOString()

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    let chunk = rows.slice(i, i + BATCH_SIZE).map(row => ({ ...row, updated_at: now }))
    if (isPolicyTable) {
      // Upsert matches only on (agency_carrier_id, policy_number) — NOT on date/time. Same policy re-uploaded any day must update the existing row.
      // Never send id or created_at so we don't overwrite "first added" and conflict is on the unique (agency_carrier_id, policy_number).
      chunk.forEach(row => {
        delete (row as any).id
        delete (row as any).created_at
      })
    }
    const query = supabase.from(targetTable)
    const { error } = isPolicyTable
      ? await query.upsert(chunk, { onConflict: ['agency_carrier_id', 'policy_number'], ignoreDuplicates: false })
      : await query.insert(chunk)
    if (error) {
      console.error('Chunk write error:', error)
      return { success: false, error: error.message }
    }
  }

  await supabase
    .from('files')
    .update({ records_processed: parseResult.records.length, updated_at: new Date().toISOString() })
    .eq('id', fileRow.id)

  return { success: true, count: parseResult.records.length }
}
