'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  Clock,
  FileWarning,
  Loader2,
  RefreshCw,
  Search,
  StickyNote,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminDateInput,
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

// ─── Types ────────────────────────────────────────────────────────────────────

type AuditPolicyRow = {
  id: string
  name: string | null
  policy_number: string
  carrier: string | null
  ghl_stage: string | null
  effective_date: string | null
  deal_creation_date: string | null
  deal_value: number | null
  notes: string | null
  sales_agent: string | null
  call_center: string | null
  writing_number: string | null
  commission_type: string | null
  last_audited_at: string | null
  audit_count: number
  agency_carrier_id: string | null
}

type ReviewNote = {
  id: string
  policy_id?: string
  deal_tracker_id?: string
  note: string
  previous_ghl_stage: string | null
  next_ghl_stage: string | null
  reviewer_name: string | null
  created_at: string
}

type SortField = 'effective_date' | 'deal_creation_date' | 'sales_agent' | 'carrier' | 'name'

// ─── Constants ────────────────────────────────────────────────────────────────

const DECLINE_REASON_CATEGORIES = [
  'Client Request / Did Not Want',
  'Health Issue / Medical Decline',
  'Underwriting Decline',
  'Not Taken - No Payment',
  'Duplicate Policy',
  'Agent Error',
  'Other',
] as const


const DECLINED_STAGES = [
  'Declined Underwriting',
  'Application Withdrawn',
  'Pending Manual Action',
]

const CRM_STAGE_GROUPS = [
  {
    group: 'Transfer Portal',
    stages: [
      'Pending Approval', 'New Submission', 'Fulfilled Carrier Requirement',
      'Application Withdrawn', 'Declined Underwriting', 'Pending Manual Action',
      'Returned To Center - DQ', 'DQ\'d Can\'t be sold', 'GI DQ', 'Chargeback DQ',
      'Previously Sold BPO', 'Needs BPO Callback', 'Incomplete Transfer',
      'Pending Failed Payment Fix',
    ],
  },
  {
    group: 'Customer Pipeline',
    stages: [
      'Issued - Pending First Draft', 'Premium Paid - Commission Pending',
      'ACTIVE PLACED - Paid as Earned', 'ACTIVE PLACED - Paid as Advanced',
      'ACTIVE - 3 Months +', 'ACTIVE - 6 months +', 'ACTIVE - 9 months',
      'ACTIVE - Past Charge-Back Period',
    ],
  },
  {
    group: 'Chargeback Pipeline',
    stages: [
      'FDPF Pending Reason', 'FDPF Insufficient Funds', 'FDPF Incorrect Banking Info',
      'FDPF Unauthorized Draft', 'Pending Failed Payment Fix', 'Pending Lapse',
      'Chargeback Failed Payment', 'Chargeback Cancellation', 'Pending Chargeback Fix',
      'Chargeback Fixed',
    ],
  },
] as const

const ACTIVE_STAGES_NEEDING_COMMISSION = [
  'Active Placed - Paid as Advanced',
  'ACTIVE PLACED - Paid as Advanced',
  'Active Placed - Paid as Earned',
  'Premium Paid - Commission Pending',
]

const SELECT_FIELDS =
  'id, name, policy_number, carrier, ghl_stage, effective_date, deal_creation_date, deal_value, notes, sales_agent, call_center, writing_number, commission_type, last_audited_at, audit_count, agency_carrier_id'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function daysBetween(dateStr: string | null): number | null {
  if (!dateStr) return null
  const raw = String(dateStr).trim().slice(0, 10)
  const d = new Date(`${raw}T12:00:00`)
  if (isNaN(d.getTime())) return null
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  return Math.floor((today.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
}

// Any note ever = "audited at some point"
function hasAnyNotes(notes: ReviewNote[]): boolean {
  return notes.length > 0
}

function urgencyColor(days: number | null): string {
  if (days === null) return 'text-muted-foreground'
  if (days >= 14) return 'text-red-500 dark:text-red-400 font-semibold'
  if (days >= 7) return 'text-orange-500 dark:text-orange-400 font-medium'
  return 'text-foreground'
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return fallback
}

function ymdFromDate(dateStr: string | null): string {
  if (!dateStr) return ''
  return String(dateStr).trim().slice(0, 10)
}

function todayLabel(): string {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function NotesList({ notes }: { notes: ReviewNote[] }) {
  if (!notes || notes.length === 0) return <span className="text-xs text-muted-foreground">No notes yet</span>
  const latest = notes[0]
  return (
    <div className="text-xs">
      <p className="max-w-[220px] truncate font-medium text-foreground" title={latest.note}>{latest.note}</p>
      <p className="text-muted-foreground">
        {latest.reviewer_name ? `${latest.reviewer_name} · ` : ''}
        {formatStoredDateForDisplay(latest.created_at)}
      </p>
    </div>
  )
}

function DaysBadge({ days, label }: { days: number | null; label: string }) {
  if (days === null) return <span className="text-xs text-muted-foreground">—</span>
  const color =
    days >= 14
      ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
      : days >= 7
        ? 'border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400'
        : 'border-border bg-muted/50 text-foreground'
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap text-[11px]', color)}>
      {days}d {label}
    </Badge>
  )
}

function TabLoadingRow({ cols }: { cols: number }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-10 text-center">
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-orange-400" />
      </TableCell>
    </TableRow>
  )
}

function EmptyRow({ cols, message }: { cols: number; message: string }) {
  return (
    <TableRow>
      <TableCell colSpan={cols} className="py-10 text-center text-sm text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  )
}

// Simple multi-select dropdown used for carrier, agent, ghl stage filters
function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const visible = options.filter((o) => o.toLowerCase().includes(search.toLowerCase()))
  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((s) => s !== o) : [...selected, o])

  const displayLabel =
    selected.length === 0
      ? `All ${label}`
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`

  return (
    <div ref={ref} className="relative space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          adminSelectTrigger,
          'flex h-9 w-full items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors',
          open ? 'border-orange-500/60 ring-2 ring-orange-500/15' : 'hover:border-border/80'
        )}
      >
        <span className={cn('flex-1 truncate text-[13px]', selected.length === 0 && 'text-muted-foreground')}>
          {displayLabel}
        </span>
        {selected.length > 0 && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange([]) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); onChange([]) } }}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </span>
        )}
        <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+4px)] z-50 w-full min-w-[220px] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/20 dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-border/60 p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={`Search ${label.toLowerCase()}…`}
                className={cn(adminInput, 'h-7 pl-7 text-xs')}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px]">
              <button type="button" className="font-medium text-orange-400 hover:text-orange-300" onClick={() => onChange(visible)}>
                Select all
              </button>
              <button type="button" className="text-muted-foreground hover:text-foreground" onClick={() => onChange([])}>
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-56 overflow-auto p-1">
            {visible.map((opt) => {
              const active = selected.includes(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors',
                    active ? 'bg-orange-500/12 text-foreground' : 'text-foreground/85 hover:bg-muted/70'
                  )}
                >
                  <span className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                    active ? 'border-orange-500 bg-orange-500 text-white' : 'border-border bg-background text-transparent'
                  )}>
                    {active && <span className="text-[9px]">✓</span>}
                  </span>
                  <span className="truncate">{opt}</span>
                </button>
              )
            })}
            {visible.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No matches</p>}
          </div>
        </div>
      )}
    </div>
  )
}

// Sortable table header cell
function SortHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  field: SortField
  label: string
  sortField: SortField | null
  sortDir: 'asc' | 'desc'
  onSort: (f: SortField) => void
  className?: string
}) {
  const active = sortField === field
  return (
    <TableHead className={cn(adminThPlain, className)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className="inline-flex items-center gap-1 font-medium text-foreground transition-colors hover:text-orange-400"
      >
        {label}
        {active ? (
          <span className="text-orange-400">{sortDir === 'asc' ? '↑' : '↓'}</span>
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-30" />
        )}
      </button>
    </TableHead>
  )
}

// Pagination bar
function PaginationBar({
  currentPage,
  totalPages,
  pageSize,
  totalRows,
  filteredRows,
  onPage,
  onPageSize,
}: {
  currentPage: number
  totalPages: number
  pageSize: number
  totalRows: number
  filteredRows: number
  onPage: (p: number) => void
  onPageSize: (s: number) => void
}) {
  const pageStart = filteredRows === 0 ? 0 : (currentPage - 1) * pageSize + 1
  const pageEnd = Math.min(currentPage * pageSize, filteredRows)
  return (
    <div className={cn('flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80', adminPaginationBar, 'px-4 pb-4')}>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span>
          {pageStart}–{pageEnd} of {filteredRows}
          {filteredRows !== totalRows && ` (filtered from ${totalRows})`}
        </span>
        <div className="flex items-center gap-1.5">
          <span>Rows:</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger className={cn('h-7 w-16 text-xs', adminSelectTrigger)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={adminSelectContent}>
              {[25, 50, 100, 250].map((n) => (
                <SelectItem key={n} value={String(n)} className={adminSelectItem}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="outline" size="sm" className={cn(adminOutlineBtn, 'h-7 px-2 text-xs')} onClick={() => onPage(1)} disabled={currentPage === 1}>First</Button>
        <Button variant="outline" size="sm" className={cn(adminOutlineBtn, 'h-7 px-2 text-xs')} onClick={() => onPage(currentPage - 1)} disabled={currentPage === 1}>Prev</Button>
        <span className="min-w-[90px] text-center text-xs text-muted-foreground">
          Page {currentPage} of {totalPages}
        </span>
        <Button variant="outline" size="sm" className={cn(adminOutlineBtn, 'h-7 px-2 text-xs')} onClick={() => onPage(currentPage + 1)} disabled={currentPage === totalPages}>Next</Button>
        <Button variant="outline" size="sm" className={cn(adminOutlineBtn, 'h-7 px-2 text-xs')} onClick={() => onPage(totalPages)} disabled={currentPage === totalPages}>Last</Button>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PolicyAuditPage() {
  const [activeTab, setActiveTab] = useState('pending-approval')
  const [reviewerName, setReviewerName] = useState('')

  // Per-tab raw rows
  const [pendingRows, setPendingRows] = useState<AuditPolicyRow[]>([])
  const [declinedRows, setDeclinedRows] = useState<AuditPolicyRow[]>([])
  const [pastDraftRows, setPastDraftRows] = useState<AuditPolicyRow[]>([])
  const [missingCommRows, setMissingCommRows] = useState<AuditPolicyRow[]>([])
  const [earnedRows, setEarnedRows] = useState<AuditPolicyRow[]>([])
  const [advancedRows, setAdvancedRows] = useState<AuditPolicyRow[]>([])

  const [tabLoading, setTabLoading] = useState<Record<string, boolean>>({})
  const [loadedTabs, setLoadedTabs] = useState<Set<string>>(new Set())

  // Notes map: deal_tracker.id → notes[]
  const [notesByPolicyId, setNotesByPolicyId] = useState<Record<string, ReviewNote[]>>({})

  // ── Filters ──
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [effDateFrom, setEffDateFrom] = useState('')
  const [effDateTo, setEffDateTo] = useState('')
  const [creationDateFrom, setCreationDateFrom] = useState('')
  const [creationDateTo, setCreationDateTo] = useState('')
  const [filterCarriers, setFilterCarriers] = useState<string[]>([])
  const [filterAgents, setFilterAgents] = useState<string[]>([])
  const [filterAgencies, setFilterAgencies] = useState<string[]>([])
  const [filterGhlStages, setFilterGhlStages] = useState<string[]>([])
  const [auditStatusFilter, setAuditStatusFilter] = useState<'all' | 'audited' | 'not-audited'>('not-audited')
  const [agencyByAcId, setAgencyByAcId] = useState<Map<string, string>>(new Map())
  const [agencyOptions, setAgencyOptions] = useState<string[]>([])

  // ── Sort ──
  const [sortField, setSortField] = useState<SortField | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')

  // ── Pagination ──
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  // Dialog state
  const [dialogRow, setDialogRow] = useState<AuditPolicyRow | null>(null)
  const [dialogTab, setDialogTab] = useState<string>('')
  const [dialogNote, setDialogNote] = useState('')
  const [dialogNextStage, setDialogNextStage] = useState('')
  const [dialogReasonCategory, setDialogReasonCategory] = useState('')
  const [saving, setSaving] = useState(false)


  // ── Debounce search ──────────────────────────────────────────────────────────
  useEffect(() => {
    const h = setTimeout(() => setDebouncedSearch(searchTerm), 280)
    return () => clearTimeout(h)
  }, [searchTerm])

  // ── Data loaders ─────────────────────────────────────────────────────────────

  const fetchNotes = useCallback(async (rows: AuditPolicyRow[]): Promise<Record<string, ReviewNote[]>> => {
    if (rows.length === 0) return {}
    const ids = rows.map((r) => r.id)
    const allNotes: ReviewNote[] = []
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data } = await supabase
        .from('deal_tracker_review_notes')
        .select('id, policy_id, deal_tracker_id, note, previous_ghl_stage, next_ghl_stage, reviewer_name, created_at')
        .in('policy_id', chunk)
        .order('created_at', { ascending: false })
      if (data) allNotes.push(...(data as ReviewNote[]))
    }
    const grouped: Record<string, ReviewNote[]> = {}
    for (const n of allNotes) {
      const key = n.policy_id ?? n.deal_tracker_id
      if (!key) continue
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(n)
    }
    return grouped
  }, [])

  const loadPendingApproval = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .eq('ghl_stage', 'Pending Approval')
      .order('deal_creation_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const grouped = await fetchNotes(rows)
    setPendingRows(rows)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadDeclined = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .in('ghl_stage', DECLINED_STAGES)
      .order('effective_date', { ascending: false, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const grouped = await fetchNotes(rows)
    setDeclinedRows(rows)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadPastDraft = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .eq('ghl_stage', 'Issued - Pending First Draft')
      .order('effective_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const today = new Date().toISOString().slice(0, 10)
    const past = rows
      .filter((r) => r.effective_date && ymdFromDate(r.effective_date) < today)
      .sort((a, b) => (daysBetween(b.effective_date) ?? 0) - (daysBetween(a.effective_date) ?? 0))
    const grouped = await fetchNotes(past)
    setPastDraftRows(past)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadMissingCommission = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .in('ghl_stage', ACTIVE_STAGES_NEEDING_COMMISSION)
      .or('deal_value.is.null,deal_value.lte.0')
      .order('effective_date', { ascending: true, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const grouped = await fetchNotes(rows)
    setMissingCommRows(rows)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadPaidEarned = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .ilike('ghl_stage', '%paid as earned%')
      .order('effective_date', { ascending: false, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const grouped = await fetchNotes(rows)
    setEarnedRows(rows)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadPaidAdvanced = useCallback(async () => {
    const { data, error } = await supabase
      .from('deal_tracker').select(SELECT_FIELDS)
      .ilike('ghl_stage', '%paid as advanced%')
      .order('effective_date', { ascending: false, nullsFirst: false })
    if (error) throw error
    const rows = (data || []) as AuditPolicyRow[]
    const grouped = await fetchNotes(rows)
    setAdvancedRows(rows)
    setNotesByPolicyId((prev) => ({ ...prev, ...grouped }))
  }, [fetchNotes])

  const loadTab = useCallback(
    async (tab: string) => {
      setTabLoading((prev) => ({ ...prev, [tab]: true }))
      try {
        switch (tab) {
          case 'pending-approval': await loadPendingApproval(); break
          case 'declined': await loadDeclined(); break
          case 'past-draft': await loadPastDraft(); break
          case 'missing-commission': await loadMissingCommission(); break
          case 'paid-earned': await loadPaidEarned(); break
          case 'paid-advanced': await loadPaidAdvanced(); break
        }
        setLoadedTabs((prev) => new Set([...prev, tab]))
      } catch (err) {
        alert(extractErrorMessage(err, `Failed to load ${tab} data.`))
      } finally {
        setTabLoading((prev) => ({ ...prev, [tab]: false }))
      }
    },
    [loadPendingApproval, loadDeclined, loadPastDraft, loadMissingCommission, loadPaidEarned, loadPaidAdvanced]
  )

  useEffect(() => { loadTab('pending-approval') }, [loadTab])

  // Fetch agency_carriers mapping once on mount
  useEffect(() => {
    supabase
      .from('agency_carriers')
      .select('id, agencies ( name )')
      .order('created_at', { ascending: true })
      .then((result: { data: any; error: any }) => {
        const acMap = new Map<string, string>()
        const nameSet = new Set<string>()
        for (const row of (result.data || [])) {
          const name = row.agencies?.name as string | undefined
          if (name) {
            acMap.set(row.id as string, name)
            nameSet.add(name)
          }
        }
        setAgencyByAcId(acMap)
        setAgencyOptions(Array.from(nameSet).sort())
      })
      .catch(() => {})
  }, [])

  const handleTabChange = useCallback(
    (tab: string) => {
      setActiveTab(tab)
      setCurrentPage(1)
      if (!loadedTabs.has(tab)) loadTab(tab)
    },
    [loadedTabs, loadTab]
  )

  // ── Filter + sort derivation ─────────────────────────────────────────────────

  // Raw rows for current tab
  const currentTabRows = useMemo((): AuditPolicyRow[] => {
    switch (activeTab) {
      case 'pending-approval': return pendingRows
      case 'declined': return declinedRows
      case 'past-draft': return pastDraftRows
      case 'missing-commission': return missingCommRows
      case 'paid-earned': return earnedRows
      case 'paid-advanced': return advancedRows
      default: return []
    }
  }, [activeTab, pendingRows, declinedRows, pastDraftRows, missingCommRows, earnedRows, advancedRows])

  // All loaded rows (for filter option derivation)
  const allLoadedRows = useMemo(
    () => [...pendingRows, ...declinedRows, ...pastDraftRows, ...missingCommRows, ...earnedRows, ...advancedRows],
    [pendingRows, declinedRows, pastDraftRows, missingCommRows, earnedRows, advancedRows]
  )

  const carrierOptions = useMemo(
    () => Array.from(new Set(allLoadedRows.map((r) => r.carrier).filter(Boolean) as string[])).sort(),
    [allLoadedRows]
  )
  const agentOptions = useMemo(
    () => Array.from(new Set(allLoadedRows.map((r) => r.sales_agent).filter(Boolean) as string[])).sort(),
    [allLoadedRows]
  )
  const agencyFilterOptions = useMemo(
    () => Array.from(new Set(allLoadedRows.map((r) => agencyByAcId.get(r.agency_carrier_id ?? '')).filter(Boolean) as string[])).sort(),
    [allLoadedRows, agencyByAcId]
  )
  const ghlStageOptions = useMemo(
    () => Array.from(new Set(currentTabRows.map((r) => r.ghl_stage).filter(Boolean) as string[])).sort(),
    [currentTabRows]
  )

  // Filtered + sorted rows
  const filteredRows = useMemo(() => {
    let rows = [...currentTabRows]

    if (debouncedSearch) {
      const term = debouncedSearch.toLowerCase()
      rows = rows.filter((r) =>
        [r.name, r.policy_number, r.carrier, r.sales_agent, r.call_center, r.writing_number]
          .filter(Boolean).join(' ').toLowerCase().includes(term)
      )
    }
    if (filterCarriers.length > 0) {
      const s = new Set(filterCarriers)
      rows = rows.filter((r) => r.carrier && s.has(r.carrier))
    }
    if (filterAgents.length > 0) {
      const s = new Set(filterAgents)
      rows = rows.filter((r) => r.sales_agent && s.has(r.sales_agent))
    }
    if (filterAgencies.length > 0) {
      const s = new Set(filterAgencies)
      rows = rows.filter((r) => {
        const agency = agencyByAcId.get(r.agency_carrier_id ?? '')
        return !!agency && s.has(agency)
      })
    }
    if (filterGhlStages.length > 0) {
      const s = new Set(filterGhlStages)
      rows = rows.filter((r) => r.ghl_stage && s.has(r.ghl_stage))
    }
    if (effDateFrom) rows = rows.filter((r) => r.effective_date && ymdFromDate(r.effective_date) >= effDateFrom)
    if (effDateTo) rows = rows.filter((r) => r.effective_date && ymdFromDate(r.effective_date) <= effDateTo)
    if (creationDateFrom) rows = rows.filter((r) => r.deal_creation_date && ymdFromDate(r.deal_creation_date) >= creationDateFrom)
    if (creationDateTo) rows = rows.filter((r) => r.deal_creation_date && ymdFromDate(r.deal_creation_date) <= creationDateTo)

    if (auditStatusFilter === 'audited') {
      rows = rows.filter((r) => r.last_audited_at !== null)
    } else if (auditStatusFilter === 'not-audited') {
      rows = rows.filter((r) => r.last_audited_at === null)
    }

    if (sortField) {
      rows.sort((a, b) => {
        const av = (a[sortField] ?? '') as string
        const bv = (b[sortField] ?? '') as string
        if (!av && !bv) return 0
        if (!av) return 1
        if (!bv) return -1
        const cmp = av.localeCompare(bv)
        return sortDir === 'asc' ? cmp : -cmp
      })
    }

    return rows
  }, [
    currentTabRows, debouncedSearch, filterCarriers, filterAgents, filterAgencies, filterGhlStages, agencyByAcId,
    effDateFrom, effDateTo, creationDateFrom, creationDateTo, auditStatusFilter,
    sortField, sortDir, notesByPolicyId,
  ])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const paginatedRows = useMemo(
    () => filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [filteredRows, currentPage, pageSize]
  )

  // Reset page on filter/tab/sort change
  useEffect(() => { setCurrentPage(1) }, [
    activeTab, debouncedSearch, filterCarriers, filterAgents, filterAgencies, filterGhlStages,
    effDateFrom, effDateTo, creationDateFrom, creationDateTo, auditStatusFilter,
    sortField, sortDir, pageSize,
  ])

  // ── Daily audit stats (all loaded data) ─────────────────────────────────────
  const dailyStats = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10)
    const seen = new Set<string>()
    let auditedToday = 0
    let total = 0
    for (const row of allLoadedRows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      total++
      if (row.last_audited_at && row.last_audited_at.slice(0, 10) === todayStr) auditedToday++
    }
    return { auditedToday, total, remaining: total - auditedToday }
  }, [allLoadedRows])

  // Tab-level audited stats
  const tabStats = useMemo(() => {
    const todayStr = new Date().toISOString().slice(0, 10)
    let auditedEver = 0
    let auditedToday = 0
    let notAudited = 0
    for (const r of currentTabRows) {
      if (r.last_audited_at !== null) {
        auditedEver++
        if (r.last_audited_at.slice(0, 10) === todayStr) auditedToday++
      } else {
        notAudited++
      }
    }
    return { auditedEver, auditedToday, notAudited }
  }, [currentTabRows])

  // Advanced commission stats
  const advancedCommStats = useMemo(() => {
    let received = 0, missing = 0
    for (const r of advancedRows) {
      if (r.deal_value && r.deal_value > 0) received++; else missing++
    }
    return { received, missing }
  }, [advancedRows])

  // ── Sort handler ─────────────────────────────────────────────────────────────
  const handleSort = (field: SortField) => {
    if (sortField === field) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortField(field); setSortDir('asc') }
  }

  // ── Active filter count ──────────────────────────────────────────────────────
  const activeFilterCount =
    (debouncedSearch ? 1 : 0) +
    (filterCarriers.length ? 1 : 0) +
    (filterAgents.length ? 1 : 0) +
    (filterAgencies.length ? 1 : 0) +
    (filterGhlStages.length ? 1 : 0) +
    (effDateFrom || effDateTo ? 1 : 0) +
    (creationDateFrom || creationDateTo ? 1 : 0) +
    (auditStatusFilter !== 'all' ? 1 : 0)

  const clearFilters = () => {
    setSearchTerm('')
    setEffDateFrom('')
    setEffDateTo('')
    setCreationDateFrom('')
    setCreationDateTo('')
    setFilterCarriers([])
    setFilterAgents([])
    setFilterAgencies([])
    setFilterGhlStages([])
    setAuditStatusFilter('all')
  }

  // ── Dialog ───────────────────────────────────────────────────────────────────
  const openDialog = (row: AuditPolicyRow, tab: string) => {
    setDialogRow(row)
    setDialogTab(tab)
    setDialogNote('')
    setDialogNextStage('')
    setDialogReasonCategory('')
  }

  const closeDialog = () => {
    setDialogRow(null)
    setDialogNote('')
    setDialogNextStage('')
    setDialogReasonCategory('')
  }

  const saveReview = async () => {
    if (!dialogRow) return
    const noteBody = dialogNote.trim()
    const reasonPrefix = dialogReasonCategory ? `[${dialogReasonCategory}] ` : ''
    const fullNote = reasonPrefix + noteBody

    if (!fullNote && !dialogNextStage) {
      alert('Please add a note or select a stage before saving.')
      return
    }

    setSaving(true)
    try {
      const now = new Date().toISOString()
      const reviewer = reviewerName.trim() || null
      let reviewNoteId: string | null = null

      if (fullNote) {
        const { data: noteData, error: noteError } = await supabase
          .from('deal_tracker_review_notes')
          .insert({
            policy_id: dialogRow.id,
            note: fullNote,
            previous_ghl_stage: dialogRow.ghl_stage,
            next_ghl_stage: dialogNextStage || null,
            reviewer_name: reviewer,
            created_at: now,
          })
          .select('id')
          .single()
        if (noteError) throw new Error(noteError.message)
        reviewNoteId = noteData?.id != null ? String(noteData.id) : null

        // Immediately mark as audited in local state — no need to wait for reload
        const newNote: ReviewNote = {
          id: reviewNoteId ?? `tmp-${Date.now()}`,
          policy_id: dialogRow.id,
          note: fullNote,
          previous_ghl_stage: dialogRow.ghl_stage,
          next_ghl_stage: dialogNextStage || null,
          reviewer_name: reviewer,
          created_at: now,
        }
        setNotesByPolicyId((prev) => ({
          ...prev,
          [dialogRow.id]: [newNote, ...(prev[dialogRow.id] || [])],
        }))
        // Patch last_audited_at on the row itself so the filter uses the DB column, not notesByPolicyId
        const patchRow = (r: AuditPolicyRow) =>
          r.id === dialogRow.id ? { ...r, last_audited_at: now, audit_count: (r.audit_count ?? 0) + 1 } : r
        setPendingRows((prev) => prev.map(patchRow))
        setDeclinedRows((prev) => prev.map(patchRow))
        setPastDraftRows((prev) => prev.map(patchRow))
        setMissingCommRows((prev) => prev.map(patchRow))
        setEarnedRows((prev) => prev.map(patchRow))
        setAdvancedRows((prev) => prev.map(patchRow))
      }

      if (dialogNextStage && dialogNextStage !== dialogRow.ghl_stage) {
        // Update both INSURVAS CRM (stage + stage_id + pipeline_id) and deal_tracker.ghl_stage
        await fetch('/api/review-policies/update-crm-stage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            policyNumber: dialogRow.policy_number,
            newStage: dialogNextStage,
            note: fullNote || undefined,
            dealTrackerId: dialogRow.id,
          }),
        }).catch(() => {})
      } else {
        // No stage change — just sync the note to CRM lead_notes
        if (fullNote && reviewNoteId) {
          await fetch('/api/review-policies/sync-lead-note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ policyNumber: dialogRow.policy_number, note: fullNote, dealTrackerReviewNoteId: reviewNoteId }),
          }).catch(() => {})
        }
        // Update deal_tracker: append to notes text
        if (fullNote) {
          const stamp = new Date().toLocaleDateString('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
          const entry = `[Audit ${stamp}] ${reviewer || 'Unknown'}: ${fullNote}`
          const appendedNotes = dialogRow.notes ? `${dialogRow.notes}\n\n${entry}` : entry
          await supabase.from('deal_tracker').update({ updated_at: now, last_updated: now, notes: appendedNotes } as never).eq('id', dialogRow.id)
        }
      }

      // Stamp audit tracking on every save (note or stage change)
      if (fullNote || dialogNextStage) {
        await supabase.from('deal_tracker')
          .update({ last_audited_at: now, audit_count: (dialogRow.audit_count ?? 0) + 1 } as never)
          .eq('id', dialogRow.id)
      }

      closeDialog()
      await loadTab(activeTab)
    } catch (err) {
      alert(extractErrorMessage(err, 'Failed to save review.'))
    } finally {
      setSaving(false)
    }
  }

  // ── Shared table cell helpers ─────────────────────────────────────────────────
  function renderPolicyInfo(row: AuditPolicyRow) {
    return (
      <>
        <TableCell className={adminTdStrong}>{row.name || '—'}</TableCell>
        <TableCell className={cn(adminTdMuted, 'font-mono text-xs')}>{row.policy_number}</TableCell>
        <TableCell className={adminTdMuted}>{row.carrier || '—'}</TableCell>
        <TableCell className={adminTdMuted}>{row.sales_agent || '—'}</TableCell>
      </>
    )
  }
  function renderEffDate(row: AuditPolicyRow) {
    return (
      <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-xs')}>
        {row.effective_date ? formatStoredDateForDisplay(row.effective_date) : '—'}
      </TableCell>
    )
  }
  function renderActionBtn(row: AuditPolicyRow, tab: string, label = 'Review') {
    return (
      <TableCell className="text-right">
        <Button size="sm" variant="outline" className={adminOutlineBtn}
          onClick={(e) => { e.stopPropagation(); openDialog(row, tab) }}>
          {label}
        </Button>
      </TableCell>
    )
  }

  const isLoading = (tab: string) => !!tabLoading[tab]

  // ── Shared sort headers props ────────────────────────────────────────────────
  const sharedSortProps = { sortField, sortDir, onSort: handleSort }

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="admin-page space-y-5">
      <PageHeader
        title="Policy Audit"
        description="Daily audit across all GHL stages — pending review, declined cases, FDPF checks, missing commissions, and active placements."
        icon={<AlertTriangle className="h-7 w-7 text-orange-400" strokeWidth={2} />}
      />

      {/* ── Daily stats bar ── */}
      <div className="rounded-xl border border-border bg-muted/25 px-4 py-3 dark:border-slate-800 dark:bg-slate-950/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Daily Audit — {todayLabel()}</p>
            <p className="mt-1 text-xs text-muted-foreground">Counts across all loaded tabs</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/8 px-3 py-2 text-center">
              <p className="text-xl font-bold text-emerald-600 dark:text-emerald-400">{dailyStats.auditedToday}</p>
              <p className="text-[11px] text-emerald-700 dark:text-emerald-500">Audited Today</p>
            </div>
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-center">
              <p className="text-xl font-bold text-amber-600 dark:text-amber-400">{dailyStats.remaining}</p>
              <p className="text-[11px] text-amber-700 dark:text-amber-500">Remaining</p>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-center dark:border-slate-800">
              <p className="text-xl font-bold text-foreground">{dailyStats.total}</p>
              <p className="text-[11px] text-muted-foreground">Total in Scope</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── Reviewer + refresh ── */}
      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Reviewer name (optional)"
          value={reviewerName}
          onChange={(e) => setReviewerName(e.target.value)}
          className={cn(adminInput, 'w-52')}
        />
        <Button variant="outline" className={adminOutlineBtn} onClick={() => loadTab(activeTab)} disabled={isLoading(activeTab)}>
          <RefreshCw className={cn('mr-2 h-4 w-4', isLoading(activeTab) && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        {/* ── Tab triggers ── */}
        <TabsList className="h-auto flex-wrap gap-1 p-1">
          {(
            [
              { value: 'pending-approval', label: 'Pending Approval', count: pendingRows.length, color: 'amber' },
              { value: 'declined', label: 'Declined / Withdrawn', count: declinedRows.length, color: 'slate' },
              { value: 'past-draft', label: 'Past Draft Date', count: pastDraftRows.length, color: 'orange' },
              { value: 'missing-commission', label: 'Missing Commission', count: missingCommRows.length, color: 'red' },
              { value: 'paid-earned', label: 'Paid as Earned', count: earnedRows.length, color: 'blue' },
              { value: 'paid-advanced', label: 'Paid as Advanced', count: advancedRows.length, color: 'emerald' },
            ] as const
          ).map(({ value, label, count, color }) => (
            <TabsTrigger key={value} value={value} className="gap-1.5">
              {label}
              {count > 0 && (
                <span className={cn(
                  'ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                  color === 'amber' && 'bg-amber-500/20 text-amber-600 dark:text-amber-400',
                  color === 'slate' && 'bg-slate-500/20 text-slate-600 dark:text-slate-400',
                  color === 'orange' && 'bg-orange-500/20 text-orange-600 dark:text-orange-400',
                  color === 'red' && 'bg-red-500/20 text-red-600 dark:text-red-400',
                  color === 'blue' && 'bg-blue-500/20 text-blue-600 dark:text-blue-400',
                  color === 'emerald' && 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400',
                )}>
                  {count}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── Shared filter bar (below triggers, above all tab content) ── */}
        <div className={cn('mt-3 space-y-3 rounded-xl p-4', adminFilterWell)}>
          {/* Row 1: search + audit status */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filters</p>
            <div className="flex items-center gap-2">
              {/* Audited today filter */}
              <div className="flex items-center rounded-lg border border-border bg-background overflow-hidden dark:border-slate-800 dark:bg-slate-950">
                {(
                  [
                    { v: 'all', label: 'All' },
                    { v: 'not-audited', label: 'Not Audited' },
                    { v: 'audited', label: 'Audited (has notes)' },
                  ] as const
                ).map(({ v, label }) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setAuditStatusFilter(v)}
                    className={cn(
                      'px-3 py-1.5 text-xs font-medium transition-colors',
                      auditStatusFilter === v
                        ? 'bg-orange-500/15 text-orange-700 dark:text-orange-300'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {activeFilterCount > 0 && (
                <button type="button" onClick={clearFilters} className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground">
                  <X className="h-3 w-3" />
                  Clear all ({activeFilterCount})
                </button>
              )}
            </div>
          </div>

          {/* Row 2: search + carrier + agent + ghl stage */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Search</label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Name, policy #, agent, carrier…"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className={cn(adminInput, 'h-9 pl-8')}
                />
                {searchTerm && (
                  <button type="button" onClick={() => setSearchTerm('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
            <MultiSelectDropdown label="Carrier" options={carrierOptions} selected={filterCarriers} onChange={setFilterCarriers} />
            <MultiSelectDropdown label="Agent" options={agentOptions} selected={filterAgents} onChange={setFilterAgents} />
            <MultiSelectDropdown label="Agency" options={agencyFilterOptions} selected={filterAgencies} onChange={setFilterAgencies} />
            <MultiSelectDropdown label="GHL Stage" options={ghlStageOptions} selected={filterGhlStages} onChange={setFilterGhlStages} />
          </div>

          {/* Row 3: date ranges */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Effective Date — From</label>
              <input type="date" value={effDateFrom} onChange={(e) => setEffDateFrom(e.target.value)} className={cn(adminDateInput, 'h-9 w-full')} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Effective Date — To</label>
              <input type="date" value={effDateTo} onChange={(e) => setEffDateTo(e.target.value)} className={cn(adminDateInput, 'h-9 w-full')} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Deal Creation — From</label>
              <input type="date" value={creationDateFrom} onChange={(e) => setCreationDateFrom(e.target.value)} className={cn(adminDateInput, 'h-9 w-full')} />
            </div>
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">Deal Creation — To</label>
              <input type="date" value={creationDateTo} onChange={(e) => setCreationDateTo(e.target.value)} className={cn(adminDateInput, 'h-9 w-full')} />
            </div>
          </div>

          {/* Row 4: per-tab quick filters for declined stages */}
          {activeTab === 'declined' && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Declined Stage Quick-filter</p>
              <div className="flex flex-wrap gap-1.5">
                {DECLINED_STAGES.map((stage) => {
                  const active = filterGhlStages.includes(stage)
                  const count = declinedRows.filter((r) => r.ghl_stage === stage).length
                  return (
                    <button
                      key={stage}
                      type="button"
                      onClick={() =>
                        setFilterGhlStages((prev) =>
                          prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
                        )
                      }
                      className={cn(
                        'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                        active
                          ? 'border-orange-500/40 bg-orange-500/15 text-foreground shadow-sm'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                      )}
                    >
                      {stage}
                      <span className="ml-1.5 text-[10px] opacity-70">({count})</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* ── Tab 1: Pending Approval ── */}
        <TabsContent value="pending-approval">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Pending Approval
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {filteredRows.length} of {pendingRows.length}
                  </span>
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px]">
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Audited: {tabStats.auditedEver}
                  </Badge>
                  <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400 text-[11px]">
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Reviewed Today: {tabStats.auditedToday}
                  </Badge>
                  <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[11px]">
                    <Clock className="mr-1 h-3 w-3" /> Not Audited: {tabStats.notAudited}
                  </Badge>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Review each pending approval daily. Oldest first = most urgent. Default view shows only unaudited policies.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <TableHead className={cn(adminThPlain, 'w-[110px]')}>Status</TableHead>
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Call Center</TableHead>
                      <SortHeader field="effective_date" label="Effective Date" {...sharedSortProps} />
                      <SortHeader field="deal_creation_date" label="Days Pending" {...sharedSortProps} />
                      <TableHead className={cn(adminThPlain, 'min-w-[200px]')}>Last Note</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[150px] text-right')}>Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('pending-approval') ? <TabLoadingRow cols={10} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={10} message="No policies match the current filters." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          const todayStr = new Date().toISOString().slice(0, 10)
                          const reviewedToday = row.last_audited_at !== null && row.last_audited_at.slice(0, 10) === todayStr
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'pending-approval')}>
                              <TableCell className={adminTdMuted}>
                                <Badge variant="outline" className={cn('whitespace-nowrap text-[11px]',
                                  reviewedToday ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                    : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400')}>
                                  {reviewedToday ? 'Reviewed' : 'Needs Review'}
                                </Badge>
                              </TableCell>
                              {renderPolicyInfo(row)}
                              <TableCell className={adminTdMuted}>{row.call_center || '—'}</TableCell>
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}><DaysBadge days={daysBetween(row.deal_creation_date)} label="pending" /></TableCell>
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              <TableCell className="text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <Button size="sm" variant="outline" className={adminOutlineBtn}
                                    onClick={(e) => { e.stopPropagation(); openDialog(row, 'pending-approval') }}>
                                    Review
                                  </Button>
                                </div>
                              </TableCell>
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={pendingRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 2: Declined / Withdrawn / Manual ── */}
        <TabsContent value="declined">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Declined / Withdrawn / Manual Action
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{filteredRows.length} of {declinedRows.length}</span>
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px]">
                    Reason Added: {tabStats.auditedEver}
                  </Badge>
                  <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300 text-[11px]">
                    No Reason Yet: {tabStats.notAudited}
                  </Badge>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Document the reason for every declined or withdrawn policy. Default view shows only policies without a reason note.</p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <TableHead className={cn(adminThPlain, 'min-w-[170px]')}>GHL Stage</TableHead>
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <SortHeader field="effective_date" label="Effective Date" {...sharedSortProps} />
                      <TableHead className={cn(adminThPlain, 'min-w-[220px]')}>Last Note / Reason</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[100px] text-right')}>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('declined') ? <TabLoadingRow cols={8} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={8} message="No policies match the current filters." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          const stageColor =
                            row.ghl_stage === 'Declined Underwriting' ? 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400'
                              : row.ghl_stage === 'Application Withdrawn' ? 'border-slate-500/30 bg-slate-500/10 text-slate-600 dark:text-slate-300'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'declined')}>
                              <TableCell className={adminTdMuted}>
                                <Badge variant="outline" className={cn('whitespace-nowrap text-[11px]', stageColor)}>{row.ghl_stage}</Badge>
                              </TableCell>
                              {renderPolicyInfo(row)}
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              {renderActionBtn(row, 'declined', 'Add Reason')}
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={declinedRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 3: Past Draft Date ── */}
        <TabsContent value="past-draft">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Issued — Past Draft Date
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{filteredRows.length} of {pastDraftRows.length}</span>
                </CardTitle>
                {pastDraftRows.length > 0 && (
                  <Badge variant="outline" className="border-orange-500/30 bg-orange-500/10 text-orange-600 dark:text-orange-400 text-[11px]">
                    <FileWarning className="mr-1 h-3 w-3" /> {pastDraftRows.length} need FDPF check
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                "Issued - Pending First Draft" policies whose draft date has passed — move to the correct FDPF stage with a reason.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Call Center</TableHead>
                      <SortHeader field="effective_date" label="Draft / Eff. Date" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Days Past Draft</TableHead>
                      <TableHead className={cn(adminThPlain, 'min-w-[200px]')}>Last Note</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[100px] text-right')}>FDPF Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('past-draft') ? <TabLoadingRow cols={9} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={9} message="No issued policies past their draft date." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'past-draft')}>
                              {renderPolicyInfo(row)}
                              <TableCell className={adminTdMuted}>{row.call_center || '—'}</TableCell>
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}><DaysBadge days={daysBetween(row.effective_date)} label="past" /></TableCell>
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              {renderActionBtn(row, 'past-draft', 'Set FDPF')}
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={pastDraftRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 4: Missing Commission ── */}
        <TabsContent value="missing-commission">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Issued — Missing Commission
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{filteredRows.length} of {missingCommRows.length}</span>
                </CardTitle>
                {missingCommRows.length > 0 && (
                  <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-[11px]">
                    <AlertTriangle className="mr-1 h-3 w-3" /> {missingCommRows.length} without commission
                  </Badge>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Active or commission-pending stage but deal value = $0. Check the carrier portal and commission reports.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <TableHead className={cn(adminThPlain, 'min-w-[160px]')}>Stage</TableHead>
                      <SortHeader field="effective_date" label="Effective Date" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Days Since Eff.</TableHead>
                      <TableHead className={adminThPlain}>Effective Passed?</TableHead>
                      <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Last Note</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[90px] text-right')}>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('missing-commission') ? <TabLoadingRow cols={10} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={10} message="No active policies with missing commission." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          const daysSince = daysBetween(row.effective_date)
                          const today = new Date().toISOString().slice(0, 10)
                          const effectivePassed = row.effective_date ? ymdFromDate(row.effective_date) < today : false
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'missing-commission')}>
                              {renderPolicyInfo(row)}
                              <TableCell className={adminTdMuted}>
                                <span className="block max-w-[160px] truncate text-xs" title={row.ghl_stage || ''}>{row.ghl_stage || '—'}</span>
                              </TableCell>
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}>
                                {daysSince !== null ? <span className={urgencyColor(daysSince)}>{daysSince}d</span> : '—'}
                              </TableCell>
                              <TableCell className={adminTdMuted}>
                                {effectivePassed ? (
                                  <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-[11px] text-red-600 dark:text-red-400">Yes — {daysSince}d ago</Badge>
                                ) : row.effective_date ? (
                                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-[11px] text-emerald-600 dark:text-emerald-400">Not yet</Badge>
                                ) : (
                                  <span className="text-xs text-muted-foreground">No date</span>
                                )}
                              </TableCell>
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              {renderActionBtn(row, 'missing-commission', 'Note')}
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={missingCommRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 5: Paid as Earned ── */}
        <TabsContent value="paid-earned">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Active Placed — Paid as Earned
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{filteredRows.length} of {earnedRows.length}</span>
                </CardTitle>
              </div>
              <div className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/5 p-3 text-xs text-blue-700 dark:text-blue-300">
                <p className="font-semibold">Detection &amp; invoicing treatment for Paid as Earned:</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5 text-blue-600 dark:text-blue-400">
                  <li>Stage set when <code>commission_type</code> contains &quot;earn&quot; and a positive commission is received.</li>
                  <li>Current business rule: all paid policies are classified as <strong>Paid as Advanced</strong> — Earned is reserved for manual assignment.</li>
                  <li>Invoicing: earned policies are invoiced monthly per premium — no upfront advance; commission earned period-by-period.</li>
                </ul>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Call Center</TableHead>
                      <SortHeader field="effective_date" label="Effective Date" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Commission ($)</TableHead>
                      <TableHead className={adminThPlain}>Comm. Type</TableHead>
                      <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Last Note</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[90px] text-right')}>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('paid-earned') ? <TabLoadingRow cols={10} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={10} message="No policies in Paid as Earned stage." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'paid-earned')}>
                              {renderPolicyInfo(row)}
                              <TableCell className={adminTdMuted}>{row.call_center || '—'}</TableCell>
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}>
                                {row.deal_value && row.deal_value > 0
                                  ? <span className="font-medium text-emerald-600 dark:text-emerald-400">${row.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                                  : <span className="text-muted-foreground">—</span>}
                              </TableCell>
                              <TableCell className={adminTdMuted}><span className="text-xs">{row.commission_type || '—'}</span></TableCell>
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              {renderActionBtn(row, 'paid-earned', 'Note')}
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={earnedRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Tab 6: Paid as Advanced ── */}
        <TabsContent value="paid-advanced">
          <Card>
            <CardHeader className={cn('pb-4', adminCardHeaderBar)}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className={adminCardTitle}>
                  Active Placed — Paid as Advanced
                  <span className="ml-2 text-xs font-normal text-muted-foreground">{filteredRows.length} of {advancedRows.length}</span>
                </CardTitle>
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[11px]">
                    <CheckCircle2 className="mr-1 h-3 w-3" /> Commission Received: {advancedCommStats.received}
                  </Badge>
                  <Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400 text-[11px]">
                    <AlertTriangle className="mr-1 h-3 w-3" /> Commission Missing: {advancedCommStats.missing}
                  </Badge>
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Commission MUST be confirmed received for every Advanced policy. Rows showing $0 need immediate investigation.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="bg-muted/30 hover:bg-transparent dark:bg-slate-900/40">
                      <TableHead className={cn(adminThPlain, 'w-[120px]')}>Comm. Status</TableHead>
                      <SortHeader field="name" label="Name" className="min-w-[160px]" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <SortHeader field="carrier" label="Carrier" {...sharedSortProps} />
                      <SortHeader field="sales_agent" label="Agent" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Call Center</TableHead>
                      <SortHeader field="effective_date" label="Effective Date" {...sharedSortProps} />
                      <TableHead className={adminThPlain}>Commission ($)</TableHead>
                      <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Last Note</TableHead>
                      <TableHead className={cn(adminThPlain, 'w-[90px] text-right')}>Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {isLoading('paid-advanced') ? <TabLoadingRow cols={10} /> :
                      paginatedRows.length === 0 ? <EmptyRow cols={10} message="No policies in Paid as Advanced stage." /> :
                        paginatedRows.map((row) => {
                          const notes = notesByPolicyId[row.id] || []
                          const commReceived = row.deal_value != null && row.deal_value > 0
                          return (
                            <TableRow key={row.id} className={cn(adminTableRowInteractive, 'cursor-pointer')} onClick={() => openDialog(row, 'paid-advanced')}>
                              <TableCell className={adminTdMuted}>
                                <Badge variant="outline" className={cn('whitespace-nowrap text-[11px]',
                                  commReceived ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                    : 'border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400')}>
                                  {commReceived ? 'Paid ✓' : 'Missing ✗'}
                                </Badge>
                              </TableCell>
                              {renderPolicyInfo(row)}
                              <TableCell className={adminTdMuted}>{row.call_center || '—'}</TableCell>
                              {renderEffDate(row)}
                              <TableCell className={adminTdMuted}>
                                {commReceived
                                  ? <span className="font-medium text-emerald-600 dark:text-emerald-400">${row.deal_value!.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                                  : <span className="font-medium text-red-500 dark:text-red-400">$0.00</span>}
                              </TableCell>
                              <TableCell className={adminTdMuted}><NotesList notes={notes} /></TableCell>
                              {renderActionBtn(row, 'paid-advanced', 'Note')}
                            </TableRow>
                          )
                        })}
                  </TableBody>
                </Table>
              </div>
              <PaginationBar currentPage={currentPage} totalPages={totalPages} pageSize={pageSize}
                totalRows={advancedRows.length} filteredRows={filteredRows.length}
                onPage={setCurrentPage} onPageSize={setPageSize} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Shared Review / Note Dialog ── */}
      <Dialog open={dialogRow != null} onOpenChange={(open) => { if (!open) closeDialog() }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          {dialogRow ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialogTab === 'pending-approval' && 'Daily Review — Pending Approval'}
                  {dialogTab === 'declined' && 'Reason Note — Declined / Withdrawn'}
                  {dialogTab === 'past-draft' && 'FDPF Action — Past Draft Date'}
                  {dialogTab === 'missing-commission' && 'Investigation Note — Missing Commission'}
                  {dialogTab === 'paid-earned' && 'Note — Paid as Earned'}
                  {dialogTab === 'paid-advanced' && 'Commission Verification — Paid as Advanced'}
                </DialogTitle>
                <DialogDescription>
                  {dialogTab === 'pending-approval' && 'Add a daily review note for this pending approval policy.'}
                  {dialogTab === 'declined' && 'Document why this policy was declined or withdrawn.'}
                  {dialogTab === 'past-draft' && 'Move to the correct FDPF stage and add a reason note.'}
                  {dialogTab === 'missing-commission' && 'Track your investigation into the missing commission.'}
                  {dialogTab === 'paid-earned' && 'Add a note for this Paid as Earned policy.'}
                  {dialogTab === 'paid-advanced' && 'Verify and note the commission status for this Advanced policy.'}
                </DialogDescription>
              </DialogHeader>

              {/* Policy info grid */}
              <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 text-sm dark:border-slate-800">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div><p className="text-xs text-muted-foreground">Name</p><p className="font-medium">{dialogRow.name || '—'}</p></div>
                  <div><p className="text-xs text-muted-foreground">Policy #</p><p className="font-mono font-medium">{dialogRow.policy_number}</p></div>
                  <div><p className="text-xs text-muted-foreground">Carrier</p><p>{dialogRow.carrier || '—'}</p></div>
                  <div><p className="text-xs text-muted-foreground">Agent</p><p>{dialogRow.sales_agent || '—'}</p></div>
                  <div><p className="text-xs text-muted-foreground">Call Center</p><p>{dialogRow.call_center || '—'}</p></div>
                  <div>
                    <p className="text-xs text-muted-foreground">Effective Date</p>
                    <p>{dialogRow.effective_date ? formatStoredDateForDisplay(dialogRow.effective_date) : '—'}</p>
                  </div>
                  {dialogTab === 'pending-approval' && (
                    <div>
                      <p className="text-xs text-muted-foreground">Days Pending</p>
                      <p className={cn('font-medium', urgencyColor(daysBetween(dialogRow.deal_creation_date)))}>
                        {daysBetween(dialogRow.deal_creation_date) ?? '—'}d
                      </p>
                    </div>
                  )}
                  {(dialogTab === 'past-draft' || dialogTab === 'missing-commission') && (
                    <div>
                      <p className="text-xs text-muted-foreground">Days Past Effective</p>
                      <p className={cn('font-medium', urgencyColor(daysBetween(dialogRow.effective_date)))}>
                        {daysBetween(dialogRow.effective_date) ?? '—'}d
                      </p>
                    </div>
                  )}
                  {(dialogTab === 'paid-advanced' || dialogTab === 'paid-earned') && (
                    <div>
                      <p className="text-xs text-muted-foreground">Commission ($)</p>
                      <p className={cn('font-medium', dialogRow.deal_value && dialogRow.deal_value > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400')}>
                        {dialogRow.deal_value && dialogRow.deal_value > 0
                          ? `$${dialogRow.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
                          : '$0.00 — Missing'}
                      </p>
                    </div>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Current GHL Stage</p>
                  <p className="font-medium">{dialogRow.ghl_stage || '—'}</p>
                </div>
              </div>

              <div className="space-y-4">
                {/* Reason category — declined tab only */}
                {dialogTab === 'declined' && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Reason Category</label>
                    <Select value={dialogReasonCategory || '__none__'} onValueChange={(v) => setDialogReasonCategory(v === '__none__' ? '' : v)}>
                      <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}><SelectValue placeholder="Select a reason…" /></SelectTrigger>
                      <SelectContent className={adminSelectContent}>
                        <SelectItem value="__none__" className={adminSelectItem}>No category</SelectItem>
                        {DECLINE_REASON_CATEGORIES.map((r) => (
                          <SelectItem key={r} value={r} className={adminSelectItem}>{r}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* GHL Stage change — all tabs */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Change GHL Stage <span className="text-xs font-normal text-muted-foreground">(updates Carrier Portal + INSURVAS CRM)</span></label>
                  <Select value={dialogNextStage || '__none__'} onValueChange={(v) => setDialogNextStage(v === '__none__' ? '' : v)}>
                    <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}><SelectValue placeholder="Keep current stage" /></SelectTrigger>
                    <SelectContent className={adminSelectContent}>
                      <SelectItem value="__none__" className={adminSelectItem}>Keep current stage</SelectItem>
                      {CRM_STAGE_GROUPS.map(({ group, stages }) => (
                        <div key={group}>
                          <p className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{group}</p>
                          {stages.map((s) => (
                            <SelectItem key={s} value={s} className={adminSelectItem}>{s}</SelectItem>
                          ))}
                        </div>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Note textarea */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    {dialogTab === 'pending-approval' ? 'Daily Review Note' : 'Note'}
                  </label>
                  <textarea
                    value={dialogNote}
                    onChange={(e) => setDialogNote(e.target.value)}
                    placeholder={
                      dialogTab === 'pending-approval' ? 'Status update, follow-ups, next steps…'
                        : dialogTab === 'declined' ? 'Describe why this policy was declined or withdrawn…'
                          : dialogTab === 'past-draft' ? 'Reason for FDPF — insufficient funds, wrong banking info…'
                            : dialogTab === 'missing-commission' ? 'Investigation steps — which report was checked, what was found…'
                              : 'Write your note…'
                    }
                    className={cn(
                      'min-h-[110px] w-full rounded-md border border-input bg-background p-3 text-sm text-foreground',
                      'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    )}
                  />
                </div>

                {/* Previous notes */}
                {(notesByPolicyId[dialogRow.id] || []).length > 0 && (
                  <div className="space-y-2">
                    <p className="text-sm font-medium">
                      Previous Notes{' '}
                      <span className="text-xs font-normal text-muted-foreground">({(notesByPolicyId[dialogRow.id] || []).length})</span>
                    </p>
                    <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-2 dark:border-slate-800">
                      {(notesByPolicyId[dialogRow.id] || []).map((n) => (
                        <div key={n.id} className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
                          <p className="font-medium text-foreground">{n.note}</p>
                          <p className="mt-0.5 text-muted-foreground">
                            {n.reviewer_name ? `${n.reviewer_name} · ` : ''}
                            {formatStoredDateForDisplay(n.created_at)}
                          </p>
                          {(n.previous_ghl_stage || n.next_ghl_stage) && (
                            <p className="mt-0.5 text-muted-foreground">{n.previous_ghl_stage || '—'} → {n.next_ghl_stage || '—'}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <DialogFooter className="gap-2">
                <Button variant="outline" className={adminOutlineBtn} onClick={closeDialog} disabled={saving}>Cancel</Button>
                <Button onClick={saveReview} disabled={saving} className="bg-orange-600 text-white hover:bg-orange-700">
                  {saving ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                  ) : (
                    <><StickyNote className="mr-2 h-4 w-4" />Save Note</>
                  )}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

    </div>
  )
}
