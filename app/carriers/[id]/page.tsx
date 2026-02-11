'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { parseFile } from '@/lib/fileParser'
import { upsertPolicyRecords, fetchPolicyRecords, createUploadedFileRecord, updateUploadedFileStatus } from '@/lib/policyHelpers'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArrowLeft, Upload, CheckCircle, AlertCircle, Loader2, FileText, CloudUpload } from 'lucide-react'

export default function CarrierDetailPage() {
    const params = useParams()
    const router = useRouter()
    const carrierId = params.id as string

    const [carrier, setCarrier] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [file, setFile] = useState<File | null>(null)
    const [fileType, setFileType] = useState<'Policy' | 'Commission'>('Policy')
    const [uploading, setUploading] = useState(false)
    const [message, setMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

    const [policyRecords, setPolicyRecords] = useState<any[]>([])
    const [recordsLoading, setRecordsLoading] = useState(false)
    const [selectedFileType, setSelectedFileType] = useState<'Policy' | 'Commission' | 'All'>('All')

    useEffect(() => {
        fetchCarrierDetails()
        fetchRecords()
    }, [carrierId])

    useEffect(() => {
        fetchRecords()
    }, [selectedFileType])

    const fetchCarrierDetails = async () => {
        setLoading(true)
        const { data, error } = await supabase
            .from('carriers')
            .select(`
                *,
                agency_carriers (
                    id,
                    agencies (
                        id,
                        name
                    )
                )
            `)
            .eq('id', carrierId)
            .single()

        if (error) {
            console.error('Error fetching carrier:', error)
        } else {
            setCarrier(data)
        }
        setLoading(false)
    }

    const fetchRecords = async () => {
        setRecordsLoading(true)
        try {
            // Get the first agency_carrier_id for this carrier
            const { data: agencyCarriers } = await supabase
                .from('agency_carriers')
                .select('id')
                .eq('carrier_id', carrierId)
                .limit(1)

            if (agencyCarriers && agencyCarriers.length > 0) {
                const records = await fetchPolicyRecords(
                    agencyCarriers[0].id,
                    selectedFileType === 'All' ? undefined : selectedFileType
                )
                setPolicyRecords(records)
            }
        } catch (error) {
            console.error('Error fetching records:', error)
        }
        setRecordsLoading(false)
    }

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setFile(e.target.files[0])
            setMessage(null)
        }
    }

    const handleUpload = async () => {
        if (!file || !carrier) {
            setMessage({ type: 'error', text: 'Please select a file to upload.' })
            return
        }

        // Get the first agency_carrier for this carrier
        const agencyCarrier = carrier.agency_carriers[0]
        if (!agencyCarrier) {
            setMessage({ type: 'error', text: 'No agency association found for this carrier.' })
            return
        }

        setUploading(true)
        setMessage(null)

        try {
            // Create upload record
            const uploadRecord = await createUploadedFileRecord(
                agencyCarrier.id,
                file.name,
                fileType
            )

            // Parse the file
            const parseResult = await parseFile(file)

            if (parseResult.records.length === 0) {
                await updateUploadedFileStatus(uploadRecord.id, 'failed', 0, 'No records found in file')
                setMessage({ type: 'error', text: 'No records found in the file.' })
                setUploading(false)
                return
            }

            // Upsert records to database
            const result = await upsertPolicyRecords(
                agencyCarrier.id,
                fileType,
                parseResult.records,
                uploadRecord.id
            )

            // Update upload status
            await updateUploadedFileStatus(
                uploadRecord.id,
                'completed',
                parseResult.totalRecords
            )

            setMessage({
                type: 'success',
                text: `Successfully uploaded ${parseResult.totalRecords} records! (${result.inserted} new, ${result.updated} updated${result.failed > 0 ? `, ${result.failed} failed` : ''})`
            })

            // Clear file input
            setFile(null)
            const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
            if (fileInput) fileInput.value = ''

            // Refresh records
            fetchRecords()
        } catch (error: any) {
            console.error('Upload error:', error)
            const errorMsg = error.message || 'Upload failed'
            let detailedMsg = errorMsg

            // Add helpful diagnostic info based on common errors
            if (errorMsg.includes('policy_records') || errorMsg.includes('Day 1') || error.code === '42P01') {
                detailedMsg = (
                    <div className="flex flex-col space-y-2">
                        <span className="font-bold">Database Error: Table not found</span>
                        <span>The 'policy_records' table seems to be missing.</span>
                        <div className="bg-red-950/50 p-2 rounded text-xs font-mono mt-1">
                            {errorMsg}
                            {error.code && <div>Code: {error.code}</div>}
                        </div>
                        <span className="text-sm underline cursor-pointer mt-2" onClick={() => window.open('/records', '_blank')}>
                            Did you run the migration SQL? Click here to check records.
                        </span>
                    </div>
                ) as any
            }

            setMessage({ type: 'error', text: detailedMsg })
        } finally {
            setUploading(false)
        }
    }

    // Get all unique column names from records
    const getColumnNames = () => {
        if (policyRecords.length === 0) return []
        const allKeys = new Set<string>()
        policyRecords.forEach(record => {
            Object.keys(record.raw_data || {}).forEach(key => allKeys.add(key))
        })
        return Array.from(allKeys)
    }

    if (loading) {
        return (
            <div className="flex items-center justify-center min-h-screen">
                <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            </div>
        )
    }

    if (!carrier) {
        return <div className="text-white">Carrier not found</div>
    }

    const columns = getColumnNames()

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header with back button */}
            <div className="flex items-center space-x-4">
                <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => router.push('/carriers')}
                    className="hover:bg-slate-900"
                >
                    <ArrowLeft className="w-5 h-5 text-white" />
                </Button>
                <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                        <FileText className="w-6 h-6 text-orange-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-white">{carrier.name}</h1>
                        <p className="text-gray-400">
                            {carrier.agency_carriers.map((ac: any) => ac.agencies.name).join(', ')}
                        </p>
                    </div>
                </div>
            </div>

            {/* Upload Card */}
            <Card className="bg-slate-900 border border-slate-800">
                <CardHeader className="border-b border-slate-800">
                    <CardTitle className="text-white flex items-center space-x-2">
                        <CloudUpload className="w-5 h-5 text-orange-400" />
                        <span>Upload File</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    <div className="space-y-3">
                        <Label className="text-gray-300">File Type</Label>
                        <RadioGroup value={fileType} onValueChange={(v) => setFileType(v as any)} className="grid grid-cols-2 gap-4">
                            <div className="relative">
                                <RadioGroupItem value="Policy" id="policy" className="peer sr-only" />
                                <Label
                                    htmlFor="policy"
                                    className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-slate-700 bg-slate-900 hover:bg-slate-800 cursor-pointer peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 transition-all"
                                >
                                    <span className="text-white font-medium">Policy File</span>
                                    <span className="text-xs text-gray-400 mt-1">Insurance policies</span>
                                </Label>
                            </div>
                            <div className="relative">
                                <RadioGroupItem value="Commission" id="commission" className="peer sr-only" />
                                <Label
                                    htmlFor="commission"
                                    className="flex flex-col items-center justify-center p-4 rounded-xl border-2 border-slate-700 bg-slate-900 hover:bg-slate-800 cursor-pointer peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 transition-all"
                                >
                                    <span className="text-white font-medium">Commission File</span>
                                    <span className="text-xs text-gray-400 mt-1">Commission reports</span>
                                </Label>
                            </div>
                        </RadioGroup>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-gray-300">Select File (CSV or Excel)</Label>
                        <div className="border-2 border-dashed border-slate-700 rounded-xl p-8 text-center hover:border-orange-500/70 transition-colors bg-slate-900">
                            <Input
                                type="file"
                                accept=".csv,.xlsx,.xls"
                                onChange={handleFileChange}
                                className="hidden"
                                id="file-upload"
                            />
                            <label htmlFor="file-upload" className="cursor-pointer">
                                {file ? (
                                    <div className="space-y-2">
                                        <CloudUpload className="w-12 h-12 mx-auto text-green-400" />
                                        <p className="text-white font-medium">{file.name}</p>
                                        <p className="text-sm text-gray-400">{(file.size / 1024).toFixed(2)} KB</p>
                                        <p className="text-xs text-orange-400 mt-2">Click to change file</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <CloudUpload className="w-12 h-12 mx-auto text-slate-500" />
                                        <p className="text-slate-100">Click to upload or drag and drop</p>
                                        <p className="text-sm text-slate-400">CSV or Excel files</p>
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
                                <CheckCircle className="w-5 h-5 text-emerald-300" />
                            ) : (
                                <AlertCircle className="w-5 h-5 text-red-300" />
                            )}
                            <span className={message.type === 'success' ? 'text-emerald-200' : 'text-red-200'}>{message.text}</span>
                        </div>
                    )}

                    <Button
                        onClick={handleUpload}
                        disabled={uploading || !file}
                        className="w-full h-12 bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium text-white shadow-sm"
                    >
                        {uploading ? (
                            <>
                                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Uploading & Processing...
                            </>
                        ) : (
                            <>
                                <Upload className="mr-2 h-5 w-5" /> Upload & Parse File
                            </>
                        )}
                    </Button>
                </CardContent>
            </Card>

            {/* Records Display */}
            <Card className="bg-slate-900 border border-slate-800">
                <CardHeader className="border-b border-slate-800">
                    <div className="flex items-center justify-between">
                        <CardTitle className="text-white">Policy Records ({policyRecords.length})</CardTitle>
                        <div className="flex gap-2">
                            <Button
                                variant={selectedFileType === 'All' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSelectedFileType('All')}
                                className={selectedFileType === 'All' ? 'bg-slate-800 text-slate-100' : 'text-slate-200'}
                            >
                                All
                            </Button>
                            <Button
                                variant={selectedFileType === 'Policy' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSelectedFileType('Policy')}
                                className={selectedFileType === 'Policy' ? 'bg-slate-800 text-slate-100' : 'text-slate-200'}
                            >
                                Policy
                            </Button>
                            <Button
                                variant={selectedFileType === 'Commission' ? 'default' : 'outline'}
                                size="sm"
                                onClick={() => setSelectedFileType('Commission')}
                                className={selectedFileType === 'Commission' ? 'bg-slate-800 text-slate-100' : 'text-slate-200'}
                            >
                                Commission
                            </Button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {recordsLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="w-6 h-6 animate-spin text-slate-300" />
                        </div>
                        ) : policyRecords.length === 0 ? (
                            <div className="text-center py-12 text-slate-400">
                            No records found. Upload a file to get started.
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow className="border-b border-white/10 hover:bg-transparent">
                                        <TableHead className="text-slate-300 font-semibold">Policy #</TableHead>
                                        <TableHead className="text-slate-300 font-semibold">Type</TableHead>
                                        {columns.slice(0, 8).map(col => (
                                            <TableHead key={col} className="text-slate-300 font-semibold">{col}</TableHead>
                                        ))}
                                        <TableHead className="text-gray-300 font-semibold">Updated</TableHead>
                                    </TableRow>
                                </TableHeader>
                                    <TableBody>
                                        {policyRecords.map((record) => (
                                            <TableRow key={record.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors">
                                                <TableCell className="font-medium text-slate-100">{record.policy_number}</TableCell>
                                            <TableCell>
                                                    <span className={`px-2 py-1 rounded-full text-xs ${record.file_type === 'Policy' ? 'bg-slate-800 text-slate-100' : 'bg-slate-800 text-slate-100'}`}>
                                                    {record.file_type}
                                                </span>
                                            </TableCell>
                                            {columns.slice(0, 8).map(col => (
                                                <TableCell key={col} className="text-slate-400">
                                                    {String(record.raw_data[col] || '-').substring(0, 50)}
                                                </TableCell>
                                            ))}
                                            <TableCell className="text-slate-400">
                                                {new Date(record.updated_at).toLocaleDateString()}
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>
        </div>
    )
}
