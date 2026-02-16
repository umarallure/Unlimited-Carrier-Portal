/**
 * Shared upload logic: build rows, resolve tables, and perform the full upload pipeline.
 * Used by the tree-based upload page (and optionally the old upload page).
 */
import { supabase } from './supabaseClient'
import { parseFile, parseRNAExcel } from './fileParser'

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

export function buildMohPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(d['POLICY_NUMBER'] ?? r.policyNumber),
      
      // Basic policy info
      carrier_name: d['CARRIER_NAME'] ?? null,
      policy_effective_dte: d['POLICY_EFFECTIVE_DTE'] ?? null,
      policy_issue_dte: d['POLICY_ISSUE_DTE'] ?? null,
      policy_term_dte: d['POLICY_TERM_DTE'] ?? null,
      policy_status_nme: d['POLICY_STATUS_NME'] ?? null,
      
      // Insured info (primary)
      insured_nme: d['INSURED_NME'] ?? null,
      insured_age_at_issue: parseNumber(d['INSURED_AGE_AT_ISSUE']),
      insured_dob: d['INSURED_DOB'] ?? null,
      insured_gender: d['INSURED_GENDER'] ?? null,
      insured_address_line_1: d['INSURED_ADDRESS_LINE_1'] ?? null,
      insured_address_line_2: d['INSURED_ADDRESS_LINE_2'] ?? null,
      insured_city_name: d['INSURED_CITY_NAME'] ?? null,
      insured_state: d['INSURED_STATE'] ?? null,
      insured_zipcde: d['INSURED_ZIPCDE'] ?? null,
      insured_party_phone: d['INSURED_PARTY_PHONE'] ?? null,
      insured_email_address: d['INSURED_EMAIL_ADDRESS'] ?? null,
      
      // Owner info (primary)
      owner_nme: d['OWNER_NME'] ?? null,
      owner_dob: d['OWNER_DOB'] ?? null,
      owner_gender: d['OWNER_GENDER'] ?? null,
      
      // Insured info (secondary)
      insured2_nme: d['INSURED2_NME'] ?? null,
      insured2_age_at_issue: parseNumber(d['INSURED2_AGE_AT_ISSUE']),
      insured2_dob: d['INSURED2_DOB'] ?? null,
      insured2_gender: d['INSURED2_GENDER'] ?? null,
      insured2_party_phone: d['INSURED2_PARTY_PHONE'] ?? null,
      insured2_email_address: d['INSURED2_EMAIL_ADDRESS'] ?? null,
      
      // Owner info (secondary)
      owner2_nme: d['OWNER2_NME'] ?? null,
      owner2_dob: d['OWNER2_DOB'] ?? null,
      owner2_gender: d['OWNER2_GENDER'] ?? null,
      
      // Premium and billing
      bill_mode: d['BILL_MODE'] ?? null,
      premium: parseNumber(d['PREMIUM']),
      annual_premium: parseNumber(d['ANNUAL_PREMIUM']),
      paid_to_dte: d['PAID_TO_DTE'] ?? null,
      
      // Application info
      app_signed_dte: d['APP_SIGNED_DTE'] ?? null,
      app_submission_method_nme: d['APP_SUBMISSION_METHOD_NME'] ?? null,
      app_issue_state_cde: d['APP_ISSUE_STATE_CDE'] ?? null,
      application_received_dte: d['APPLICATION_RECEIVED_DTE'] ?? null,
      
      // Writing agent (primary)
      wrt_agt_nme: d['WRT_AGT_NME'] ?? null,
      wrt_agt_prod_num: d['WRT_AGT_PROD_NUM'] ?? null,
      wrt_agt_npn: d['WRT_AGT_NPN'] ?? null,
      wrt_agt_comm_split: d['WRT_AGT_COMM_SPLIT'] ?? null,
      wrt_agt_address_line_1: d['WRT_AGT_ADDRESS_LINE_1'] ?? null,
      wrt_agt_address_line_2: d['WRT_AGT_ADDRESS_LINE_2'] ?? null,
      wrt_agt_city_name: d['WRT_AGT_CITY_NAME'] ?? null,
      wrt_agt_state: d['WRT_AGT_STATE'] ?? null,
      wrt_agt_zip_code: d['WRT_AGT_ZIP_CODE'] ?? null,
      wrt_agt_phone_number: d['WRT_AGT_PHONE_NUMBER'] ?? null,
      wrt_agt_email_address: d['WRT_AGT_EMAIL_ADDRESS'] ?? null,
      
      // Writing agent (secondary)
      wrt_agt2_nme: d['WRT_AGT2_NME'] ?? null,
      wrt_agt2_prod_num: d['WRT_AGT2_PROD_NUM'] ?? null,
      wrt_agt2_npn: d['WRT_AGT2_NPN'] ?? null,
      wrt_agt2_comm_split: d['WRT_AGT2_COMM_SPLIT'] ?? null,
      wrt_agt2_address_line_1: d['WRT_AGT2_ADDRESS_LINE_1'] ?? null,
      wrt_agt2_address_line_2: d['WRT_AGT2_ADDRESS_LINE_2'] ?? null,
      wrt_agt2_city_name: d['WRT_AGT2_CITY_NAME'] ?? null,
      wrt_agt2_state: d['WRT_AGT2_STATE'] ?? null,
      wrt_agt2_zip_code: d['WRT_AGT2_ZIP_CODE'] ?? null,
      wrt_agt2_phone_number: d['WRT_AGT2_PHONE_NUMBER'] ?? null,
      wrt_agt2_email_address: d['WRT_AGT2_EMAIL_ADDRESS'] ?? null,
      
      // Product info
      line_of_business_nme: d['LINE_OF_BUSINESS_NME'] ?? null,
      product_type_nme: d['PRODUCT_TYPE_NME'] ?? null,
      product_desc: d['PRODUCT_DESC'] ?? null,
      
      // Policy values
      surrender_value_amt: parseNumber(d['SURRENDER_VALUE_AMT']),
      cash_accumulation_value: parseNumber(d['CASH_ACCUMULATION_VALUE']),
      face_amt: parseNumber(d['FACE_AMT']),
      flat_extra_amt: parseNumber(d['FLAT_EXTRA_AMT']),
      initial_interest_rate: parseNumber(d['INITIAL_INTEREST_RATE']),
      account_value: parseNumber(d['ACCOUNT_VALUE']),
      next_renewal_dte: d['NEXT_RENEWAL_DTE'] ?? null,
      
      // Underwriting and replacement
      underwriting_class: d['UNDERWRITING_CLASS'] ?? null,
      ssn_tin_num: d['SSN_TIN_NUM'] ?? null,
      replacement_policy_number: d['REPLACEMENT_POLICY_NUMBER'] ?? null,
      replaced_carrier_nme: d['REPLACED_CARRIER_NME'] ?? null,
      replacement_type: d['REPLACEMENT_TYPE'] ?? null,
      primary_insured_age_cur_num: parseNumber(d['PRIMARY_INSURED_AGE_CUR_NUM']),

      source_file: fileName,
      source_format: 'MOH_POLICY',
    }
  })
}

/** CoreBridge policy CSV: Writing/Servicing Agent, Agent Number, Agency Number, Policy Number, Product Name, Insured Name, Insured Birth, Owner Name, Face Amount, Premium, Billable Premium, Billing Frequency, Billing Method, Policy Status, Product Type, Premium Due Date, Date of Issue, Effective Date, Term Duration */
export function buildCorebridgePolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    const policyNum = d['Policy Number'] ?? d['Policy number'] ?? r.policyNumber
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(policyNum),

      writing_servicing_agent: d['Writing/Servicing Agent'] ?? null,
      agent_number: d['Agent Number'] ?? null,
      agency_number: d['Agency Number'] ?? null,
      product_name: d['Product Name'] ?? null,
      insured_name: d['Insured Name'] ?? null,
      insured_birth: d['Insured Birth'] != null ? String(d['Insured Birth']) : null,
      owner_name: d['Owner Name'] ?? null,
      face_amount: parseNumber(d['Face Amount']),
      premium: parseNumber(d['Premium']),
      billable_premium: parseNumber(d['Billable Premium']),
      billing_frequency: d['Billing Frequency'] ?? null,
      billing_method: d['Billing Method'] ?? null,
      policy_status: d['Policy Status'] ?? null,
      product_type: d['Product Type'] ?? null,
      premium_due_date: d['Premium Due Date'] != null ? String(d['Premium Due Date']) : null,
      date_of_issue: (d['Date of Issue  '] ?? d['Date of Issue'] ?? d['Date of Issue ']) != null ? String(d['Date of Issue  '] ?? d['Date of Issue'] ?? d['Date of Issue ']) : null,
      effective_date: d['Effective Date'] != null ? String(d['Effective Date']) : null,
      term_duration: d['Term Duration'] != null ? String(d['Term Duration']) : null,

      source_file: fileName,
      source_format: 'COREBRIDGE_POLICY',
    }
  })
}

/** Liberty policy CSV: Policy, Plan, Agent, Insured, Status, Submitted, Issued, Paid To, Premium */
export function buildLibertyPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(d['Policy'] ?? r.policyNumber),

      plan: d['Plan'] ?? null,
      agent: d['Agent'] ?? null,
      insured: d['Insured'] ?? null,
      status: d['Status'] ?? null,
      submitted: d['Submitted'] != null ? String(d['Submitted']) : null,
      issued: d['Issued'] != null ? String(d['Issued']) : null,
      paid_to: d['Paid To'] ?? null,
      premium: parseNumber(d['Premium']),

      source_file: fileName,
      source_format: 'LIBERTY_POLICY',
    }
  })
}

/** RNA policy Excel (Certificates By Agent): parser adds Agent_ID, Agent_Name; block headers: Insured Name, Owner Name, Certificate Number, Product ID, Current Contract Status, etc. */
export function buildRNAPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
  return records.map((r, idx) => {
    const d = r.data
    return {
      agency_carrier_id: agencyCarrierId,
      file_id: fileId,
      row_number: idx + 1,
      policy_number: normalizePolicyNumber(d['Certificate Number'] ?? r.policyNumber),

      agent_id: d['Agent_ID'] ?? null,
      agent_name: d['Agent_Name'] ?? null,
      insured_name: d['Insured Name'] ?? null,
      owner_name: d['Owner Name'] ?? null,
      product_id: d['Product ID'] ?? null,
      current_contract_status: d['Current Contract Status'] ?? null,
      current_contract_status_reason: d['Current Contract Status Reason'] ?? null,
      application_entry_date: d['Application Entry Date'] != null ? String(d['Application Entry Date']) : null,
      certificate_activation_date: d['Certificate Activation Date'] != null ? String(d['Certificate Activation Date']) : null,
      issue_age: d['Issue Age'] != null ? String(d['Issue Age']) : null,

      source_file: fileName,
      source_format: 'RNA_POLICY',
    }
  })
}

type TargetTable = 'aetna_policies' | 'aetna_commissions' | 'amam_policies' | 'amam_commissions' | 'transamerica_policies' | 'transamerica_commissions' | 'moh_policies' | 'moh_commissions' | 'corebridge_policies' | 'corebridge_commissions' | 'liberty_policies' | 'liberty_commissions' | 'rna_policies' | 'rna_commissions'

export function resolveTargetTable(carrierCode: string, fileType: FileKind): TargetTable {
  if (carrierCode === 'AETNA' && fileType === 'Policy') return 'aetna_policies'
  if (carrierCode === 'AETNA' && fileType === 'Commission') return 'aetna_commissions'
  if (carrierCode === 'AMAM' && fileType === 'Policy') return 'amam_policies'
  if (carrierCode === 'AMAM' && fileType === 'Commission') return 'amam_commissions'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'transamerica_policies'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'transamerica_commissions'
  if (carrierCode === 'MOH' && fileType === 'Policy') return 'moh_policies'
  if (carrierCode === 'MOH' && fileType === 'Commission') return 'moh_commissions'
  if (carrierCode === 'COREBRIDGE' && fileType === 'Policy') return 'corebridge_policies'
  if (carrierCode === 'COREBRIDGE' && fileType === 'Commission') return 'corebridge_commissions'
  if (carrierCode === 'LIBERTY' && fileType === 'Policy') return 'liberty_policies'
  if (carrierCode === 'LIBERTY' && fileType === 'Commission') return 'liberty_commissions'
  if (carrierCode === 'RNA' && fileType === 'Policy') return 'rna_policies'
  if (carrierCode === 'RNA' && fileType === 'Commission') return 'rna_commissions'
  throw new Error(`Unsupported carrier/file type combination: ${carrierCode} / ${fileType}`)
}

export function resolveSourceFormat(carrierCode: string, fileType: FileKind): string | null {
  if (carrierCode === 'AETNA' && fileType === 'Policy') return 'AETNA_POLICY'
  if (carrierCode === 'AETNA' && fileType === 'Commission') return 'AETNA_COMMISSION'
  if (carrierCode === 'AMAM' && fileType === 'Policy') return 'AMAM_POLICY'
  if (carrierCode === 'AMAM' && fileType === 'Commission') return 'AMAM_COMMISSION'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'TRANSAMERICA_POLICY'
  if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'TRANSAMERICA_COMMISSION'
  if (carrierCode === 'MOH' && fileType === 'Policy') return 'MOH_POLICY'
  if (carrierCode === 'MOH' && fileType === 'Commission') return 'MOH_COMMISSION'
  if (carrierCode === 'COREBRIDGE' && fileType === 'Policy') return 'COREBRIDGE_POLICY'
  if (carrierCode === 'COREBRIDGE' && fileType === 'Commission') return 'COREBRIDGE_COMMISSION'
  if (carrierCode === 'LIBERTY' && fileType === 'Policy') return 'LIBERTY_POLICY'
  if (carrierCode === 'LIBERTY' && fileType === 'Commission') return 'LIBERTY_COMMISSION'
  if (carrierCode === 'RNA' && fileType === 'Policy') return 'RNA_POLICY'
  if (carrierCode === 'RNA' && fileType === 'Commission') return 'RNA_COMMISSION'
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

  const fileNameLower = file.name.toLowerCase()
  const isRNAPolicyExcel = carrierCode === 'RNA' && fileType === 'Policy' && (fileNameLower.endsWith('.xlsx') || fileNameLower.endsWith('.xls'))
  const parseResult = isRNAPolicyExcel
    ? (await parseRNAExcel(file) as { records: ParsedRecord[]; totalRecords: number })
    : (await parseFile(file) as { records: ParsedRecord[]; totalRecords: number })
  if (!parseResult.records.length) return { success: false, error: 'No records found in the file.' }

  const targetTable = resolveTargetTable(carrierCode, fileType)
  let rows: any[] = []

  if (carrierCode === 'AMAM' && fileType === 'Policy') rows = buildAmamPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AMAM' && fileType === 'Commission') rows = buildAmamCommissionRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AETNA' && fileType === 'Policy') rows = buildAetnaPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'AETNA' && fileType === 'Commission') rows = buildAetnaCommissionRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') rows = buildTransamericaPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'MOH' && fileType === 'Policy') rows = buildMohPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'COREBRIDGE' && fileType === 'Policy') rows = buildCorebridgePolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'LIBERTY' && fileType === 'Policy') rows = buildLibertyPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)
  else if (carrierCode === 'RNA' && fileType === 'Policy') rows = buildRNAPolicyRows(parseResult.records, agencyCarrierId, fileRow.id, file.name)

  if (!rows.length) return { success: false, error: 'File parsed but no mappable records were found.' }

  const BATCH_SIZE = 500
  const isPolicyTable = targetTable === 'aetna_policies' || targetTable === 'amam_policies' || targetTable === 'transamerica_policies' || targetTable === 'moh_policies' || targetTable === 'corebridge_policies' || targetTable === 'liberty_policies' || targetTable === 'rna_policies'
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
      ? await query.upsert(chunk, { onConflict: 'agency_carrier_id,policy_number', ignoreDuplicates: false })
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
