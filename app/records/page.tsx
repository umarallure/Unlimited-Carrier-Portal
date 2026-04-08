'use client'

import { useState, useEffect, useMemo } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import Link from 'next/link'
import { FileText, Search, Loader2, Calendar, History } from 'lucide-react'
import {
  ActiveFilterChips,
  FilterBarHeader,
  FilterPresetChip,
  QuickDateRangeChips,
} from '@/components/filters/SmartFilters'
import { PageHeader } from '@/components/PageHeader'
import { toYmdLocal } from '@/lib/dateFilterPresets'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminDataGroupBar,
  adminInput,
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

export default function RecordsPage() {
    const [records, setRecords] = useState<any[]>([])
    const [carriers, setCarriers] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [searchTerm, setSearchTerm] = useState('')
    const [selectedCarrier, setSelectedCarrier] = useState<string>('all')
    const [selectedType, setSelectedType] = useState<string>('Policy')
    const [activityFrom, setActivityFrom] = useState<string>('')
    const [activityTo, setActivityTo] = useState<string>('')
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)

    const recordMatchesActivityRange = (record: any) => {
        if (!activityFrom && !activityTo) return true
        const ts = record.updated_at || record.created_at
        if (!ts) return false
        const d = new Date(ts)
        if (Number.isNaN(d.getTime())) return false
        if (activityFrom) {
            const start = new Date(activityFrom)
            start.setHours(0, 0, 0, 0)
            if (d < start) return false
        }
        if (activityTo) {
            const end = new Date(activityTo)
            end.setHours(23, 59, 59, 999)
            if (d > end) return false
        }
        return true
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
        if (!recordMatchesActivityRange(record)) return false
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
    }, [searchTerm, selectedCarrier, selectedType, activityFrom, activityTo])

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

    const recordsFilterCount = useMemo(() => {
        let n = 0
        if (searchTerm.trim()) n++
        if (selectedCarrier !== 'all') n++
        if (activityFrom || activityTo) n++
        return n
    }, [searchTerm, selectedCarrier, activityFrom, activityTo])

    const recordsActiveChips = useMemo(
        () => {
            const items: { key: string; label: string; onRemove: () => void }[] = []
            if (searchTerm.trim())
                items.push({
                    key: 'q',
                    label: `Search: ${searchTerm.trim()}`,
                    onRemove: () => setSearchTerm(''),
                })
            if (selectedCarrier !== 'all') {
                const name = carriers.find((c) => c.id === selectedCarrier)?.name ?? selectedCarrier
                items.push({
                    key: 'car',
                    label: `Carrier: ${name}`,
                    onRemove: () => setSelectedCarrier('all'),
                })
            }
            if (activityFrom || activityTo)
                items.push({
                    key: 'd',
                    label: `Activity: ${activityFrom || '…'} → ${activityTo || '…'}`,
                    onRemove: () => {
                        setActivityFrom('')
                        setActivityTo('')
                    },
                })
            return items
        },
        [searchTerm, selectedCarrier, activityFrom, activityTo, carriers]
    )

    const clearRecordFilters = () => {
        setSearchTerm('')
        setSelectedCarrier('all')
        setActivityFrom('')
        setActivityTo('')
    }

    const setTodayActivity = () => {
        const t = toYmdLocal(new Date())
        setActivityFrom(t)
        setActivityTo(t)
    }

    return (
        <div className="admin-page space-y-6">
            <PageHeader
                title="Records"
                description="View uploaded policy and commission records by type."
                icon={<FileText className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
            />

            {/* Type tabs: Policy, Commission, or Deal Tracker (each shows its own columns) */}
            <div className={cn(adminTypeTabsWrap, 'gap-1')}>
                {(['Policy', 'Commission', 'Deal Tracker'] as const).map((type) => (
                    <button
                        key={type}
                        type="button"
                        onClick={() => setSelectedType(type)}
                        className={cn(
                            'rounded-xl px-4 py-2 text-sm font-semibold transition-all',
                            selectedType === type ? adminTypeTabActive : adminTypeTabIdle
                        )}
                    >
                        {type}
                    </button>
                ))}
            </div>

            {/* Filters */}
            <Card>
                <CardHeader className={cn('space-y-3 pb-5', adminCardHeaderBar)}>
                <FilterBarHeader
                    title="Find raw rows"
                    description="Policy / commission rows are filtered by last activity (updated or created timestamp). Use quick ranges or exact from/to."
                    activeCount={recordsFilterCount}
                    onClearAll={recordsFilterCount ? clearRecordFilters : undefined}
                />
                </CardHeader>
                <CardContent className="space-y-4 pt-5">

                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 w-full text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:w-auto">
                        Jump to
                    </span>
                    <FilterPresetChip active={false} onClick={setTodayActivity} title="Created or updated today">
                        Today
                    </FilterPresetChip>
                    <FilterPresetChip
                        active={false}
                        onClick={() => {
                            const y = new Date()
                            y.setDate(y.getDate() - 1)
                            const s = toYmdLocal(y)
                            setActivityFrom(s)
                            setActivityTo(s)
                        }}
                        title="Yesterday only"
                    >
                        Yesterday
                    </FilterPresetChip>
                </div>

                <QuickDateRangeChips
                    dateFrom={activityFrom}
                    dateTo={activityTo}
                    onRangeChange={(f, t) => {
                        setActivityFrom(f)
                        setActivityTo(t)
                    }}
                />

                <div className="flex flex-wrap items-end gap-3">
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Activity from</span>
                        <div className="flex items-center gap-2">
                            <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                            <Input
                                type="date"
                                value={activityFrom}
                                onChange={(e) => setActivityFrom(e.target.value)}
                                className={cn(adminInput, 'h-9 w-[150px] text-sm [color-scheme:light] dark:[color-scheme:dark]')}
                                title="Include rows last touched on or after this date"
                            />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Activity to</span>
                        <div className="flex items-center gap-2">
                            <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                            <Input
                                type="date"
                                value={activityTo}
                                onChange={(e) => setActivityTo(e.target.value)}
                                className={cn(adminInput, 'h-9 w-[150px] text-sm [color-scheme:light] dark:[color-scheme:dark]')}
                                title="Include rows last touched on or before this date"
                            />
                        </div>
                    </div>
                </div>

                <ActiveFilterChips items={recordsActiveChips} />

                <div className="flex flex-wrap items-center gap-3">
                    <div className="relative max-w-xs min-w-[200px] flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Policy # or any column text…"
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className={cn(adminInput, 'h-9 pl-8 text-sm')}
                        />
                    </div>

                    <Select value={selectedCarrier} onValueChange={setSelectedCarrier}>
                        <SelectTrigger className={cn('h-9 w-[160px] shrink-0', adminSelectTrigger, 'text-sm')}>
                            <SelectValue placeholder="All Carriers" />
                        </SelectTrigger>
                        <SelectContent className={adminSelectContent}>
                            <SelectItem value="all" className={adminSelectItem}>All Carriers</SelectItem>
                            {carriers.map(carrier => (
                                <SelectItem key={carrier.id} value={carrier.id} className={adminSelectItem}>
                                    {carrier.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                        Showing {filteredRecords.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredRecords.length)} of {filteredRecords.length} records
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
                                <SelectItem value="250" className={adminSelectItem}>250</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                </CardContent>
            </Card>

            {/* Records Table */}
            <Card className="overflow-hidden p-0">
                <CardContent className="p-0">
                {loading ? (
                    <div className="flex items-center justify-center py-12">
                        <Loader2 className="h-9 w-9 animate-spin text-orange-400" />
                    </div>
                ) : filteredRecords.length === 0 ? (
                    <div className="py-8 text-center text-muted-foreground">
                        {searchTerm || selectedCarrier !== 'all' || activityFrom || activityTo
                            ? 'No records match your filters'
                            : 'No records found. Upload files to see data here.'}
                    </div>
                ) : (
                    <div className="divide-y divide-border dark:divide-slate-800">
                        {carrierGroups.map(({ carrierId, carrierName, records: groupRecords }) => {
                            const groupColumns = getColumnNames(groupRecords)
                            return (
                                <div key={carrierId} className="overflow-x-auto">
                                    <div className={cn(adminDataGroupBar, 'px-4 py-2')}>
                                        {carrierName}{' '}
                                        <span className="font-normal text-muted-foreground">({groupRecords.length} on this page)</span>
                                    </div>
                                    <Table>
                                        <TableHeader>
                                            <TableRow className="border-b border-border hover:bg-transparent dark:border-slate-800">
                                                <TableHead className={cn(adminThPlain, 'font-semibold')}>Policy #</TableHead>
                                                <TableHead className={cn(adminThPlain, 'font-semibold')}>Type</TableHead>
                                                {groupColumns.map(col => (
                                                    <TableHead key={col} className={cn(adminThPlain, 'font-semibold')}>{col}</TableHead>
                                                ))}
                                                <TableHead className={cn(adminThPlain, 'font-semibold')}>First added</TableHead>
                                                <TableHead className={cn(adminThPlain, 'font-semibold')}>Last updated</TableHead>
                                                <TableHead className={cn(adminThPlain, 'w-24 font-semibold')}>History</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {groupRecords.map((record) => (
                                                <TableRow key={record.id} className={adminTableRowInteractive}>
                                                    <TableCell className={cn(adminTdStrong, 'font-mono text-sm font-medium')}>
                                                        {record.policy_number}
                                                    </TableCell>
                                                    <TableCell>
                                                        <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs font-medium text-foreground dark:bg-slate-800 dark:text-slate-100">
                                                            {record.file_type}
                                                        </span>
                                                    </TableCell>
                                                    {groupColumns.map(col => (
                                                        <TableCell key={col} className={cn(adminTdMuted, 'text-sm')}>
                                                            {String(record.raw_data[col] ?? '–').substring(0, 40)}
                                                        </TableCell>
                                                    ))}
                                                    <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-sm')} title="When this record was first added">
                                                        {record.created_at ? new Date(record.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                                                    </TableCell>
                                                    <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-sm')} title="When this record was last updated">
                                                        {record.updated_at ? new Date(record.updated_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '–'}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Link
                                                            href={`/records/history?table=${encodeURIComponent(record.table)}&id=${encodeURIComponent(record.id)}`}
                                                            className="inline-flex items-center rounded-md px-2 py-1.5 text-sm text-orange-600 transition-colors hover:bg-muted hover:text-orange-700 dark:text-orange-400 dark:hover:bg-slate-800 dark:hover:text-orange-300"
                                                            title="View version history"
                                                        >
                                                            <History className="mr-1 h-4 w-4" />
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
                    <div className={cn('flex flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80', adminPaginationBar)}>
                        <div className="text-sm text-muted-foreground">
                            Page {currentPage} of {totalPages}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>
                                First
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>
                                Previous
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                                Next
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                                Last
                            </Button>
                        </div>
                    </div>
                )}
            </CardContent>
            </Card>

        </div>
    )
}
