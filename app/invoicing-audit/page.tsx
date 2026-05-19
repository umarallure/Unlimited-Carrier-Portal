'use client'

import { useEffect, useMemo, useState } from 'react'
import * as XLSX from 'xlsx'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Calendar, FileSearch, FileStack, History, Loader2, RefreshCw, Search, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminFilterWell,
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
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'

type AuditStatus = 'matched' | 'no_deal_tracker' | 'no_policy'

type AuditRow = {
  submission_id: string | null
  date: string | null
  insured_name: string | null
  lead_vendor: string | null
  agent: string | null
  buffer_agent: string | null
  licensed_agent_account: string | null
  carrier: string | null
  product_type: string | null
  monthly_premium: number | null
  face_amount: number | null
  status: string | null
  call_result: string | null
  placement_status: string | null
  policy_number: string | null
  draft_date: string | null
  audit_status: AuditStatus
  audit_note: string
  dt_ghl_stage: string | null
  dt_carrier_status: string | null
  dt_cc_value: number | null
  dt_carrier: string | null
  dt_name: string | null
  dt_effective_date: string | null
}

type AuditSummary = {
  totalLeads: number
  withPolicy: number
  matched: number
  noDealTracker: number
  noPolicy: number
  distinctPolicies: number
  totalMonthlyPremium: number
  totalCcValue: number
  carriers: string[]
  leadVendors: string[]
}

type AuditResponse = {
  dateFrom: string
  dateTo: string
  leadVendor: string | null
  source: string
  summary: AuditSummary
  rows: AuditRow[]
}

const STATUS_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'matched', label: 'Matched' },
  { key: 'no_deal_tracker', label: 'No Deal Tracker' },
  { key: 'no_policy', label: 'No update from carrier yet' },
] as const

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function daysAgoISO(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function statusBadge(row: AuditRow) {
  if (row.audit_status === 'matched') {
    return (
      <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
        Matched
      </Badge>
    )
  }
  if (row.audit_status === 'no_deal_tracker') {
    return (
      <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">
        Not in Deal Tracker
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="border-border text-muted-foreground">
      No update from carrier yet
    </Badge>
  )
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string
  value: string
  hint?: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm dark:border-slate-800">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={cn('mt-1.5 text-2xl font-bold tracking-tight', accent || 'text-foreground')}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

export default function InvoicingAuditPage() {
  const [activeTab, setActiveTab] = useState<'audit' | 'drafts'>('audit')
  const [dateFrom, setDateFrom] = useState(daysAgoISO(14))
  const [dateTo, setDateTo] = useState(todayISO())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<AuditResponse | null>(null)

  const [leadVendor, setLeadVendor] = useState('all')
  const [vendorOptions, setVendorOptions] = useState<string[]>([])
  const [vendorLoading, setVendorLoading] = useState(false)
  const [vendorError, setVendorError] = useState<string | null>(null)

  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]['key']>('all')
  const [carrierFilter, setCarrierFilter] = useState('all')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(dateTo) && dateFrom <= dateTo

  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => clearTimeout(h)
  }, [searchTerm])

  // Load the call centers (lead vendors) that have leads in the chosen period,
  // so the audit can be scoped to one before it runs.
  useEffect(() => {
    if (!validRange) {
      setVendorOptions([])
      return
    }
    let cancelled = false
    const h = setTimeout(async () => {
      setVendorLoading(true)
      setVendorError(null)
      try {
        const res = await fetch(
          `/api/invoicing-audit?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`
        )
        const json = await res.json()
        if (!res.ok) throw new Error(json?.error || 'Failed to load call centers.')
        if (cancelled) return
        const vendors: string[] = Array.isArray(json?.leadVendors) ? json.leadVendors : []
        setVendorOptions(vendors)
        setLeadVendor((prev) => (prev !== 'all' && !vendors.includes(prev) ? 'all' : prev))
      } catch (err: unknown) {
        if (cancelled) return
        setVendorOptions([])
        setVendorError(err instanceof Error ? err.message : 'Failed to load call centers.')
      } finally {
        if (!cancelled) setVendorLoading(false)
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(h)
    }
  }, [dateFrom, dateTo, validRange])

  const runAudit = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/invoicing-audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom, dateTo, leadVendor }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Audit failed.')
      setResult(json as AuditResponse)
      setCurrentPage(1)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Audit failed.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const rows = useMemo(() => result?.rows ?? [], [result])

  const filteredRows = useMemo(() => {
    const term = debouncedSearch.trim().toLowerCase()
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.audit_status !== statusFilter) return false
      if (carrierFilter !== 'all' && r.carrier !== carrierFilter) return false
      if (term) {
        const hay = [
          r.insured_name,
          r.policy_number,
          r.carrier,
          r.agent,
          r.lead_vendor,
          r.product_type,
          r.dt_ghl_stage,
          r.dt_carrier_status,
          r.submission_id,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!hay.includes(term)) return false
      }
      return true
    })
  }, [rows, debouncedSearch, statusFilter, carrierFilter])

  useEffect(() => {
    setCurrentPage(1)
  }, [debouncedSearch, statusFilter, carrierFilter, pageSize])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const pageStart = filteredRows.length === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEndExclusive = Math.min(pageStart + pageSize, filteredRows.length)
  const paginatedRows = filteredRows.slice(pageStart, pageEndExclusive)

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const summary = result?.summary

  const exportExcel = () => {
    const headers = [
      'Date',
      'Insured Name',
      'Agent',
      'Carrier (DDF)',
      'Policy #',
      'GHL Stage',
      'Carrier Status',
      'Effective Date',
      'CC Value',
      'Audit Result',
    ]
    const data = filteredRows.map((r) => [
      r.date ?? '',
      r.insured_name ?? '',
      r.agent ?? '',
      r.carrier ?? '',
      r.policy_number ?? '',
      r.dt_ghl_stage ?? '',
      r.dt_carrier_status ?? '',
      r.dt_effective_date ?? '',
      r.dt_cc_value ?? '',
      r.audit_note,
    ])
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
    ws['!cols'] = [
      { wch: 12 }, { wch: 24 }, { wch: 20 }, { wch: 22 },
      { wch: 18 }, { wch: 24 }, { wch: 22 }, { wch: 14 },
      { wch: 12 }, { wch: 30 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Invoicing Audit')
    XLSX.writeFile(wb, `invoicing-audit-${dateFrom}_to_${dateTo}.xlsx`)
  }

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Invoicing Audit"
        description="Pull every Daily Deal Flow lead the call centers generated in an invoice period, then reconcile each policy against the accounting Deal Tracker (GHL stage, carrier status, CC value)."
        icon={<FileSearch className="h-7 w-7 text-orange-400" strokeWidth={2} />}
      />

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'audit' | 'drafts')}>
        <TabsList>
          <TabsTrigger value="audit">
            <FileSearch className="mr-1.5 h-3.5 w-3.5" />
            Audit
          </TabsTrigger>
          <TabsTrigger value="drafts">
            <FileStack className="mr-1.5 h-3.5 w-3.5" />
            Drafts
          </TabsTrigger>
        </TabsList>

        <TabsContent value="audit">
      <Card>
        <CardHeader className={cn('pb-5', adminCardHeaderBar)}>
          <CardTitle className={adminCardTitle}>Invoice period</CardTitle>
          <div className="mt-3 flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className={cn(adminInput, 'h-9 w-[180px]')}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className={cn(adminInput, 'h-9 w-[180px]')}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Call center (lead vendor)
              </span>
              <Select value={leadVendor} onValueChange={setLeadVendor} disabled={!validRange}>
                <SelectTrigger className={cn('h-9 w-[240px]', adminSelectTrigger)}>
                  <SelectValue
                    placeholder={vendorLoading ? 'Loading call centers…' : 'All call centers'}
                  />
                </SelectTrigger>
                <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                  <SelectItem value="all" className={adminSelectItem}>
                    All call centers
                  </SelectItem>
                  {vendorOptions.map((v) => (
                    <SelectItem key={v} value={v} className={adminSelectItem}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">
                {vendorLoading
                  ? 'Loading call centers in range…'
                  : vendorError
                    ? vendorError
                    : validRange
                      ? `${vendorOptions.length} call center${vendorOptions.length === 1 ? '' : 's'} in range`
                      : 'Pick a valid date range'}
              </span>
            </div>
            <Button
              onClick={runAudit}
              disabled={loading || !validRange}
              className="h-9 bg-blue-600 text-white hover:bg-blue-700"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Auditing…
                </>
              ) : (
                <>
                  <FileSearch className="mr-2 h-4 w-4" />
                  Run Audit
                </>
              )}
            </Button>
            {result ? (
              <Button onClick={exportExcel} variant="outline" className={cn(adminOutlineBtn, 'h-9')}>
                Export Excel
              </Button>
            ) : null}
          </div>
          {result?.source ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Source: <span className="font-mono">{result.source}</span> · audited{' '}
              {result.dateFrom} → {result.dateTo} · call center:{' '}
              <span className="font-medium text-foreground">
                {result.leadVendor || 'All'}
              </span>
            </p>
          ) : null}
          {error ? (
            <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
              {error}
            </p>
          ) : null}
        </CardHeader>

        {summary ? (
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <StatCard label="Leads in period" value={summary.totalLeads.toLocaleString()} />
              <StatCard
                label="With policy #"
                value={summary.withPolicy.toLocaleString()}
                hint={`${summary.distinctPolicies.toLocaleString()} distinct`}
              />
              <StatCard
                label="Matched"
                value={summary.matched.toLocaleString()}
                accent="text-emerald-600 dark:text-emerald-400"
              />
              <StatCard
                label="Not in Deal Tracker"
                value={summary.noDealTracker.toLocaleString()}
                accent="text-amber-600 dark:text-amber-400"
              />
              <StatCard label="No carrier update" value={summary.noPolicy.toLocaleString()} />
              <StatCard
                label="Total CC value"
                value={money(summary.totalCcValue)}
                hint={`Premium ${money(summary.totalMonthlyPremium)}`}
                accent="text-blue-600 dark:text-blue-400"
              />
            </div>

            <div className={cn('space-y-3 rounded-lg p-3', adminFilterWell)}>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-muted-foreground">Search</label>
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
                    <Input
                      placeholder="Name, policy #, carrier, agent, stage…"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className={cn(adminInput, 'pl-10')}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-muted-foreground">Carrier (DDF)</label>
                  <Select value={carrierFilter} onValueChange={setCarrierFilter}>
                    <SelectTrigger className={cn('h-10', adminSelectTrigger)}>
                      <SelectValue placeholder="All carriers" />
                    </SelectTrigger>
                    <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                      <SelectItem value="all" className={adminSelectItem}>
                        All carriers
                      </SelectItem>
                      {summary.carriers.map((c) => (
                        <SelectItem key={c} value={c} className={adminSelectItem}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {STATUS_FILTERS.map((s) => {
                  const active = statusFilter === s.key
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => setStatusFilter(s.key)}
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-xs transition-colors',
                        active
                          ? 'border-orange-500/40 bg-orange-500/15 text-foreground shadow-sm'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      )}
                    >
                      {s.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>
                Showing {filteredRows.length === 0 ? 0 : pageStart + 1}-{pageEndExclusive} of{' '}
                {filteredRows.length}
                {filteredRows.length !== rows.length ? ` (filtered from ${rows.length})` : ''}
              </span>
              <div className="flex items-center gap-2">
                <span>Rows per page:</span>
                <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
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

            <div className="overflow-x-auto rounded-md border border-border dark:border-slate-800">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border bg-muted/30 hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800 dark:bg-slate-900/40">
                    <TableHead className={cn(adminThPlain, 'min-w-[110px]')}>Date</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Insured Name</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Agent</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Carrier</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Policy #</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[200px]')}>GHL Stage</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Carrier Status</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[130px]')}>Effective Date</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[110px] text-right')}>CC Value</TableHead>
                    <TableHead className={cn(adminThPlain, 'min-w-[210px]')}>Audit Result</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center">
                        <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
                      </TableCell>
                    </TableRow>
                  ) : filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={10} className="py-10 text-center text-muted-foreground">
                        {rows.length === 0
                          ? 'No leads found for this period.'
                          : 'No rows match the current filters.'}
                      </TableCell>
                    </TableRow>
                  ) : (
                    paginatedRows.map((r, idx) => (
                      <TableRow key={`${r.submission_id ?? 'row'}-${idx}`} className={adminTableRowInteractive}>
                        <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-xs')}>
                          {r.date ? formatStoredDateForDisplay(r.date) : '-'}
                        </TableCell>
                        <TableCell className={cn(adminTdStrong, 'min-w-[180px]')}>
                          {r.insured_name || '-'}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[150px] truncate" title={r.agent || '-'}>
                            {r.agent || '-'}
                          </span>
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[150px] truncate" title={r.carrier || '-'}>
                            {r.carrier || '-'}
                          </span>
                        </TableCell>
                        <TableCell
                          className={cn(adminTdMuted, 'font-mono text-xs')}
                          title={r.dt_name ? `Deal Tracker: ${r.dt_name}` : undefined}
                        >
                          {r.policy_number || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className={adminTdMuted}>{r.dt_ghl_stage || '-'}</TableCell>
                        <TableCell className={adminTdMuted}>{r.dt_carrier_status || '-'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-xs')}>
                          {r.dt_effective_date ? formatStoredDateForDisplay(r.dt_effective_date) : '-'}
                        </TableCell>
                        <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                          {money(r.dt_cc_value)}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <div className="flex flex-col gap-1">
                            {statusBadge(r)}
                            {r.audit_status === 'no_policy' ? (
                              <span className="text-[11px] text-muted-foreground">No policy # on lead</span>
                            ) : null}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {filteredRows.length > 0 ? (
              <div
                className={cn(
                  'flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80',
                  adminPaginationBar
                )}
              >
                <div className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(1)}
                    disabled={currentPage === 1}
                    className={adminOutlineBtn}
                  >
                    First
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className={adminOutlineBtn}
                  >
                    Prev
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage === totalPages}
                    className={adminOutlineBtn}
                  >
                    Next
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage(totalPages)}
                    disabled={currentPage === totalPages}
                    className={adminOutlineBtn}
                  >
                    Last
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        ) : (
          <CardContent>
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
              <TrendingUp className="h-10 w-10 text-orange-400/70" />
              <p className="text-sm">
                Pick an invoice period and run the audit to reconcile call-center leads against the
                Deal Tracker.
              </p>
            </div>
          </CardContent>
        )}
      </Card>
        </TabsContent>

        <TabsContent value="drafts">
          <DraftsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

type DraftListItem = {
  id: string
  startDate: string | null
  endDate: string | null
  period: string
  callCenter: string
  updatedAt: string | null
  policyCount: number
}

type PaymentEvent = {
  batch_id: string
  paid_at: string | null
  period: string
  amount: number | null
  gross_amount: number | null
  status: string | null
}

type CommissionEvent = {
  date: string | null
  advance_amount: number | null
  charge_back_amount: number | null
  carrier: string | null
}

type PolicyAudit = {
  dt_ghl_stage: string | null
  dt_carrier_status: string | null
  dt_effective_date: string | null
  dt_cc_value: number | null
  dt_name: string | null
  payments: PaymentEvent[]
  payment_count: number
  total_paid: number
  last_paid_at: string | null
  commissions: CommissionEvent[]
}

type AuditedPolicy = {
  policy_number: string
  policy_name: string | null
  carrier: string | null
  call_center: string | null
  latest_invoicing_status: string | null
  gross_net: number | null
  cc_net: number | null
  audit: PolicyAudit
}

type AuditedGroup = {
  call_center: string
  gross_total: number
  cc_invoice_total: number
  policy_count: number
  policies: AuditedPolicy[]
}

type DraftDetail = {
  meta: { id: string; period: string; callCenter: string; updatedAt: string | null }
  groups: AuditedGroup[]
  grossGrandTotal: number
  ccGrandTotal: number
}

function formatPaidAt(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return formatStoredDateForDisplay(String(value).slice(0, 10))
  return formatStoredDateForDisplay(d.toISOString().slice(0, 10))
}

function DraftsTab() {
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<DraftListItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DraftDetail | null>(null)

  const loadList = async () => {
    setListLoading(true)
    setListError(null)
    try {
      const res = await fetch('/api/invoicing-audit/drafts')
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Failed to load saved drafts.')
      setDrafts((json.drafts ?? []) as DraftListItem[])
    } catch (err: unknown) {
      setListError(err instanceof Error ? err.message : 'Failed to load saved drafts.')
      setDrafts([])
    } finally {
      setListLoading(false)
    }
  }

  const loadDetail = async (id: string) => {
    if (!id) {
      setDetail(null)
      return
    }
    setDetailLoading(true)
    setDetailError(null)
    try {
      const res = await fetch(`/api/invoicing-audit/drafts?id=${encodeURIComponent(id)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || 'Failed to load the saved draft.')
      setDetail(json as DraftDetail)
    } catch (err: unknown) {
      setDetailError(err instanceof Error ? err.message : 'Failed to load the saved draft.')
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  // Load the picker list once the Drafts tab is opened (mounts on tab switch).
  useEffect(() => {
    void loadList()
  }, [])

  const onSelect = (id: string) => {
    setSelectedId(id)
    void loadDetail(id)
  }

  return (
    <Card>
      <CardHeader className={cn('pb-5', adminCardHeaderBar)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className={adminCardTitle}>Drafted invoices · status &amp; payment history</CardTitle>
          <Button
            onClick={() => void loadList()}
            disabled={listLoading}
            variant="outline"
            className={cn(adminOutlineBtn, 'h-9')}
          >
            {listLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh list
              </>
            )}
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Pick an invoice that was moved to draft on the Invoicing page. It loads exactly as saved
          (call-center groups &amp; totals); each policy row also shows its Deal Tracker status and
          full invoicing payment history.
        </p>
        {listError ? (
          <p className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {listError}
          </p>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">
        <div className={cn('rounded-lg p-3', adminFilterWell)}>
          <label className="block text-xs font-medium text-muted-foreground">Saved draft</label>
          <div className="mt-1.5">
            <Select value={selectedId} onValueChange={onSelect} disabled={listLoading}>
              <SelectTrigger className={cn('h-10 max-w-xl', adminSelectTrigger)}>
                <SelectValue
                  placeholder={
                    drafts.length === 0
                      ? listLoading
                        ? 'Loading saved drafts…'
                        : 'No saved drafts found'
                      : 'Select a saved draft to load…'
                  }
                />
              </SelectTrigger>
              <SelectContent className={cn(adminSelectContent, 'max-h-80')}>
                {drafts.map((d) => (
                  <SelectItem key={d.id} value={d.id} className={adminSelectItem}>
                    {d.period} · {d.callCenter} · {d.policyCount.toLocaleString()} policies
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {detailError ? (
          <p className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {detailError}
          </p>
        ) : null}

        {detailLoading ? (
          <div className="py-10 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
          </div>
        ) : !detail ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <FileStack className="mx-auto mb-2 h-8 w-8 opacity-40" />
            Select a saved draft above to view its full invoice with Deal Tracker status and payment
            history.
          </div>
        ) : detail.groups.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            This saved draft has no policies.
          </div>
        ) : (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
              <span className="font-semibold text-foreground">{detail.meta.period}</span>
              <span className="text-muted-foreground">{detail.meta.callCenter}</span>
              <span className="text-muted-foreground">
                Gross grand total:{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {money(detail.grossGrandTotal)}
                </span>
              </span>
              <span className="text-muted-foreground">
                CC grand total:{' '}
                <span className="font-medium tabular-nums text-foreground">
                  {money(detail.ccGrandTotal)}
                </span>
              </span>
            </div>

            {detail.groups.map((group) => (
              <div
                key={group.call_center}
                className="overflow-hidden rounded-md border border-border dark:border-slate-800"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/50">
                  <span className="text-sm font-semibold text-foreground">
                    {group.call_center}
                  </span>
                  <span className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                    <span>{group.policy_count.toLocaleString()} policies</span>
                    <span>
                      Gross:{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {money(group.gross_total)}
                      </span>
                    </span>
                    <span>
                      CC:{' '}
                      <span className="font-medium tabular-nums text-foreground">
                        {money(group.cc_invoice_total)}
                      </span>
                    </span>
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow className="border-b border-border bg-muted/20 hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800 dark:bg-slate-900/30">
                        <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Policy #</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Insured Name</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[140px]')}>Carrier</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Invoicing Status</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[100px] text-right')}>Gross</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[100px] text-right')}>CC</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>GHL Stage</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[170px]')}>Carrier Status</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[130px]')}>Effective Date</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[110px] text-right')}>CC Value</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[170px]')}>Commission Date</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[280px]')}>Payment History</TableHead>
                        <TableHead className={cn(adminThPlain, 'min-w-[120px] text-right')}>Total Paid</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.policies.map((p, idx) => (
                        <TableRow
                          key={`${p.policy_number}-${idx}`}
                          className={adminTableRowInteractive}
                        >
                          <TableCell className={cn(adminTdMuted, 'font-mono text-xs')}>
                            {p.policy_number || <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className={cn(adminTdStrong, 'min-w-[180px]')}>
                            {p.audit.dt_name || p.policy_name || '-'}
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            <span className="block max-w-[140px] truncate" title={p.carrier || '-'}>
                              {p.carrier || '-'}
                            </span>
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            {p.latest_invoicing_status || '-'}
                          </TableCell>
                          <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                            {money(p.gross_net)}
                          </TableCell>
                          <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                            {money(p.cc_net)}
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            {p.audit.dt_ghl_stage || '-'}
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            {p.audit.dt_carrier_status || '-'}
                          </TableCell>
                          <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-xs')}>
                            {p.audit.dt_effective_date
                              ? formatStoredDateForDisplay(p.audit.dt_effective_date)
                              : '-'}
                          </TableCell>
                          <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                            {money(p.audit.dt_cc_value)}
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            {p.audit.commissions.length === 0 ? (
                              <span className="text-xs text-muted-foreground">No commission received</span>
                            ) : (
                              <div className="flex flex-col gap-0.5">
                                {p.audit.commissions.map((c, i) => {
                                  const adv = c.advance_amount ?? 0
                                  const cb = c.charge_back_amount ?? 0
                                  const net = adv - cb
                                  const hasAmount = c.advance_amount != null || c.charge_back_amount != null
                                  return (
                                    <div
                                      key={`${c.date ?? 'no-date'}-${i}`}
                                      className="flex items-center gap-2 whitespace-nowrap text-xs"
                                    >
                                      <span>{c.date ? formatStoredDateForDisplay(c.date) : '—'}</span>
                                      <span
                                        className={cn(
                                          'tabular-nums',
                                          hasAmount && net < 0
                                            ? 'text-red-600 dark:text-red-400'
                                            : hasAmount
                                              ? 'text-emerald-600 dark:text-emerald-400'
                                              : 'text-muted-foreground'
                                        )}
                                      >
                                        {hasAmount ? money(net) : '—'}
                                      </span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className={adminTdMuted}>
                            {p.audit.payments.length === 0 ? (
                              <span className="text-xs text-muted-foreground">Never paid</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {p.audit.payments.map((pay, i) => (
                                  <div
                                    key={`${pay.batch_id}-${i}`}
                                    className="flex items-center gap-2 text-xs"
                                  >
                                    <History className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    <span className="whitespace-nowrap font-medium text-foreground">
                                      {formatPaidAt(pay.paid_at)}
                                    </span>
                                    <span className="tabular-nums">{money(pay.amount)}</span>
                                    {pay.status ? (
                                      <Badge
                                        variant="outline"
                                        className="border-border px-1.5 py-0 text-[10px] text-muted-foreground"
                                      >
                                        {pay.status}
                                      </Badge>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            )}
                          </TableCell>
                          <TableCell className={cn(adminTdStrong, 'text-right tabular-nums')}>
                            {p.audit.payments.length === 0 ? '-' : money(p.audit.total_paid)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
