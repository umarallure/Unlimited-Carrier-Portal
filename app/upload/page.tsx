
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { parseFile } from '@/lib/fileParser'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Upload, CheckCircle, AlertCircle, Loader2, CloudUpload, FileUp } from 'lucide-react'

type FileKind = 'Policy' | 'Commission'

type ParsedRecord = {
    policyNumber: string
    data: Record<string, any>
}

function parseNumber(value: any): number | null {
    if (value === null || value === undefined) return null
    const s = String(value).replace(/[^0-9.\-]/g, '').trim()
    if (!s) return null
    const n = Number(s)
    return Number.isNaN(n) ? null : n
}

function buildAmamPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
    return records.map((r, idx) => {
        const d = r.data
        return {
            agency_carrier_id: agencyCarrierId,
            file_id: fileId,
            row_number: idx + 1,
            policy_number: String(r.policyNumber || '').trim(),

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

function buildAmamCommissionRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
    return records.map((r, idx) => {
        const d = r.data
        return {
            agency_carrier_id: agencyCarrierId,
            file_id: fileId,
            row_number: idx + 1,
            statement_date: d['RptDate'] ? d['RptDate'] : null,
            policy_number: String(d['Policy'] ?? r.policyNumber ?? '').trim(),

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

function buildAetnaPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
    return records.map((r, idx) => {
        const d = r.data
        return {
            agency_carrier_id: agencyCarrierId,
            file_id: fileId,
            row_number: idx + 1,
            policy_number: String(d['POLICYNUMBER'] || r.policyNumber || '').trim(),

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

function buildAetnaCommissionRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
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
            policy_number: String(d['POLICYNUMBER'] ?? r.policyNumber ?? '').trim(),
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

function buildTransamericaPolicyRows(records: ParsedRecord[], agencyCarrierId: string, fileId: string, fileName: string) {
    return records.map((r, idx) => {
        const d = r.data
        return {
            agency_carrier_id: agencyCarrierId,
            file_id: fileId,
            row_number: idx + 1,
            policy_number: String(d['Policy Number'] ?? r.policyNumber ?? '').trim(),

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

function resolveTargetTable(carrierCode: string, fileType: FileKind): 'aetna_policies' | 'aetna_commissions' | 'amam_policies' | 'amam_commissions' | 'transamerica_policies' | 'transamerica_commissions' {
    if (carrierCode === 'AETNA' && fileType === 'Policy') return 'aetna_policies'
    if (carrierCode === 'AETNA' && fileType === 'Commission') return 'aetna_commissions'
    if (carrierCode === 'AMAM' && fileType === 'Policy') return 'amam_policies'
    if (carrierCode === 'AMAM' && fileType === 'Commission') return 'amam_commissions'
    if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'transamerica_policies'
    if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'transamerica_commissions'
    throw new Error(`Unsupported carrier/file type combination: ${carrierCode} / ${fileType}`)
}

function resolveSourceFormat(carrierCode: string, fileType: FileKind): string | null {
    if (carrierCode === 'AETNA' && fileType === 'Policy') return 'AETNA_POLICY'
    if (carrierCode === 'AETNA' && fileType === 'Commission') return 'AETNA_COMMISSION'
    if (carrierCode === 'AMAM' && fileType === 'Policy') return 'AMAM_POLICY'
    if (carrierCode === 'AMAM' && fileType === 'Commission') return 'AMAM_COMMISSION'
    if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') return 'TRANSAMERICA_POLICY'
    if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') return 'TRANSAMERICA_COMMISSION'
    return null
}

export default function UploadPage() {
    const [agencies, setAgencies] = useState<any[]>([])
    const [carriers, setCarriers] = useState<any[]>([])
    const [selectedAgencyId, setSelectedAgencyId] = useState('')
    const [selectedAgencyCarrierId, setSelectedAgencyCarrierId] = useState('')
    const [fileType, setFileType] = useState<FileKind>('Policy')
    const [file, setFile] = useState<File | null>(null)
    const [uploading, setUploading] = useState(false)
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

    useEffect(() => {
        fetchAgencies()
    }, [])

    useEffect(() => {
        if (selectedAgencyId) {
            fetchCarriersForAgency(selectedAgencyId)
        } else {
            setCarriers([])
            setSelectedAgencyCarrierId('')
        }
    }, [selectedAgencyId])

    const fetchAgencies = async () => {
        const { data } = await supabase.from('agencies').select('id, name').order('name')
        setAgencies(data || [])
    }

    const fetchCarriersForAgency = async (agencyId: string) => {
        // Fetch agency_carriers with carrier info for this agency
        const { data } = await supabase
            .from('agency_carriers')
            .select(`
        id,
        carriers (
          id,
          code,
          name
        )
      `)
            .eq('agency_id', agencyId)
            .order('carriers(name)')

        setCarriers(data || [])
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
            setMessage(null)
        }
    }

    const handleUpload = async () => {
        if (!file || !selectedAgencyId || !selectedAgencyCarrierId) {
            setMessage({ type: 'error', text: 'Please select all fields and a file.' })
            return
        }

        setUploading(true)
        setMessage(null)

        try {
            // Get agency and carrier names for path + routing
            const agency = agencies.find(a => a.id === selectedAgencyId)
            const agencyCarrier = carriers.find((ac: any) => ac.id === selectedAgencyCarrierId)

            if (!agency || !agencyCarrier) throw new Error('Invalid selection')

            const carrierCode: string | undefined = agencyCarrier?.carriers?.code
            if (!carrierCode) {
                throw new Error('Selected carrier is missing a code (expected AETNA, AMAM, or TRANSAMERICA)')
            }

            const sanitizedFilename = file.name.replace(/[^a-zA-Z0-9.-]/g, '_')
            const filePath = `${agency.name}/${agencyCarrier.carriers.name}/${fileType}/${sanitizedFilename}`

            const { error: storageError } = await supabase.storage
                .from('uic-documents')
                .upload(filePath, file, {
                    upsert: true
                })

            if (storageError) throw storageError

            // Insert metadata row in new files table
            const { data: fileRow, error: fileError } = await supabase
                .from('files')
                .insert({
                    agency_carrier_id: selectedAgencyCarrierId,
                    file_type: fileType,
                    original_filename: file.name,
                    storage_path: filePath,
                    source_format: resolveSourceFormat(carrierCode, fileType),
                })
                .select()
                .single()

            if (fileError || !fileRow) throw fileError || new Error('Failed to create file record')

            // Parse file client-side (CSV/XLSX)
            const parseResult = await parseFile(file) as { records: ParsedRecord[]; totalRecords: number }
            if (!parseResult.records.length) {
                setMessage({ type: 'error', text: 'No records found in the file.' })
                return
            }

            const targetTable = resolveTargetTable(carrierCode, fileType)
            let rows: any[] = []

            if (carrierCode === 'AMAM' && fileType === 'Policy') {
                rows = buildAmamPolicyRows(parseResult.records, selectedAgencyCarrierId, fileRow.id, file.name)
            } else if (carrierCode === 'AMAM' && fileType === 'Commission') {
                rows = buildAmamCommissionRows(parseResult.records, selectedAgencyCarrierId, fileRow.id, file.name)
            } else if (carrierCode === 'AETNA' && fileType === 'Policy') {
                rows = buildAetnaPolicyRows(parseResult.records, selectedAgencyCarrierId, fileRow.id, file.name)
            } else if (carrierCode === 'AETNA' && fileType === 'Commission') {
                rows = buildAetnaCommissionRows(parseResult.records, selectedAgencyCarrierId, fileRow.id, file.name)
            } else if (carrierCode === 'TRANSAMERICA' && fileType === 'Policy') {
                rows = buildTransamericaPolicyRows(parseResult.records, selectedAgencyCarrierId, fileRow.id, file.name)
            } else if (carrierCode === 'TRANSAMERICA' && fileType === 'Commission') {
                setMessage({ type: 'error', text: 'Transamerica commission files are not yet supported. Upload policy files only.' })
                return
            }

            if (!rows.length) {
                setMessage({ type: 'error', text: 'File parsed but no mappable records were found.' })
                return
            }

            const BATCH_SIZE = 500
            const isPolicyTable = targetTable === 'aetna_policies' || targetTable === 'amam_policies' || targetTable === 'transamerica_policies'

            for (let i = 0; i < rows.length; i += BATCH_SIZE) {
                const chunk = rows.slice(i, i + BATCH_SIZE)

                const query = supabase.from(targetTable)

                const { error } = isPolicyTable
                    ? await query.upsert(chunk, {
                        onConflict: 'agency_carrier_id,policy_number',
                    })
                    : await query.insert(chunk) // commissions: allow multiple rows per policy

                if (error) {
                    console.error('Chunk write error:', error)
                    throw error
                }
            }

            // Update processed count on file
            await supabase
                .from('files')
                .update({ records_processed: parseResult.records.length, updated_at: new Date().toISOString() })
                .eq('id', fileRow.id)

            setMessage({ type: 'success', text: `Imported ${parseResult.records.length} ${carrierCode} ${fileType} record(s) from "${file.name}".` })
            setFile(null)
            const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
            if (fileInput) fileInput.value = ''
        } catch (error: any) {
            console.error('Upload error:', error)
            setMessage({ type: 'error', text: error.message || 'Upload failed' })
        } finally {
            setUploading(false)
        }
    }

    return (
        <div className="max-w-3xl mx-auto space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                    <CloudUpload className="w-6 h-6 text-orange-400" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white">Upload Document</h1>
                    <p className="text-gray-400">Upload policies and commission files</p>
                </div>
            </div>

            <Card className="bg-slate-900 border border-slate-800 shadow-sm">
                <CardHeader className="border-b border-slate-800">
                    <CardTitle className="text-white flex items-center space-x-2">
                        <FileUp className="w-5 h-5 text-orange-400" />
                        <span>File Details</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="space-y-2">
                            <Label className="text-gray-300">Agency</Label>
                            <Select value={selectedAgencyId} onValueChange={setSelectedAgencyId}>
                                <SelectTrigger className="bg-slate-900 border-slate-700 text-white">
                                    <SelectValue placeholder="Select Agency" />
                                </SelectTrigger>
                                <SelectContent className="bg-slate-800 border-slate-700">
                                    {agencies.map(agency => (
                                        <SelectItem key={agency.id} value={agency.id} className="text-white focus:bg-slate-700">{agency.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label className="text-gray-300">Carrier</Label>
                            <Select value={selectedAgencyCarrierId} onValueChange={setSelectedAgencyCarrierId} disabled={!selectedAgencyId}>
                                <SelectTrigger className="bg-slate-900 border-slate-700 text-white disabled:opacity-50">
                                    <SelectValue placeholder={selectedAgencyId ? "Select Carrier" : "Select Agency First"} />
                                </SelectTrigger>
                                <SelectContent className="bg-slate-800 border-slate-700">
                                    {carriers.map((ac: any) => (
                                        <SelectItem key={ac.id} value={ac.id} className="text-white focus:bg-slate-700">
                                            {ac.carriers.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <Label className="text-gray-300">File Type</Label>
                        <RadioGroup defaultValue="Policy" value={fileType} onValueChange={setFileType} className="grid grid-cols-2 gap-4">
                            <div className="relative">
                                <RadioGroupItem value="Policy" id="r1" className="peer sr-only" />
                                <Label
                                    htmlFor="r1"
                                    className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-slate-700 bg-slate-900 hover:bg-slate-800 cursor-pointer peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 transition-all"
                                >
                                    <span className="text-white font-medium">Policy File</span>
                                    <span className="text-xs text-gray-400 mt-1">Insurance policies</span>
                                </Label>
                            </div>
                            <div className="relative">
                                <RadioGroupItem value="Commission" id="r2" className="peer sr-only" />
                                <Label
                                    htmlFor="r2"
                                    className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-slate-700 bg-slate-900 hover:bg-slate-800 cursor-pointer peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 transition-all"
                                >
                                    <span className="text-white font-medium">Commission File</span>
                                    <span className="text-xs text-gray-400 mt-1">Commission reports</span>
                                </Label>
                            </div>
                        </RadioGroup>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-gray-300">Select File</Label>
                        <div className="border-2 border-dashed border-slate-700 rounded-xl p-8 text-center hover:border-orange-500/70 transition-colors bg-slate-900">
                            <Input
                                type="file"
                                onChange={handleFileChange}
                                className="hidden"
                                id="file-upload"
                            />
                            <label htmlFor="file-upload" className="cursor-pointer">
                                {file ? (
                                    <div className="space-y-2">
                                        <FileUp className="w-12 h-12 mx-auto text-green-400" />
                                        <p className="text-white font-medium">{file.name}</p>
                                        <p className="text-sm text-gray-400">{(file.size / 1024).toFixed(2)} KB</p>
                                        <p className="text-xs text-orange-400 mt-2">Click to change file</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <CloudUpload className="w-12 h-12 mx-auto text-slate-500" />
                                        <p className="text-slate-100">Click to upload or drag and drop</p>
                                        <p className="text-sm text-slate-400">PDF, XLS, XLSX, CSV (MAX. 10MB)</p>
                                    </div>
                                )}
                            </label>
                        </div>
                    </div>

                    {message && (
                        <div className={`p-4 rounded-xl flex items-center space-x-3 ${message.type === 'success'
                                ? 'bg-emerald-900/40 border border-emerald-700/70'
                                : 'bg-red-900/40 border border-red-700/70'
                            }`}>
                            {message.type === 'success' ? (
                                <CheckCircle className="w-5 h-5 text-green-400" />
                            ) : (
                                <AlertCircle className="w-5 h-5 text-red-400" />
                            )}
                            <span className={message.type === 'success' ? 'text-emerald-200' : 'text-red-200'}>{message.text}</span>
                        </div>
                    )}

                    <Button
                        onClick={handleUpload}
                        disabled={uploading || !file || !selectedAgencyId || !selectedAgencyCarrierId}
                        className="w-full h-12 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white shadow-sm"
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Uploading...
                            </>
                        ) : (
                            <>
                                <Upload className="mr-2 h-5 w-5" /> Upload File
                            </>
                        )}
                    </Button>
                </CardContent>
            </Card>
        </div>
    )
}
