'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileText, Search, Loader2, Filter } from 'lucide-react'

export default function RecordsPage() {
    const [records, setRecords] = useState<any[]>([])
    const [carriers, setCarriers] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [selectedCarrier, setSelectedCarrier] = useState<string>('all')
    const [selectedType, setSelectedType] = useState<string>('all')
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)

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
                                !['id', 'agency_carrier_id', 'file_id', 'row_number', 'created_at', 'updated_at', 'source_file', 'source_format', 'agency_carriers'].includes(k)
                            )
                        ),
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

    // Get all unique column names
    const getColumnNames = () => {
        if (records.length === 0) return []
        const allKeys = new Set<string>()
        records.forEach(record => {
            Object.keys(record.raw_data || {}).forEach(key => allKeys.add(key))
        })
        return Array.from(allKeys).slice(0, 8) // Show first 8 columns
    }

    const filteredRecords = records.filter(record => {
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
    }, [searchTerm, selectedCarrier, selectedType])

    const columns = getColumnNames()

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center space-x-4">
                <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                    <FileText className="w-6 h-6 text-orange-400" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold text-white">All Records</h1>
                    <p className="text-gray-400">View all uploaded policy and commission records</p>
                </div>
            </div>

            {/* Filters */}
            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {/* Search */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                        <Input
                            placeholder="Search by policy number..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
                        />
                    </div>

                    {/* Carrier Filter */}
                    <Select value={selectedCarrier} onValueChange={setSelectedCarrier}>
                        <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
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

                    {/* Type Filter */}
                    <Select value={selectedType} onValueChange={setSelectedType}>
                        <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                            <SelectValue placeholder="All Types" />
                        </SelectTrigger>
                        <SelectContent className="bg-slate-800 border-slate-700">
                            <SelectItem value="all" className="text-white focus:bg-slate-700">All Types</SelectItem>
                            <SelectItem value="Policy" className="text-white focus:bg-slate-700">Policy</SelectItem>
                            <SelectItem value="Commission" className="text-white focus:bg-slate-700">Commission</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <div className="mt-3 flex items-center justify-between text-sm text-slate-400">
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
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-8 h-8 animate-spin text-slate-300" />
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="text-center py-12 text-slate-400">
                        {searchTerm || selectedCarrier !== 'all' || selectedType !== 'all'
                            ? 'No records match your filters'
                            : 'No records found. Upload files to see data here.'}
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow className="border-b border-slate-800 hover:bg-transparent">
                                    <TableHead className="text-slate-300 font-semibold">Policy #</TableHead>
                                    <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                                    <TableHead className="text-slate-300 font-semibold">Type</TableHead>
                                    {columns.map(col => (
                                        <TableHead key={col} className="text-slate-300 font-semibold">{col}</TableHead>
                                    ))}
                                    <TableHead className="text-gray-300 font-semibold">Updated</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {paginatedRecords.map((record) => (
                                    <TableRow key={record.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors">
                                        <TableCell className="font-medium text-slate-100 font-mono text-sm">
                                            {record.policy_number}
                                        </TableCell>
                                        <TableCell className="text-slate-400">
                                            {record.agency_carriers?.carriers?.name || 'N/A'}
                                        </TableCell>
                                        <TableCell>
                                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${record.file_type === 'Policy'
                                                    ? 'bg-slate-800 text-slate-100'
                                                    : 'bg-slate-800 text-slate-100'
                                                }`}>
                                                {record.file_type}
                                            </span>
                                        </TableCell>
                                        {columns.map(col => (
                                            <TableCell key={col} className="text-slate-400 text-sm">
                                                {String(record.raw_data[col] || '-').substring(0, 40)}
                                            </TableCell>
                                        ))}
                                        <TableCell className="text-slate-400 text-sm">
                                            {new Date(record.updated_at).toLocaleDateString()}
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
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
