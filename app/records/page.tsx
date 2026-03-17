'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from 'next/link'
import { FileText, Search, Loader2, Calendar, History } from 'lucide-react'

export default function RecordsPage() {
    const [records, setRecords] = useState<any[]>([])
    const [carriers, setCarriers] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [selectedCarrier, setSelectedCarrier] = useState<string>('all')
    const [selectedType, setSelectedType] = useState<string>('Policy')
    const [changedOnDate, setChangedOnDate] = useState<string>('') // YYYY-MM-DD or '' for no filter
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)

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
                { name: 'moh_policies', type: 'Policy', carrierCode: 'MOH' },
                { name: 'moh_commissions', type: 'Commission', carrierCode: 'MOH' },
                { name: 'corebridge_policies', type: 'Policy', carrierCode: 'COREBRIDGE' },
                { name: 'corebridge_commissions', type: 'Commission', carrierCode: 'COREBRIDGE' },
                { name: 'liberty_policies', type: 'Policy', carrierCode: 'LIBERTY' },
                { name: 'liberty_commissions', type: 'Commission', carrierCode: 'LIBERTY' },
                { name: 'rna_policies', type: 'Policy', carrierCode: 'RNA' },
                { name: 'rna_commissions', type: 'Commission', carrierCode: 'RNA' },
                { name: 'deal_tracker', type: 'Deal Tracker', carrierCode: 'DEAL_TRACKER' },
                // Aggregated commission entries across carriers; uses agency_carrier/carrier for the filter & grouping
                { name: 'commission_tracker', type: 'Commission', carrierCode: 'COMMISSION_TRACKER' },
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
                        table: table.name,
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
        const maxCols = 14
        return Object.entries(keyCount)
            .sort((a, b) => b[1] - a[1])
            .slice(0, maxCols)
            .map(([k]) => k)
    }

    const filteredRecords = records.filter(record => {
        // Apply type filter
        if (record.file_type !== selectedType) return false
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
                    <h1 className="text-3xl font-bold text-white">Records</h1>
                    <p className="text-gray-400">View uploaded policy and commission records by type</p>
                </div>
            </div>

            {/* Type tabs: Policy, Commission, or Deal Tracker (each shows its own columns) */}
            <div className="flex gap-1 p-1 bg-slate-900 rounded-xl border border-slate-800 w-fit">
                {(['Policy', 'Commission', 'Deal Tracker'] as const).map((type) => (
                    <button
                        key={type}
                        type="button"
                        onClick={() => setSelectedType(type)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            selectedType === type
                                ? 'bg-slate-700 text-white'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                        }`}
                    >
                        {type}
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
                        {searchTerm || selectedCarrier !== 'all' || changedOnDate
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
                                                        <Link
                                                            href={`/records/history?table=${encodeURIComponent(record.table)}&id=${encodeURIComponent(record.id)}`}
                                                            className="inline-flex items-center px-2 py-1.5 rounded-md text-orange-400 hover:text-orange-300 hover:bg-slate-800 text-sm transition-colors"
                                                            title="View version history"
                                                        >
                                                            <History className="w-4 h-4 mr-1" />
                                                            {record.version_history?.length ?? 0}
                                                        </Link>
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

        </div>
    )
}
