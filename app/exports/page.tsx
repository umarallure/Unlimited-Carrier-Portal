'use client'

import { useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MultiSelectFilter } from '@/components/filters/MultiSelectFilter'
import { ActiveFilterChips, FilterBarHeader, QuickDateRangeChips } from '@/components/filters/SmartFilters'
import { AlertTriangle, Download, Loader2, RefreshCw, Search, Sheet } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminDateInput,
  adminFilterWell,
  adminInputSm,
  adminOutlineBtn,
  adminPaginationShell,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import {
  ADVANCE_CHARGEBACK_HEADERS,
  buildAdvanceChargebackRows,
  exportFileName,
  rowToCsvValues,
  rowsToCsv,
  type ActivityFilter,
  type AdvanceChargebackRow,
  type CommissionTxn,
  type DateBasis,
  type DealInfo,
  type ReportContext,
  type ReportFilters,
} from '@/lib/commissionAdvanceChargebackReport'

const PAGE_SIZE_OPTIONS = [25, 50, 100, 250]

/** Preview tinting, keyed on the header so re-ordering columns cannot break it. */
const ADVANCE_COLUMNS = new Set<string>(['Advance', 'Advance 2', 'Total Advances'])
const CHARGEBACK_COLUMNS = new Set<string>(['Chargeback', 'Chargeback 2', 'Total Chargebacks'])
const TOTAL_COLUMNS = new Set<string>(['Total Advances', 'Total Chargebacks'])

const DATE_BASIS_LABELS: Record<DateBasis, string> = {
  any: 'Any advance or chargeback',
  advance: 'Advance date',
  chargeback: 'Chargeback date',
}

const ACTIVITY_LABELS: Record<ActivityFilter, string> = {
  all: 'All policies',
  with_chargeback: 'Has a chargeback',
  advance_only: 'Advance only (no chargeback)',
  chargeback_only: 'Chargeback only (no advance)',
}

/** Pull a whole table out in pages; PostgREST caps a single request at 1,000 rows. */
async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE - 1)
    if (error) throw new Error(`${table}: ${error.message}`)
    const chunk = (data ?? []) as unknown as T[]
    out.push(...chunk)
    if (chunk.length < PAGE) return out
  }
}

export default function ExportsPage() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [txns, setTxns] = useState<CommissionTxn[]>([])
  const [deals, setDeals] = useState<DealInfo[]>([])
  const [ctx, setCtx] = useState<ReportContext>({})

  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateBasis, setDateBasis] = useState<DateBasis>('any')
  const [carriers, setCarriers] = useState<string[]>([])
  const [callCenters, setCallCenters] = useState<string[]>([])
  const [salesAgents, setSalesAgents] = useState<string[]>([])
  const [agencies, setAgencies] = useState<string[]>([])
  const [productCodes, setProductCodes] = useState<string[]>([])
  const [policyStatuses, setPolicyStatuses] = useState<string[]>([])
  const [activity, setActivity] = useState<ActivityFilter>('all')
  const [search, setSearch] = useState('')

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const load = async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [commissionRows, dealRows, carrierRows, agencyCarrierRows] = await Promise.all([
        fetchAll<CommissionTxn>(
          'commission_tracker',
          'id, agency_carrier_id, policy_number, carrier, name, sales_agent, date, commission_rate, advance_amount, charge_back_amount'
        ),
        fetchAll<DealInfo>(
          'deal_tracker',
          'agency_carrier_id, policy_number, call_center, policy_type, policy_status, sales_agent, name, carrier, updated_at'
        ),
        supabase.from('carriers').select('name, code'),
        supabase.from('agency_carriers').select('id, agencies ( name )'),
      ])

      const carrierNameByCode = new Map<string, string>()
      const carrierNames: string[] = []
      for (const row of (carrierRows.data ?? []) as Array<{ name: string; code: string | null }>) {
        carrierNames.push(row.name)
        if (row.code) carrierNameByCode.set(row.code.toUpperCase(), row.name)
      }

      const agencyByAcId = new Map<string, string>()
      for (const row of (agencyCarrierRows.data ?? []) as Array<{ id: string; agencies?: { name?: string } | null }>) {
        const name = row.agencies?.name
        if (name) agencyByAcId.set(row.id, name)
      }

      setTxns(commissionRows)
      setDeals(dealRows)
      setCtx({ carrierNameByCode, carrierNames, agencyByAcId })
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : 'Could not load the commission data.')
      setTxns([])
      setDeals([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  // Built once per data load: the full unfiltered report, which is also what the
  // filter dropdowns offer, so every option listed actually returns rows.
  const allRows = useMemo(
    () => buildAdvanceChargebackRows(txns, deals, {}, ctx),
    [txns, deals, ctx]
  )

  const options = useMemo(() => {
    const collect = (pick: (row: AdvanceChargebackRow) => string) =>
      Array.from(new Set(allRows.map(pick).filter(Boolean))).sort((a, b) => a.localeCompare(b))
    return {
      carriers: collect((r) => r.carrier),
      callCenters: collect((r) => r.callCenter),
      salesAgents: collect((r) => r.salesAgent),
      agencies: collect((r) => r.agency),
      productCodes: collect((r) => r.productCode),
      policyStatuses: collect((r) => r.policyStatus),
    }
  }, [allRows])

  const filters: ReportFilters = useMemo(
    () => ({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      dateBasis,
      carriers,
      callCenters,
      salesAgents,
      agencies,
      productCodes,
      policyStatuses,
      activity,
      search,
    }),
    [dateFrom, dateTo, dateBasis, carriers, callCenters, salesAgents, agencies, productCodes, policyStatuses, activity, search]
  )

  const rows = useMemo(() => buildAdvanceChargebackRows(txns, deals, filters, ctx), [txns, deals, filters, ctx])

  const totals = useMemo(() => {
    let advance = 0
    let chargeback = 0
    let flagged = 0
    for (const row of rows) {
      advance += row.advanceTotal
      chargeback += row.chargebackTotal
      if (row.dataCheck) flagged += 1
    }
    return { advance, chargeback, net: advance + chargeback, flagged }
  }, [rows])

  useEffect(() => {
    setPage(1)
  }, [filters])

  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize)

  const activeCount = [
    dateFrom || dateTo,
    carriers.length,
    callCenters.length,
    salesAgents.length,
    agencies.length,
    productCodes.length,
    policyStatuses.length,
    activity !== 'all',
    search.trim(),
  ].filter(Boolean).length

  const resetAll = () => {
    setDateFrom('')
    setDateTo('')
    setDateBasis('any')
    setCarriers([])
    setCallCenters([])
    setSalesAgents([])
    setAgencies([])
    setProductCodes([])
    setPolicyStatuses([])
    setActivity('all')
    setSearch('')
  }

  const downloadCsv = () => {
    const csv = rowsToCsv(rows)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = exportFileName(filters)
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const money = (value: number) =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="Exports"
        icon={<Sheet className="h-6 w-6 text-orange-500" />}
        description={
          <>
            Build the commission advance &amp; chargeback report and download it as CSV in the exact column
            layout finance works in. Advances and chargebacks come from the commission tracker; product code
            and call center come from the deal tracker, matched on policy number.
          </>
        }
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className={adminOutlineBtn}>
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              Refresh
            </Button>
            <Button size="sm" onClick={downloadCsv} disabled={loading || rows.length === 0}>
              <Download className="mr-1.5 h-4 w-4" />
              Download CSV ({rows.length.toLocaleString()})
            </Button>
          </div>
        }
      />

      {loadError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{loadError}</span>
        </div>
      )}

      {/* ─── Filters ─── */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <FilterBarHeader
            title="Report filters"
            description="The date range decides which policies are included. Each policy still exports its full advance and chargeback history, so an old advance paired with a recent chargeback stays visible."
            activeCount={activeCount}
            onClearAll={resetAll}
          />
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          <div className={cn(adminFilterWell, 'space-y-4 p-4')}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={adminDateInput} />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={adminDateInput} />
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Range applies to</span>
                <Select value={dateBasis} onValueChange={(v) => setDateBasis(v as DateBasis)}>
                  <SelectTrigger className={adminSelectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={adminSelectContent}>
                    {(Object.keys(DATE_BASIS_LABELS) as DateBasis[]).map((key) => (
                      <SelectItem key={key} value={key} className={adminSelectItem}>
                        {DATE_BASIS_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="space-y-1.5">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Activity</span>
                <Select value={activity} onValueChange={(v) => setActivity(v as ActivityFilter)}>
                  <SelectTrigger className={adminSelectTrigger}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className={adminSelectContent}>
                    {(Object.keys(ACTIVITY_LABELS) as ActivityFilter[]).map((key) => (
                      <SelectItem key={key} value={key} className={adminSelectItem}>
                        {ACTIVITY_LABELS[key]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            </div>

            <QuickDateRangeChips
              dateFrom={dateFrom}
              dateTo={dateTo}
              onRangeChange={(from, to) => {
                setDateFrom(from)
                setDateTo(to)
              }}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Carrier</span>
              <MultiSelectFilter label="carrier" options={options.carriers} selected={carriers} onChange={setCarriers} allLabel="All carriers" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Call center</span>
              <MultiSelectFilter label="call center" options={options.callCenters} selected={callCenters} onChange={setCallCenters} allLabel="All call centers" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sales agent</span>
              <MultiSelectFilter label="agent" options={options.salesAgents} selected={salesAgents} onChange={setSalesAgents} allLabel="All agents" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Agency</span>
              <MultiSelectFilter label="agency" options={options.agencies} selected={agencies} onChange={setAgencies} allLabel="All agencies" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Product code</span>
              <MultiSelectFilter label="product code" options={options.productCodes} selected={productCodes} onChange={setProductCodes} allLabel="All products" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Policy status</span>
              <MultiSelectFilter label="policy status" options={options.policyStatuses} selected={policyStatuses} onChange={setPolicyStatuses} allLabel="All statuses" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Search</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Policy, customer, agent — or a comma-separated policy list"
                  className={cn(adminInputSm, 'pl-8')}
                />
              </div>
            </label>
          </div>

          <ActiveFilterChips
            items={[
              ...(dateFrom || dateTo
                ? [{
                    key: 'date-range',
                    label: `${DATE_BASIS_LABELS[dateBasis]}: ${dateFrom || '…'} → ${dateTo || '…'}`,
                    onRemove: () => {
                      setDateFrom('')
                      setDateTo('')
                    },
                  }]
                : []),
              ...(activity !== 'all' ? [{ key: 'activity', label: ACTIVITY_LABELS[activity], onRemove: () => setActivity('all') }] : []),
              ...carriers.map((v) => ({ key: `carrier:${v}`, label: `Carrier: ${v}`, onRemove: () => setCarriers(carriers.filter((c) => c !== v)) })),
              ...callCenters.map((v) => ({ key: `cc:${v}`, label: `Call center: ${v}`, onRemove: () => setCallCenters(callCenters.filter((c) => c !== v)) })),
              ...salesAgents.map((v) => ({ key: `agent:${v}`, label: `Agent: ${v}`, onRemove: () => setSalesAgents(salesAgents.filter((c) => c !== v)) })),
              ...agencies.map((v) => ({ key: `agency:${v}`, label: `Agency: ${v}`, onRemove: () => setAgencies(agencies.filter((c) => c !== v)) })),
              ...productCodes.map((v) => ({ key: `product:${v}`, label: `Product: ${v}`, onRemove: () => setProductCodes(productCodes.filter((c) => c !== v)) })),
              ...policyStatuses.map((v) => ({ key: `status:${v}`, label: `Status: ${v}`, onRemove: () => setPolicyStatuses(policyStatuses.filter((c) => c !== v)) })),
              ...(search.trim() ? [{ key: 'search', label: `Search: ${search.trim()}`, onRemove: () => setSearch('') }] : []),
            ]}
          />
        </CardContent>
      </Card>

      {/* ─── Preview ─── */}
      <Card>
        <CardHeader className={cn(adminCardHeaderBar, 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between')}>
          <CardTitle className={adminCardTitle}>Commission Advance &amp; Chargeback</CardTitle>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span><strong className="text-foreground dark:text-slate-100">{rows.length.toLocaleString()}</strong> policies</span>
            <span>Advances <strong className="text-emerald-600 dark:text-emerald-400">{money(totals.advance)}</strong></span>
            <span>Chargebacks <strong className="text-red-600 dark:text-red-400">{money(totals.chargeback)}</strong></span>
            <span>Net <strong className="text-foreground dark:text-slate-100">{money(totals.net)}</strong></span>
            {totals.flagged > 0 && (
              <span className="text-amber-600 dark:text-amber-400">{totals.flagged.toLocaleString()} with a data check</span>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading commission and deal tracker data…
            </div>
          ) : rows.length === 0 ? (
            <p className="py-16 text-center text-sm text-muted-foreground">
              No policies match these filters.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {ADVANCE_CHARGEBACK_HEADERS.map((header) => (
                        <TableHead key={header} className={cn(adminThPlain, 'whitespace-nowrap')}>
                          {header}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.map((row) => {
                      const values = rowToCsvValues(row)
                      return (
                        <TableRow key={row.key}>
                          {values.map((value, index) => {
                            const header = ADVANCE_CHARGEBACK_HEADERS[index]
                            return (
                              <TableCell
                                key={header}
                                className={cn(
                                  'whitespace-nowrap',
                                  header === 'Data Check' ? 'text-amber-600 dark:text-amber-400' : null,
                                  CHARGEBACK_COLUMNS.has(header) ? 'text-red-600 dark:text-red-400' : null,
                                  ADVANCE_COLUMNS.has(header) ? 'text-emerald-600 dark:text-emerald-400' : null,
                                  header === 'Customer Name' ? adminTdStrong : adminTdMuted,
                                  TOTAL_COLUMNS.has(header) ? 'font-semibold' : null
                                )}
                                title={header === 'Data Check' ? value : undefined}
                              >
                                {value || <span className="text-muted-foreground/40">—</span>}
                              </TableCell>
                            )
                          })}
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>

              <div className={cn(adminPaginationShell, 'mt-4 flex flex-wrap items-center justify-between gap-3')}>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Rows per page</span>
                  <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1) }}>
                    <SelectTrigger className={cn(adminSelectTrigger, 'h-8 w-20')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={adminSelectContent}>
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <SelectItem key={size} value={String(size)} className={adminSelectItem}>
                          {size}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Button variant="outline" size="sm" className={adminOutlineBtn} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                    Previous
                  </Button>
                  <span className="tabular-nums">Page {page} of {totalPages}</span>
                  <Button variant="outline" size="sm" className={adminOutlineBtn} disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
