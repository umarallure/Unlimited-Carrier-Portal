'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileText, Search, Loader2, History, Calendar } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export default function RecordsPage() {
    const [records, setRecords] = useState<any[]>([])
    const [carriers, setCarriers] = useState<any[]>([])
    const [uploadHistory, setUploadHistory] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [selectedCarrier, setSelectedCarrier] = useState<string>('all')
    const [selectedType, setSelectedType] = useState<string>('all')
    const [changedOnDate, setChangedOnDate] = useState<string>('') // YYYY-MM-DD or '' for no filter
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)
    const [recordForHistory, setRecordForHistory] = useState<any>(null)

    const isRecordChangedOnDate = (record: any, dateStr: string) => {
        if (!dateStr) return true
        const ts = record.updated_at || record.created_at
        if (!ts) return false
        const d = new Date(ts)
        const [y, m, day] = dateStr.split('-').map(Number)
        return d.getFullYear() === y && d.getMonth() === m - 1 && d.getDate() === day
    }

    useEffect(() => {
        fetchCarriers()
        fetchRecords()
        fetchUploadHistory()
    }, [])

    useEffect(() => {
        fetchRecords()
    }, [selectedCarrier, selectedType])

    const fetchCarriers = async () => {
        const { data } = await supabase
            .from('carriers')
            .select('id, name')
            .order('name')
        setCarriers(data || [])
    }

    const fetchUploadHistory = async () => {
        const { data } = await supabase
            .from('files')
            .select(`
                id,
                original_filename,
                file_type,
                created_at,
                records_processed,
                agency_carriers (
                    carriers (name),
                    agencies (name)
                )
            `)
            .order('created_at', { ascending: false })
            .limit(30)
        setUploadHistory(data || [])
    }

    const fetchRecords = async () => {
        setLoading(true)
        try {
            const allRecords: any[] = []

            // Fetch from all per-carrier tables
            const tables = [
                { name: 'aetna_policies', type: 'Policy', carrierCode: 'AETNA' },
                { name: 'aetna_commissions', type: 'Commission', carrierCode: 'AETNA' },
                { name: 'amam_policies', type: 'Policy', carrierCode: 'AMAM' },
                { name: 'amam_commissions', type: 'Commission', carrierCode: 'AMAM' },
                { name: 'transamerica_policies', type: 'Policy', carrierCode: 'TRANSAMERICA' },
                { name: 'transamerica_commissions', type: 'Commission', carrierCode: 'TRANSAMERICA' },
            ]

            for (const table of tables) {
                // Skip if type filter doesn't match
                if (selectedType !== 'all' && table.type !== selectedType) continue

                // Supabase caps a single response at 1000 rows.
                // Fetch in 1000-row chunks so we can go past 1000 total.
                const PAGE_SIZE = 1000
                let offset = 0

                // eslint-disable-next-line no-constant-condition
                while (true) {
                    const { data, error } = await supabase
                        .from(table.name)
                        .select(`
                            *,
                            agency_carriers (
                                carriers (
                                    id,
                                    code,
                                    name
                                )
                            )
                        `)
                        .order('updated_at', { ascending: false })
                        .range(offset, offset + PAGE_SIZE - 1)

                    if (error) {
                        console.error(`Error fetching ${table.name}:`, error)
                        break
                    }

                    if (!data || data.length === 0) {
                        break
                    }

                    // Filter by carrier if selected
                    let filtered = data
                    if (selectedCarrier !== 'all') {
                        filtered = data.filter((r: any) =>
                            r.agency_carriers?.carriers?.id === selectedCarrier
                        )
                    }

                    // Transform to unified format for display
                    const transformed = filtered.map((r: any) => ({
                        ...r,
                        file_type: table.type,
                        carrier_code: table.carrierCode,
                        // Build a "raw_data" object from all columns for backward compatibility
                        raw_data: Object.fromEntries(
                            Object.entries(r).filter(([k]) =>
                                !['id', 'agency_carrier_id', 'file_id', 'row_number', 'created_at', 'updated_at', 'source_file', 'source_format', 'agency_carriers', 'version_history'].includes(k)
                            )
                        ),
                        version_history: Array.isArray(r.version_history) ? r.version_history : [],
                    }))

                    allRecords.push(...transformed)

                    // If we got less than a full page, we're done for this table
                    if (data.length < PAGE_SIZE) {
                        break
                    }

                    offset += PAGE_SIZE
                }
            }

            // Sort by updated_at descending
            allRecords.sort((a, b) => {
                const aTime = new Date(a.updated_at || a.created_at || 0).getTime()
                const bTime = new Date(b.updated_at || b.created_at || 0).getTime()
                return bTime - aTime
            })

            setRecords(allRecords)
        } catch (error) {
            console.error('Error:', error)
        }
        setLoading(false)
    }

    // Get column names from the records we're actually showing (so Policy/Commission/carrier have the right headers)
    const getColumnNames = (sourceRecords: any[]) => {
        if (sourceRecords.length === 0) return []
        const keyCount: Record<string, number> = {}
        sourceRecords.forEach(record => {
            Object.keys(record.raw_data || {}).forEach(key => {
                keyCount[key] = (keyCount[key] || 0) + 1
            })
        })
        // When viewing one type, show columns by order of frequency (most common first), more columns. When "All", top 10 by frequency.
        const maxCols = selectedType === 'all' ? 10 : 14
        return Object.entries(keyCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxCols)
            .map(([k]) => k)
    }

    const filteredRecords = records.filter(record => {
        // Apply type filter: only show Policy or Commission when one is selected
        if (selectedType !== 'all' && record.file_type !== selectedType) return false
        // Apply carrier filter
        if (selectedCarrier !== 'all' && record.agency_carriers?.carriers?.id !== selectedCarrier) return false
        // Apply "changed on date" filter: only records updated or created on the selected date
        if (changedOnDate && !isRecordChangedOnDate(record, changedOnDate)) return false
        // Apply search
        if (!searchTerm) return true
        const searchLower = searchTerm.toLowerCase()
        return (
            record.policy_number?.toLowerCase().includes(searchLower) ||
            JSON.stringify(record.raw_data).toLowerCase().includes(searchLower)
        )
    })

    // Pagination
    const totalPages = Math.ceil(filteredRecords.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedRecords = filteredRecords.slice(startIndex, endIndex)

    useEffect(() => {
        setCurrentPage(1) // Reset to page 1 when filters change
    }, [searchTerm, selectedCarrier, selectedType, changedOnDate])

    // Group current page by carrier so each carrier gets its own table with its own columns (no mixed headers)
    const groupByCarrier = (arr: any[]) => {
        const map: Record<string, any[]> = {}
        const order: string[] = []
        arr.forEach(record => {
            const id = record.agency_carriers?.carriers?.id ?? 'unknown'
            const name = record.agency_carriers?.carriers?.name ?? 'Unknown carrier'
            if (!map[id]) {
                map[id] = []
                order.push(id)
            }
            map[id].push(record)
        })
        return order.map(id => ({ carrierId: id, carrierName: (map[id][0]?.agency_carriers?.carriers?.name) ?? 'Unknown', records: map[id] }))
    }
    const carrierGroups = groupByCarrier(paginatedRecords)

    return (
        <div className="space-y-4 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center space-x-3">
                <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                    <FileText className="w-6 h-6 text-orange-400" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white">All Records</h1>
                    <p className="text-gray-400">View all uploaded policy and commission records</p>
                </div>
            </div>

            {/* Upload history (version history) */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2">
                    <History className="w-4 h-4 text-orange-400 shrink-0" />
                    <h2 className="text-sm font-semibold text-white">Upload history</h2>
                    <span className="text-slate-500 text-xs">— when files were loaded (last 30)</span>
                </div>
                <div className="max-h-40 overflow-y-auto">
                    {uploadHistory.length === 0 ? (
                        <p className="px-3 py-2 text-slate-500 text-sm">No file uploads yet.</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow className="border-b border-slate-800 hover:bg-transparent">
                                    <TableHead className="text-slate-400 font-medium">Date</TableHead>
                                    <TableHead className="text-slate-400 font-medium">File</TableHead>
                                    <TableHead className="text-slate-400 font-medium">Type</TableHead>
                                    <TableHead className="text-slate-400 font-medium">Carrier</TableHead>
                                    <TableHead className="text-slate-400 font-medium">Records</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {uploadHistory.map((f: any) => (
                                    <TableRow key={f.id} className="border-b border-slate-800/50 hover:bg-slate-800/30">
                                        <TableCell className="text-slate-300 text-sm whitespace-nowrap">
                                            {f.created_at ? new Date(f.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                                        </TableCell>
                                        <TableCell className="text-slate-200 text-sm font-mono truncate max-w-[200px]" title={f.original_filename}>
                                            {f.original_filename || '–'}
                                        </TableCell>
                                        <TableCell>
                                            <span className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-200">
                                                {f.file_type || '–'}
                                            </span>
                                        </TableCell>
                                        <TableCell className="text-slate-400 text-sm">
                                            {f.agency_carriers?.carriers?.name || '–'}
                                        </TableCell>
                                        <TableCell className="text-slate-400 text-sm">
                                            {f.records_processed != null ? f.records_processed : '–'}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </div>
            </div>

            {/* Type tabs: each view shows its own columns (Policy vs Commission have different headers) */}
            <div className="flex gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit">
                {(['all', 'Policy', 'Commission'] as const).map((type) => (
                    <button
                        key={type}
                        type="button"
                        onClick={() => setSelectedType(type === 'all' ? 'all' : type)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            selectedType === type
                                ? 'bg-slate-700 text-white'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                        }`}
                    >
                        {type === 'all' ? 'All records' : type}
                    </button>
                ))}
            </div>

            {/* Filters */}
            <div className="bg-slate-900 p-3 rounded-xl border border-slate-800">
                <div className="flex flex-wrap items-center gap-3">
                    {/* Search */}
                    <div className="relative min-w-[200px] flex-1 max-w-xs">
                        <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                        <Input
                            placeholder="Search by policy number..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-8 h-9 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500 text-sm"
                        />
                    </div>

                    {/* Changed on date */}
                    <div className="flex items-center gap-2 shrink-0">
                        <Calendar className="w-4 h-4 text-orange-400 shrink-0" />
                        <Input
                            type="date"
                            value={changedOnDate}
                            onChange={(e) => setChangedOnDate(e.target.value)}
                            className="bg-slate-950 border-slate-800 text-white w-[140px] h-9 text-sm"
                            title="Show only records changed on this date"
                        />
                        {changedOnDate && (
                            <button
                                type="button"
                                onClick={() => setChangedOnDate('')}
                                className="text-xs text-slate-400 hover:text-slate-200 underline shrink-0"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {/* Carrier Filter */}
                    <Select value={selectedCarrier} onValueChange={setSelectedCarrier}>
                        <SelectTrigger className="h-9 w-[160px] bg-slate-950 border-slate-800 text-white text-sm shrink-0">
                            <SelectValue placeholder="All Carriers" />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-800 border-slate-700">
                            <SelectItem value="all" className="text-white focus:bg-slate-700">All Carriers</SelectItem>
                            {carriers.map(carrier => (
                                <SelectItem key={carrier.id} value={carrier.id} className="text-white focus:bg-slate-700">
                                    {carrier.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                    <span>
                        Showing {filteredRecords.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredRecords.length)} of {filteredRecords.length} records
                    </span>
                    <div className="flex items-center gap-2">
                        <span>Rows per page:</span>
                        <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                            <SelectTrigger className="h-8 w-20 bg-slate-950 border-slate-800 text-white text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-800 border-slate-700">
                                <SelectItem value="25" className="text-white">25</SelectItem>
                                <SelectItem value="50" className="text-white">50</SelectItem>
                                <SelectItem value="100" className="text-white">100</SelectItem>
                                <SelectItem value="250" className="text-white">250</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            </div>

            {/* Records Table */}
            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center py-8">
                        <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="text-center py-8 text-slate-400">
                        {searchTerm || selectedCarrier !== 'all' || selectedType !== 'all' || changedOnDate
                            ? 'No records match your filters'
                            : 'No records found. Upload files to see data here.'}
                    </div>
                ) : (
                    <div className="divide-y divide-slate-800">
                        {carrierGroups.map(({ carrierId, carrierName, records: groupRecords }) => {
                            const groupColumns = getColumnNames(groupRecords)
                            return (
                                <div key={carrierId} className="overflow-x-auto">
                                    <div className="px-4 py-2 bg-slate-800/40 border-b border-slate-800 text-sm font-medium text-slate-200">
                                        {carrierName} <span className="text-slate-500 font-normal">({groupRecords.length} on this page)</span>
                                    </div>
                                    <Table>
                                        <TableHeader>
                                            <TableRow className="border-b border-slate-800 hover:bg-transparent">
                                                <TableHead className="text-slate-300 font-semibold">Policy #</TableHead>
                                                <TableHead className="text-slate-300 font-semibold">Type</TableHead>
                                                {groupColumns.map(col => (
                                                    <TableHead key={col} className="text-slate-300 font-semibold">{col}</TableHead>
                                                ))}
                                                <TableHead className="text-slate-300 font-semibold">First added</TableHead>
                                                <TableHead className="text-slate-300 font-semibold">Last updated</TableHead>
                                                <TableHead className="text-slate-300 font-semibold w-24">History</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {groupRecords.map((record) => (
                                                <TableRow key={record.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors">
                                                    <TableCell className="font-medium text-slate-100 font-mono text-sm">
                                                        {record.policy_number}
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="px-2 py-1 rounded-full text-xs font-medium bg-slate-800 text-slate-100">
                                                            {record.file_type}
                                                        </span>
                                                    </TableCell>
                                                    {groupColumns.map(col => (
                                                        <TableCell key={col} className="text-slate-400 text-sm">
                                                            {String(record.raw_data[col] ?? '–').substring(0, 40)}
                                                        </TableCell>
                                                    ))}
                                                    <TableCell className="text-slate-400 text-sm whitespace-nowrap" title="When this record was first added">
                                                        {record.created_at ? new Date(record.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                                                    </TableCell>
                                                    <TableCell className="text-slate-400 text-sm whitespace-nowrap" title="When this record was last updated">
                                                        {record.updated_at ? new Date(record.updated_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            className="text-orange-400 hover:text-orange-300 hover:bg-slate-800"
                                                            onClick={(e) => { e.stopPropagation(); setRecordForHistory(record); }}
                                                            title="View version history"
                                                        >
                                                            <History className="w-4 h-4 mr-1" />
                                                            {record.version_history?.length ?? 0}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            )
                        })}
                    </div>
                )}

                {/* Pagination Controls */}
                {filteredRecords.length > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
                        <div className="text-sm text-slate-400">
                            Page {currentPage} of {totalPages}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(1)}
                                disabled={currentPage === 1}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                First
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={currentPage === 1}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Previous
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Next
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(totalPages)}
                                disabled={currentPage === totalPages}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Last
                            </Button>
                        </div>
                    </div>
                )}
            </div>

            {/* Version history dialog */}
            <Dialog open={!!recordForHistory} onOpenChange={(open) => !open && setRecordForHistory(null)}>
                <DialogContent className="bg-slate-900 border-slate-700 max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
                    <DialogHeader>
                        <DialogTitle className="text-white flex items-center gap-2">
                            <History className="w-5 h-5 text-orange-400" />
                            Version history — {recordForHistory?.policy_number}
                        </DialogTitle>
                    </DialogHeader>
                    <div className="overflow-y-auto space-y-4 pr-2">
                        {recordForHistory && (() => {
                            const excludeKeys = ['id', 'agency_carrier_id', 'file_id', 'row_number', 'source_file', 'source_format', 'agency_carriers', 'version_history', 'raw_data', 'file_type', 'carrier_code']
                            const toFlat = (obj: any): Record<string, string> => {
                                if (!obj || typeof obj !== 'object') return {}
                                return Object.fromEntries(
                                    Object.entries(obj)
                                        .filter(([k, v]) => !excludeKeys.includes(k) && v != null && typeof v !== 'object')
                                        .map(([k, v]) => [k, String(v)])
                                )
                            }
                            const diff = (oldMap: Record<string, string>, newMap: Record<string, string>) => {
                                const added: [string, string][] = []
                                const removed: [string, string][] = []
                                const changed: [string, string, string][] = []
                                const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)])
                                allKeys.forEach(key => {
                                    const o = oldMap[key]
                                    const n = newMap[key]
                                    if (o === undefined && n !== undefined) added.push([key, n])
                                    else if (o !== undefined && n === undefined) removed.push([key, o])
                                    else if (o !== undefined && n !== undefined && o !== n) changed.push([key, o, n])
                                })
                                return { added, removed, changed }
                            }
                            const currentFlat = toFlat(recordForHistory)
                            const historyReversed = (recordForHistory.version_history || []).slice().reverse()
                            const prevFlats = historyReversed.map((e: any) => toFlat(e?.snapshot))

                            return (
                                <>
                                    {/* Current version */}
                                    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                                        <div className="text-xs font-semibold text-orange-400 uppercase tracking-wide mb-2">Current</div>
                                        {prevFlats.length > 0 && (() => {
                                            const d = diff(prevFlats[0], currentFlat)
                                            const hasChanges = d.added.length + d.removed.length + d.changed.length > 0
                                            return hasChanges ? (
                                                <div className="mb-3 rounded bg-slate-900/80 border border-slate-600 p-2 text-xs">
                                                    <span className="font-medium text-slate-300">What changed from previous:</span>
                                                    <ul className="mt-1 space-y-0.5 text-slate-200">
                                                        {d.changed.map(([key, oldVal, newVal]) => (
                                                            <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="line-through text-red-400/90">{oldVal}</span> → <span className="text-emerald-400">{newVal}</span></li>
                                                        ))}
                                                        {d.added.map(([key, val]) => (
                                                            <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-emerald-400">added: {val}</span></li>
                                                        ))}
                                                        {d.removed.map(([key, val]) => (
                                                            <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-red-400/90">removed (was: {val})</span></li>
                                                        ))}
                                                    </ul>
                                                </div>
                                            ) : null
                                        })()}
                                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                            {Object.entries(currentFlat).slice(0, 14).map(([key, val]) => (
                                                <span key={key} className="flex gap-2">
                                                    <dt className="text-slate-500 shrink-0">{key.replace(/_/g, ' ')}:</dt>
                                                    <dd className="text-slate-200 truncate min-w-0">{String(val)}</dd>
                                                </span>
                                            ))}
                                        </dl>
                                    </div>
                                    {/* Previous versions (newest first) */}
                                    {historyReversed.map((entry: any, idx: number) => {
                                        const thisFlat = prevFlats[idx] || {}
                                        const nextFlat = idx === 0 ? currentFlat : prevFlats[idx - 1]
                                        const d = diff(thisFlat, nextFlat)
                                        const hasChanges = d.added.length + d.removed.length + d.changed.length > 0
                                        return (
                                            <div key={idx} className="rounded-lg border border-slate-700 bg-slate-800/30 p-4">
                                                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">
                                                    Previous — {entry.at ? new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–'}
                                                </div>
                                                {hasChanges && (
                                                    <div className="mb-3 rounded bg-slate-900/80 border border-slate-600 p-2 text-xs">
                                                        <span className="font-medium text-slate-300">What changed in next version:</span>
                                                        <ul className="mt-1 space-y-0.5 text-slate-200">
                                                            {d.changed.map(([key, oldVal, newVal]) => (
                                                                <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="line-through text-red-400/90">{oldVal}</span> → <span className="text-emerald-400">{newVal}</span></li>
                                                            ))}
                                                            {d.added.map(([key, val]) => (
                                                                <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-emerald-400">added: {val}</span></li>
                                                            ))}
                                                            {d.removed.map(([key, val]) => (
                                                                <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-red-400/90">removed (was: {val})</span></li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                )}
                                                {entry.snapshot && Object.keys(thisFlat).length > 0 && (
                                                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                                                        {Object.entries(thisFlat).slice(0, 14).map(([key, val]) => (
                                                            <span key={key} className="flex gap-2">
                                                                <dt className="text-slate-500 shrink-0">{key.replace(/_/g, ' ')}:</dt>
                                                                <dd className="text-slate-300 truncate min-w-0">{String(val)}</dd>
                                                            </span>
                                                        ))}
                                                    </dl>
                                                )}
                                            </div>
                                        )
                                    })}
                                    {(!recordForHistory.version_history || recordForHistory.version_history.length === 0) && (
                                        <p className="text-slate-500 text-sm">No previous versions (record has not been updated since creation).</p>
                                    )}
                                </>
                            )
                        })()}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}
