'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { fetchPolicyRecords } from '@/lib/policyHelpers'
import { executeUpload, type FileKind } from '@/lib/uploadLogic'
import { useDealTrackerUpload } from '@/lib/useDealTrackerUpload'
import { useCommissionReportUpload } from '@/lib/useCommissionReportUpload'
import { DealTrackerVerificationDialog } from '@/components/DealTrackerVerificationDialog'
import { CommissionReportDialog } from '@/components/CommissionReportDialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ArrowLeft, Upload, CheckCircle, AlertCircle, Loader2, FileText, CloudUpload } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminOutlineBtn,
  adminPaginationBar,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
  adminTypeTabActive,
  adminTypeTabIdle,
  adminTypeTabsWrap,
} from '@/lib/adminFieldClasses'

export default function CarrierDetailPage() {
    const params = useParams()
    const router = useRouter()
    const carrierId = params.id as string

    const dealTracker = useDealTrackerUpload()
    const commissionReport = useCommissionReportUpload({
        onAfterSave: () => dealTracker.confirmAndSave(),
    })

    const [carrier, setCarrier] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [file, setFile] = useState<File | null>(null)
    const [fileType, setFileType] = useState<'Policy' | 'Commission'>('Policy')
    const [uploading, setUploading] = useState(false)
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

    const [policyRecords, setPolicyRecords] = useState<any[]>([])
    const [recordsLoading, setRecordsLoading] = useState(false)
    const [selectedFileType, setSelectedFileType] = useState<'Policy' | 'Commission' | 'All'>('All')
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)
    const [lastUploadContext, setLastUploadContext] = useState<{
        agencyCarrierId: string
        fileId: string
        carrierCode: string
        fileType: FileKind
    } | null>(null)

    useEffect(() => {
        fetchCarrierDetails()
        fetchRecords()
    }, [carrierId])

    useEffect(() => {
        fetchRecords()
    }, [selectedFileType])

    useEffect(() => {
        setCurrentPage(1) // Reset to page 1 when filter changes
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

        const agencyCarrierId: string = agencyCarrier.id
        const agencyName: string = agencyCarrier.agencies?.name ?? 'Agency'
        const carrierName: string = carrier.name ?? 'Carrier'
        const carrierCode: string = carrier.code ?? carrierName

        setUploading(true)
        setMessage(null)

        try {
            const result = await executeUpload({
                agencyCarrierId,
                agencyName,
                carrierName,
                carrierCode,
                file,
                fileType,
            })

            if (!result.success) {
                const errorMsg = result.error || 'Upload failed'
                setMessage({ type: 'error', text: errorMsg })
                setUploading(false)
                return
            }

            const count = (result as { count?: number }).count ?? 0
            setMessage({
                type: 'success',
                text: `Successfully uploaded ${count} record(s).`,
            })

            if (
                (carrierCode === 'AETNA' ||
                    carrierCode === 'AMAM' ||
                    carrierCode === 'MOH' ||
                    carrierCode === 'RNA' ||
                    carrierCode === 'TRANSAMERICA' ||
                    carrierCode === 'LIBERTY' ||
                    carrierCode === 'COREBRIDGE' ||
                    carrierCode === 'AFLAC' ||
                    carrierCode === 'SENTINEL' ||
                    carrierCode === 'AHL') &&
                (fileType === 'Policy' || fileType === 'Commission') &&
                'fileId' in result
            ) {
                setLastUploadContext({
                    agencyCarrierId,
                    fileId: result.fileId,
                    carrierCode,
                    fileType,
                })
                await dealTracker.processAfterUpload(agencyCarrierId, result.fileId, carrierCode, fileType)
            }

            // Clear file input
            setFile(null)
            const fileInput = document.querySelector('#file-upload') as HTMLInputElement | null
            if (fileInput) fileInput.value = ''

            // Refresh records
            fetchRecords()
        } catch (error: any) {
            console.error('Upload error:', error)
            const errorMsg = error.message || 'Upload failed'
            setMessage({ type: 'error', text: errorMsg })
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
        return <div className="p-6 text-muted-foreground">Carrier not found</div>
    }

    const columns = getColumnNames()

    // Pagination
    const totalPages = Math.ceil(policyRecords.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedRecords = policyRecords.slice(startIndex, endIndex)

    return (
        <div className="admin-page animate-in space-y-6 fade-in duration-500">
            <div className="flex items-center space-x-4">
                <Button variant="ghost" size="icon" onClick={() => router.push('/carriers')} className="text-foreground hover:bg-muted">
                    <ArrowLeft className="h-5 w-5" />
                </Button>
                <div className="flex items-center space-x-4">
                    <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-gradient-to-br from-slate-100 to-slate-200/90 dark:from-slate-800/90 dark:to-slate-900">
                        <FileText className="h-6 w-6 text-orange-500 dark:text-orange-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-foreground">{carrier.name}</h1>
                        <p className="text-muted-foreground">
                            {carrier.agency_carriers.map((ac: any) => ac.agencies.name).join(', ')}
                        </p>
                    </div>
                </div>
            </div>

            <Card>
                <CardHeader className={adminCardHeaderBar}>
                    <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
                        <CloudUpload className="h-5 w-5 text-orange-500 dark:text-orange-400" />
                        <span>Upload File</span>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-6 pt-6">
                    <div className="space-y-3">
                        <Label className="text-foreground">File Type</Label>
                        <RadioGroup value={fileType} onValueChange={(v) => setFileType(v as any)} className="grid grid-cols-2 gap-4">
                            <div className="relative">
                                <RadioGroupItem value="Policy" id="policy" className="peer sr-only" />
                                <Label
                                    htmlFor="policy"
                                    className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/30 p-4 transition-all hover:bg-muted/50 peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 dark:border-slate-700 dark:bg-muted/20 dark:hover:bg-slate-800/80"
                                >
                                    <span className="font-medium text-foreground">Policy File</span>
                                    <span className="mt-1 text-xs text-muted-foreground">Insurance policies</span>
                                </Label>
                            </div>
                            <div className="relative">
                                <RadioGroupItem value="Commission" id="commission" className="peer sr-only" />
                                <Label
                                    htmlFor="commission"
                                    className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/30 p-4 transition-all hover:bg-muted/50 peer-data-[state=checked]:border-orange-500 peer-data-[state=checked]:bg-orange-500/10 dark:border-slate-700 dark:bg-muted/20 dark:hover:bg-slate-800/80"
                                >
                                    <span className="font-medium text-foreground">Commission File</span>
                                    <span className="mt-1 text-xs text-muted-foreground">Commission reports</span>
                                </Label>
                            </div>
                        </RadioGroup>
                    </div>

                    <div className="space-y-2">
                        <Label className="text-foreground">Select File (CSV or Excel)</Label>
                        <div className="rounded-xl border-2 border-dashed border-border bg-muted/20 p-8 text-center transition-colors hover:border-orange-500/50 dark:bg-slate-950/30">
                            <Input type="file" accept=".csv,.xlsx,.xls,.pdf" onChange={handleFileChange} className="hidden" id="file-upload" />
                            <label htmlFor="file-upload" className="cursor-pointer">
                                {file ? (
                                    <div className="space-y-2">
                                        <CloudUpload className="mx-auto h-12 w-12 text-emerald-600 dark:text-green-400" />
                                        <p className="font-medium text-foreground">{file.name}</p>
                                        <p className="text-sm text-muted-foreground">{(file.size / 1024).toFixed(2)} KB</p>
                                        <p className="mt-2 text-xs text-orange-600 dark:text-orange-400">Click to change file</p>
                                    </div>
                                ) : (
                                    <div className="space-y-2">
                                        <CloudUpload className="mx-auto h-12 w-12 text-muted-foreground" />
                                        <p className="text-foreground">Click to upload or drag and drop</p>
                                        <p className="text-sm text-muted-foreground">CSV or Excel files</p>
                                    </div>
                                )}
                            </label>
                        </div>
                    </div>

                    {message && (
                        <div className={cn(
                            'flex items-center space-x-3 rounded-xl border p-4',
                            message.type === 'success'
                                ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-700/70 dark:bg-emerald-900/40 dark:text-emerald-100'
                                : 'border-red-200 bg-red-50 text-red-900 dark:border-red-700/70 dark:bg-red-900/40 dark:text-red-100'
                        )}>
                            {message.type === 'success' ? (
                                <CheckCircle className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-300" />
                            ) : (
                                <AlertCircle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-300" />
                            )}
                            <span>{message.text}</span>
                        </div>
                    )}

                    <Button
                        onClick={handleUpload}
                        disabled={uploading || !file}
                        className="h-12 w-full bg-orange-600 text-sm font-medium text-white shadow-sm hover:bg-orange-700 disabled:cursor-not-allowed disabled:opacity-50"
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

            <Card>
                <CardHeader className={cn(adminCardHeaderBar)}>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                        <CardTitle className={adminCardTitle}>Policy Records ({policyRecords.length})</CardTitle>
                        <div className={cn(adminTypeTabsWrap, 'items-center gap-1')}>
                            <button type="button" onClick={() => setSelectedFileType('All')} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', selectedFileType === 'All' ? adminTypeTabActive : adminTypeTabIdle)}>All</button>
                            <button type="button" onClick={() => setSelectedFileType('Policy')} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', selectedFileType === 'Policy' ? adminTypeTabActive : adminTypeTabIdle)}>Policy</button>
                            <button type="button" onClick={() => setSelectedFileType('Commission')} className={cn('rounded-md px-3 py-1.5 text-sm font-medium', selectedFileType === 'Commission' ? adminTypeTabActive : adminTypeTabIdle)}>Commission</button>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    {recordsLoading ? (
                        <div className="flex items-center justify-center py-8">
                            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                        </div>
                        ) : policyRecords.length === 0 ? (
                            <div className="py-12 text-center text-muted-foreground">
                            No records found. Upload a file to get started.
                        </div>
                    ) : (
                        <>
                            <div className="flex flex-col gap-2 border-b border-border px-4 py-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between dark:border-slate-800">
                                <span>
                                    Showing {policyRecords.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, policyRecords.length)} of {policyRecords.length} records
                                </span>
                                <div className="flex items-center gap-2">
                                    <span>Rows per page:</span>
                                    <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                                        <SelectTrigger className={cn('h-8 w-20 text-xs', adminSelectTrigger)}>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent className={adminSelectContent}>
                                            <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
                                            <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
                                            <SelectItem value="100" className={adminSelectItem}>100</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                            <div className="overflow-x-auto">
                                <Table>
                                    <TableHeader>
                                        <TableRow className="border-b border-border hover:bg-transparent dark:border-white/10">
                                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Policy #</TableHead>
                                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Type</TableHead>
                                            {columns.slice(0, 8).map(col => (
                                                <TableHead key={col} className={cn(adminThPlain, 'font-semibold')}>{col}</TableHead>
                                            ))}
                                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Updated</TableHead>
                                        </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                        {paginatedRecords.map((record) => (
                                            <TableRow key={record.id} className={adminTableRowInteractive}>
                                                <TableCell className={cn(adminTdStrong, 'font-medium')}>{record.policy_number}</TableCell>
                                                <TableCell>
                                                    <span className="rounded-full bg-muted px-2 py-1 text-xs text-foreground dark:bg-slate-800 dark:text-slate-100">
                                                        {record.file_type}
                                                    </span>
                                                </TableCell>
                                                {columns.slice(0, 8).map(col => (
                                                    <TableCell key={col} className={cn(adminTdMuted, 'text-sm')}>
                                                        {String(record.raw_data[col] || '-').substring(0, 50)}
                                                    </TableCell>
                                                ))}
                                                <TableCell className={cn(adminTdMuted, 'text-sm')}>
                                                    {new Date(record.updated_at).toLocaleDateString()}
                                                </TableCell>
                                            </TableRow>
                                        ))}
                                    </TableBody>
                                </Table>
                            </div>
                            {policyRecords.length > 0 && (
                                <div className={cn('flex items-center justify-between border-t border-border px-4 py-3 dark:border-slate-800', adminPaginationBar)}>
                                    <div className="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</div>
                                    <div className="flex items-center gap-2">
                                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>First</Button>
                                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>Previous</Button>
                                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>Next</Button>
                                        <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>Last</Button>
                                    </div>
                                </div>
                            )}
                        </>
                    )}
                </CardContent>
            </Card>

            {/* Deal Tracker Verification Dialog */}
            <DealTrackerVerificationDialog
                open={dealTracker.showVerification}
                onOpenChange={dealTracker.setShowVerification}
                entries={dealTracker.verificationEntries}
                loadingMessage={dealTracker.previewLoadingMessage}
                saveProgressLogs={dealTracker.saveProgressLogs}
                onConfirm={dealTracker.confirmAndSave}
                onCancel={dealTracker.cancelVerification}
                fileType={lastUploadContext?.fileType}
                onNext={
                    lastUploadContext?.fileType === 'Commission' &&
                    ['AETNA', 'AMAM', 'MOH', 'COREBRIDGE', 'AFLAC', 'AHL'].includes(
                        (lastUploadContext?.carrierCode || '').toUpperCase()
                    )
                        ? () => {
                              dealTracker.setShowVerification(false)
                              if (lastUploadContext) {
                                  commissionReport.openCommissionReport(
                                      lastUploadContext.agencyCarrierId,
                                      lastUploadContext.fileId,
                                      lastUploadContext.carrierCode
                                  )
                              }
                          }
                        : undefined
                }
            />

            {/* Commission Report Dialog */}
            <CommissionReportDialog
                open={commissionReport.showCommissionReport}
                onOpenChange={commissionReport.handleCommissionReportOpenChange}
                rows={commissionReport.commissionRows}
                loading={commissionReport.loading}
                saving={commissionReport.saving}
                carrierCode={lastUploadContext?.carrierCode ?? 'AETNA'}
                agencyCarrierId={commissionReport.reportContext?.agencyCarrierId}
                fileId={commissionReport.reportContext?.fileId}
                onSave={async (editedRows) => {
                    await commissionReport.saveCommissionReport(editedRows)
                }}
            />
        </div>
    )
}
