'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import * as XLSX from 'xlsx'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'
import {
    FileText,
    Search,
    Loader2,
    RotateCcw,
    Download,
    History,
    FileSpreadsheet,
    DollarSign,
    User,
    Building2,
    Hash,
    Calendar,
    Tag,
    ScrollText,
    BadgeInfo,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    adminCardHeaderBar,
    adminCardTitle,
    adminInput,
    adminOutlineBtn,
    adminTableRowInteractive,
    adminTdMuted,
    adminTdStrong,
    adminThPlain,
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'

type InvStatusRow = {
    id: string
    batch_id: string
    agency_carrier_id: string | null
    carrier: string
    policy_number: string
    invoicing_status: string
    effective_date: string
    created_at: string
    week_of: string | null
    lead_value: number | null
}

type DealTrackerRow = {
    id: string
    name: string | null
    policy_number: string
    carrier: string
    sales_agent: string | null
    writing_number: string | null
    commission_type: string | null
    effective_date: string | null
    call_center: string | null
    phone_number: string | null
    policy_status: string | null
    carrier_status: string | null
    policy_type: string | null
    deal_value: number | null
    cc_value: number | null
    monthly_premium: number | null
    face_amount: number | null
}

type CommissionRow = {
    id: string
    date: string
    carrier: string
    policy_number: string
    name: string | null
    sales_agent: string | null
    commission_rate: number | null
    advance_amount: number | null
    charge_back_amount: number | null
}

const INVOICING_STATUS_LABELS: Record<string, string> = {
    new_sale: 'New Sale',
    'New Charge Back': 'New Charge Back',
    chargeback: 'Chargeback',
    repay: 'Repay',
    rechargeback: 'Re-chargeback',
    paid_delete: 'Paid Delete',
    cb_delete: 'CB Delete',
    cb_never_paid: 'CB Never Paid',
    cb_repay: 'CB Repay',
}

const INVOICING_STATUS_COLORS: Record<string, string> = {
    new_sale: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
    chargeback: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
    'New Charge Back': 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
    repay: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-300',
    rechargeback: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300',
    paid_delete: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
    cb_delete: 'border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300',
    cb_never_paid: 'border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300',
    cb_repay: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300',
}

function statusBadge(status: string) {
    const label = INVOICING_STATUS_LABELS[status] ?? status
    const color = INVOICING_STATUS_COLORS[status] ?? 'border-border text-muted-foreground'
    return (
        <Badge variant="outline" className={color}>
            {label}
        </Badge>
    )
}

function money(value: number | null | undefined): string {
    if (value == null || !Number.isFinite(value)) return '-'
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function DetailRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string | React.ReactNode }) {
    return (
        <div className="flex items-start gap-2.5 text-sm">
            <div className="mt-0.5 shrink-0 text-muted-foreground">{icon}</div>
            <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-medium text-foreground dark:text-slate-100">{value || '-'}</p>
            </div>
        </div>
    )
}

const iconClasses = 'h-4 w-4'

export default function InvoicingLedgerPage() {
    const supabase = createClient()
    const searchRef = useRef<HTMLInputElement>(null)

    const [searchTerm, setSearchTerm] = useState('')
    const [debouncedSearch, setDebouncedSearch] = useState('')
    const [loading, setLoading] = useState(false)
    const [searched, setSearched] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [invHistory, setInvHistory] = useState<InvStatusRow[]>([])
    const [dealTracker, setDealTracker] = useState<DealTrackerRow | null>(null)
    const [commissionHistory, setCommissionHistory] = useState<CommissionRow[]>([])

    useEffect(() => {
        const h = setTimeout(() => setDebouncedSearch(searchTerm), 300)
        return () => clearTimeout(h)
    }, [searchTerm])

    useEffect(() => {
        if (!debouncedSearch.trim()) return
        searchPolicy(debouncedSearch.trim())
    }, [debouncedSearch])

    const searchPolicy = async (term: string) => {
        setLoading(true)
        setError(null)
        setSearched(true)
        setInvHistory([])
        setDealTracker(null)
        setCommissionHistory([])

        try {
            const [invRes, dealRes, commRes] = await Promise.all([
                supabase
                    .from('invoicing_status_history')
                    .select('*')
                    .eq('policy_number', term)
                    .order('effective_date', { ascending: false }),
                supabase
                    .from('deal_tracker')
                    .select('*')
                    .eq('policy_number', term)
                    .order('effective_date', { ascending: false })
                    .limit(1)
                    .maybeSingle(),
                supabase
                    .from('commission_tracker')
                    .select('*')
                    .eq('policy_number', term)
                    .order('date', { ascending: false }),
            ])

            if (invRes.error) throw new Error(invRes.error.message)
            if (dealRes.error) throw new Error(dealRes.error.message)
            if (commRes.error) throw new Error(commRes.error.message)

            setInvHistory((invRes.data as InvStatusRow[]) || [])
            setDealTracker(dealRes.data as DealTrackerRow | null)
            setCommissionHistory((commRes.data as CommissionRow[]) || [])
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : 'Search failed.')
        } finally {
            setLoading(false)
        }
    }

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault()
        const term = searchRef.current?.value.trim() ?? ''
        if (!term) return
        setSearchTerm(term)
    }

    const handleClear = () => {
        setSearchTerm('')
        setDebouncedSearch('')
        setSearched(false)
        setInvHistory([])
        setDealTracker(null)
        setCommissionHistory([])
        setError(null)
        searchRef.current?.focus()
    }

    const hasResults = invHistory.length > 0 || dealTracker || commissionHistory.length > 0

    const exportExcel = () => {
        const wb = XLSX.utils.book_new()

        if (invHistory.length > 0) {
            const invData = invHistory.map((r) => ({
                'Effective Date': formatStoredDateForDisplay(r.effective_date) ?? r.effective_date,
                'Status': INVOICING_STATUS_LABELS[r.invoicing_status] ?? r.invoicing_status,
                'Week Of': r.week_of ?? '',
                'Lead Value': r.lead_value ?? '',
                'Carrier': r.carrier,
                'Policy Number': r.policy_number,
                'Created At': r.created_at ? new Date(r.created_at).toLocaleDateString() : '',
            }))
            const ws = XLSX.utils.json_to_sheet(invData)
            XLSX.utils.book_append_sheet(wb, ws, 'Invoicing History')
        }

        if (dealTracker) {
            const dealData = [{
                'Name': dealTracker.name ?? '',
                'Policy Number': dealTracker.policy_number,
                'Carrier': dealTracker.carrier,
                'Sales Agent': dealTracker.sales_agent ?? '',
                'Writing Number': dealTracker.writing_number ?? '',
                'Commission Type': dealTracker.commission_type ?? '',
                'Effective Date': dealTracker.effective_date ? formatStoredDateForDisplay(dealTracker.effective_date) ?? dealTracker.effective_date : '',
                'Call Center': dealTracker.call_center ?? '',
                'Policy Status': dealTracker.policy_status ?? '',
                'Carrier Status': dealTracker.carrier_status ?? '',
                'Policy Type': dealTracker.policy_type ?? '',
                'Deal Value': dealTracker.deal_value ?? '',
                'CC Value': dealTracker.cc_value ?? '',
                'Monthly Premium': dealTracker.monthly_premium ?? '',
                'Face Amount': dealTracker.face_amount ?? '',
            }]
            const ws = XLSX.utils.json_to_sheet(dealData)
            XLSX.utils.book_append_sheet(wb, ws, 'Policy Details')
        }

        if (commissionHistory.length > 0) {
            const commData = commissionHistory.map((r) => ({
                'Date': formatStoredDateForDisplay(r.date) ?? r.date,
                'Carrier': r.carrier,
                'Policy Number': r.policy_number,
                'Name': r.name ?? '',
                'Sales Agent': r.sales_agent ?? '',
                'Rate': r.commission_rate ?? '',
                'Advance Amount': r.advance_amount ?? '',
                'Charge Back Amount': r.charge_back_amount ?? '',
            }))
            const ws = XLSX.utils.json_to_sheet(commData)
            XLSX.utils.book_append_sheet(wb, ws, 'Commission History')
        }

        XLSX.writeFile(wb, `invoices-ledger-${debouncedSearch || 'export'}.xlsx`)
    }

    return (
        <div className="space-y-6">
            <PageHeader
                title="Invoices Ledger"
                description="Search for a policy number to view its complete invoicing status history, policy details, and commission records."
                icon={<ScrollText className="h-7 w-7 text-orange-500" />}
                action={
                    hasResults ? (
                        <Button variant="outline" size="sm" className={adminOutlineBtn} onClick={exportExcel}>
                            <Download className="mr-2 h-4 w-4" />
                            Export Excel
                        </Button>
                    ) : null
                }
            />

            <Card className="border-border dark:border-slate-800">
                <CardContent className="pt-6">
                    <form onSubmit={handleSearch} className="flex gap-3">
                        <div className="relative flex-1">
                            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                ref={searchRef}
                                type="text"
                                placeholder="Search by policy number..."
                                defaultValue={searchTerm}
                                className={cn('pl-10 pr-10', adminInput)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') handleSearch(e)
                                }}
                            />
                            {searchTerm && (
                                <button
                                    type="button"
                                    onClick={handleClear}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                >
                                    <RotateCcw className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                        <Button type="submit" disabled={loading}>
                            {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Search className="mr-2 h-4 w-4" />}
                            Search
                        </Button>
                    </form>
                </CardContent>
            </Card>

            {error && (
                <Card className="border-red-500/40 bg-red-500/5 dark:border-red-500/30 dark:bg-red-500/10">
                    <CardContent className="pt-6">
                        <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
                    </CardContent>
                </Card>
            )}

            {loading && (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                    <span className="ml-3 text-muted-foreground">Searching policy records...</span>
                </div>
            )}

            {!loading && searched && !hasResults && !error && (
                <Card className="border-border dark:border-slate-800">
                    <CardContent className="flex flex-col items-center gap-3 py-16">
                        <BadgeInfo className="h-12 w-12 text-muted-foreground/50" />
                        <p className="text-lg font-medium text-muted-foreground">No records found</p>
                        <p className="text-sm text-muted-foreground/70">
                            No invoicing history, policy details, or commission records match &quot;{debouncedSearch}&quot;
                        </p>
                    </CardContent>
                </Card>
            )}

            {hasResults && (
                <div className="space-y-6">
                    {dealTracker && (
                        <Card className="border-border dark:border-slate-800">
                            <CardHeader className={adminCardHeaderBar}>
                                <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
                                    <FileText className="h-5 w-5 text-orange-500" />
                                    Policy Details
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pt-6">
                                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                                    <DetailRow icon={<Hash className={iconClasses} />} label="Policy Number" value={dealTracker.policy_number} />
                                    <DetailRow icon={<Building2 className={iconClasses} />} label="Carrier" value={dealTracker.carrier} />
                                    <DetailRow icon={<User className={iconClasses} />} label="Insured Name" value={dealTracker.name} />
                                    <DetailRow icon={<User className={iconClasses} />} label="Sales Agent" value={dealTracker.sales_agent} />
                                    <DetailRow icon={<Tag className={iconClasses} />} label="Commission Type" value={dealTracker.commission_type} />
                                    <DetailRow icon={<Hash className={iconClasses} />} label="Writing Number" value={dealTracker.writing_number} />
                                    <DetailRow icon={<Calendar className={iconClasses} />} label="Effective Date" value={dealTracker.effective_date ? formatStoredDateForDisplay(dealTracker.effective_date) ?? dealTracker.effective_date : '-'} />
                                    <DetailRow icon={<Building2 className={iconClasses} />} label="Call Center" value={dealTracker.call_center} />
                                    <DetailRow icon={<BadgeInfo className={iconClasses} />} label="Policy Status" value={dealTracker.policy_status} />
                                    <DetailRow icon={<BadgeInfo className={iconClasses} />} label="Carrier Status" value={dealTracker.carrier_status} />
                                    <DetailRow icon={<FileSpreadsheet className={iconClasses} />} label="Policy Type" value={dealTracker.policy_type} />
                                    <DetailRow icon={<DollarSign className={iconClasses} />} label="Deal Value" value={money(dealTracker.deal_value)} />
                                    <DetailRow icon={<DollarSign className={iconClasses} />} label="CC Value" value={money(dealTracker.cc_value)} />
                                    <DetailRow icon={<DollarSign className={iconClasses} />} label="Monthly Premium" value={money(dealTracker.monthly_premium)} />
                                    <DetailRow icon={<DollarSign className={iconClasses} />} label="Face Amount" value={money(dealTracker.face_amount)} />
                                    <DetailRow icon={<Phone className={iconClasses} />} label="Phone Number" value={dealTracker.phone_number} />
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {invHistory.length > 0 && (
                        <Card className="border-border dark:border-slate-800">
                            <CardHeader className={adminCardHeaderBar}>
                                <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
                                    <History className="h-5 w-5 text-orange-500" />
                                    Invoicing Status History
                                    <span className="ml-auto text-sm font-normal text-muted-foreground">
                                        {invHistory.length} record{invHistory.length !== 1 ? 's' : ''}
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className={adminThPlain}>Effective Date</TableHead>
                                                <TableHead className={adminThPlain}>Status</TableHead>
                                                <TableHead className={adminThPlain}>Week Of</TableHead>
                                                <TableHead className={adminThPlain}>Lead Value</TableHead>
                                                <TableHead className={adminThPlain}>Carrier</TableHead>
                                                <TableHead className={adminThPlain}>Created At</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {invHistory.map((row) => (
                                                <TableRow key={row.id} className={adminTableRowInteractive}>
                                                    <TableCell className={adminTdStrong}>
                                                        {formatStoredDateForDisplay(row.effective_date) ?? row.effective_date}
                                                    </TableCell>
                                                    <TableCell>{statusBadge(row.invoicing_status)}</TableCell>
                                                    <TableCell className={adminTdMuted}>{row.week_of ?? '-'}</TableCell>
                                                    <TableCell className={adminTdStrong}>{money(row.lead_value)}</TableCell>
                                                    <TableCell className={adminTdMuted}>{row.carrier}</TableCell>
                                                    <TableCell className={adminTdMuted}>
                                                        {row.created_at ? new Date(row.created_at).toLocaleDateString() : '-'}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            </CardContent>
                        </Card>
                    )}

                    {commissionHistory.length > 0 && (
                        <Card className="border-border dark:border-slate-800">
                            <CardHeader className={adminCardHeaderBar}>
                                <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
                                    <DollarSign className="h-5 w-5 text-orange-500" />
                                    Commission History
                                    <span className="ml-auto text-sm font-normal text-muted-foreground">
                                        {commissionHistory.length} record{commissionHistory.length !== 1 ? 's' : ''}
                                    </span>
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead className={adminThPlain}>Date</TableHead>
                                                <TableHead className={adminThPlain}>Carrier</TableHead>
                                                <TableHead className={adminThPlain}>Name</TableHead>
                                                <TableHead className={adminThPlain}>Sales Agent</TableHead>
                                                <TableHead className={adminThPlain}>Rate</TableHead>
                                                <TableHead className={adminThPlain}>Advance Amount</TableHead>
                                                <TableHead className={adminThPlain}>Charge Back Amount</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {commissionHistory.map((row) => (
                                                <TableRow key={row.id} className={adminTableRowInteractive}>
                                                    <TableCell className={adminTdStrong}>
                                                        {formatStoredDateForDisplay(row.date) ?? row.date}
                                                    </TableCell>
                                                    <TableCell className={adminTdMuted}>{row.carrier}</TableCell>
                                                    <TableCell className={adminTdStrong}>{row.name ?? '-'}</TableCell>
                                                    <TableCell className={adminTdMuted}>{row.sales_agent ?? '-'}</TableCell>
                                                    <TableCell className={adminTdStrong}>
                                                        {row.commission_rate != null ? `${row.commission_rate}%` : '-'}
                                                    </TableCell>
                                                    <TableCell className={adminTdStrong}>{money(row.advance_amount)}</TableCell>
                                                    <TableCell className={cn(adminTdStrong, 'text-red-600 dark:text-red-400')}>
                                                        {money(row.charge_back_amount)}
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </div>
            )}
        </div>
    )
}

function Phone({ className }: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={className}
        >
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
        </svg>
    )
}
