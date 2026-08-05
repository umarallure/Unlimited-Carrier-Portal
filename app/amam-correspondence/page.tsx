'use client'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Mail,
  Upload,
  Search,
  Loader2,
  RotateCcw,
  FileSpreadsheet,
  Link2,
  Link2Off,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  X,
  Calendar,
  User,
  ArrowRightLeft,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminDateInput,
  adminExpandRowBg,
  adminInput,
  adminOutlineBtn,
  adminPaginationShell,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'
import { GHL_STAGE_ORDER, getStageColor } from '@/lib/ghlStageResolver'
import {
  CorrespondenceStageDialog,
  type StageChangeResult,
} from '@/components/CorrespondenceStageDialog'
import {
  annotateCorrespondencePreview,
  fetchAmamCorrespondence,
  fetchCorrespondenceFacets,
  MAX_CORRESPONDENCE_ROWS,
  parseAmamCorrespondenceCsv,
  saveAmamCorrespondence,
  type AmamCorrespondenceRow,
  type AmamCorrespondencePreviewRow,
  type CorrespondenceFacets,
  type LinkedDealTracker,
} from '@/lib/amamCorrespondence'

type LinkFilter = 'all' | 'linked' | 'unlinked'

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

const PAGE_SIZES = [25, 50, 100]

/** Dropdown sentinel for "the deal has no value in this column". */
const BLANK_VALUE = '__blank__'

const noticeStyles: Record<Notice['kind'], string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
}

/** Pipeline order first (matching the Deal Tracker), then anything unrecognised. */
function sortByStageOrder(stages: string[]): string[] {
  const order = new Map<string, number>(GHL_STAGE_ORDER.map((s, i) => [s, i]))
  return [...stages].sort((a, b) => {
    const ai = order.get(a)
    const bi = order.get(b)
    if (ai != null && bi != null) return ai - bi
    if (ai != null) return -1
    if (bi != null) return 1
    return a.localeCompare(b)
  })
}

function StageBadge({ stage }: { stage: string }) {
  const color = getStageColor(stage)
  return (
    <span className="inline-flex items-center gap-1.5" title={stage}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
      <span className="truncate text-sm text-foreground dark:text-slate-100">{stage}</span>
    </span>
  )
}

function StatTile({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number | string
  tone?: 'default' | 'good' | 'warn' | 'muted'
}) {
  const toneClass =
    tone === 'good'
      ? 'text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'muted'
          ? 'text-muted-foreground'
          : 'text-foreground dark:text-white'
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('font-display text-lg font-semibold tabular-nums', toneClass)}>{value}</p>
    </div>
  )
}

export default function AmamCorrespondencePage() {
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ---- Upload state -------------------------------------------------------
  const [fileName, setFileName] = useState('')
  const [parsing, setParsing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState<AmamCorrespondencePreviewRow[] | null>(null)
  const [skippedRows, setSkippedRows] = useState<Array<{ csvRow: number; reason: string }>>([])
  const [notice, setNotice] = useState<Notice | null>(null)

  // ---- Dataset ------------------------------------------------------------
  const [allRows, setAllRows] = useState<AmamCorrespondenceRow[]>([])
  const [dealTrackers, setDealTrackers] = useState<Map<string, LinkedDealTracker>>(new Map())
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // ---- Stage-change dialog ------------------------------------------------
  // The queue is snapshotted when the dialog opens rather than read live from
  // filteredRows: changing a stage can push a row out of the current filter, and
  // positions must not shift under the user mid-review.
  const [stageDialogOpen, setStageDialogOpen] = useState(false)
  const [stageQueue, setStageQueue] = useState<AmamCorrespondenceRow[]>([])
  const [stageIndex, setStageIndex] = useState(0)

  // ---- Filters ------------------------------------------------------------
  // Pushed down to Postgres (columns on amam_correspondence):
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [descriptionFilter, setDescriptionFilter] = useState('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Applied in memory (columns on deal_tracker):
  const [ghlStageFilter, setGhlStageFilter] = useState('all')
  const [policyStatusFilter, setPolicyStatusFilter] = useState('all')
  const [ghlNameFilter, setGhlNameFilter] = useState('')
  const [debouncedGhlName, setDebouncedGhlName] = useState('')
  const [linkFilter, setLinkFilter] = useState<LinkFilter>('all')

  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const [facets, setFacets] = useState<CorrespondenceFacets>({ descriptions: [], agents: [] })

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchTerm), 300)
    return () => clearTimeout(handle)
  }, [searchTerm])

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedGhlName(ghlNameFilter), 300)
    return () => clearTimeout(handle)
  }, [ghlNameFilter])

  const loadRows = useCallback(async () => {
    setLoading(true)
    try {
      const result = await fetchAmamCorrespondence({
        search: debouncedSearch,
        description: descriptionFilter,
        agentId: agentFilter,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      })
      setAllRows(result.rows)
      setDealTrackers(result.dealTrackers)
      setTruncated(result.truncated)
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load correspondence' })
      setAllRows([])
      setDealTrackers(new Map())
      setTruncated(false)
    } finally {
      setLoading(false)
    }
  }, [debouncedSearch, descriptionFilter, agentFilter, dateFrom, dateTo])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  const loadFacets = useCallback(async () => {
    try {
      setFacets(await fetchCorrespondenceFacets())
    } catch {
      // Filter dropdowns are a convenience; the table still works without them.
    }
  }, [])

  useEffect(() => {
    loadFacets()
  }, [loadFacets])

  // ---- Deal-derived facets ------------------------------------------------
  // Built from the deals behind the currently loaded rows, so the dropdowns only
  // ever offer values that can actually return something.
  const dealFacets = useMemo(() => {
    const stages = new Set<string>()
    const statuses = new Set<string>()
    let hasBlankStage = false
    let hasBlankStatus = false

    for (const row of allRows) {
      const deal = dealTrackers.get(row.policy_number_key)
      if (!deal) continue
      if (deal.ghl_stage) stages.add(deal.ghl_stage)
      else hasBlankStage = true
      if (deal.policy_status) statuses.add(deal.policy_status)
      else hasBlankStatus = true
    }

    return {
      ghlStages: sortByStageOrder(Array.from(stages)),
      policyStatuses: Array.from(statuses).sort(),
      hasBlankStage,
      hasBlankStatus,
    }
  }, [allRows, dealTrackers])

  // ---- In-memory filtering + paging ---------------------------------------
  const filteredRows = useMemo(() => {
    const nameNeedle = debouncedGhlName.trim().toLowerCase()

    return allRows.filter((row) => {
      const deal = dealTrackers.get(row.policy_number_key) ?? null

      if (linkFilter === 'linked' && !deal) return false
      if (linkFilter === 'unlinked' && deal) return false

      if (ghlStageFilter !== 'all') {
        const stage = deal?.ghl_stage ?? ''
        if (ghlStageFilter === BLANK_VALUE) {
          if (!deal || stage) return false
        } else if (stage !== ghlStageFilter) {
          return false
        }
      }

      if (policyStatusFilter !== 'all') {
        const status = deal?.policy_status ?? ''
        if (policyStatusFilter === BLANK_VALUE) {
          if (!deal || status) return false
        } else if (status !== policyStatusFilter) {
          return false
        }
      }

      if (nameNeedle && !(deal?.ghl_name ?? '').toLowerCase().includes(nameNeedle)) return false

      return true
    })
  }, [allRows, dealTrackers, linkFilter, ghlStageFilter, policyStatusFilter, debouncedGhlName])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize))

  // Filters can shrink the result set out from under the current page.
  useEffect(() => {
    setPage((p) => Math.min(p, Math.max(1, Math.ceil(filteredRows.length / pageSize))))
  }, [filteredRows.length, pageSize])

  useEffect(() => {
    setPage(1)
  }, [
    debouncedSearch,
    descriptionFilter,
    agentFilter,
    dateFrom,
    dateTo,
    ghlStageFilter,
    policyStatusFilter,
    debouncedGhlName,
    linkFilter,
    pageSize,
  ])

  const pageRows = useMemo(
    () => filteredRows.slice((page - 1) * pageSize, page * pageSize),
    [filteredRows, page, pageSize]
  )

  const stageDialogRow = stageQueue[stageIndex] ?? null
  const stageDialogDeal = stageDialogRow
    ? dealTrackers.get(stageDialogRow.policy_number_key) ?? null
    : null

  /**
   * Rows a stage change can actually be applied to — the Stage button is disabled
   * without a Deal Tracker match, so Next/Previous must not land on one either.
   */
  const actionableRows = useMemo(
    () => filteredRows.filter((r) => dealTrackers.has(r.policy_number_key)),
    [filteredRows, dealTrackers]
  )

  const openStageDialog = (row: AmamCorrespondenceRow) => {
    const queue = actionableRows
    const index = queue.findIndex((r) => r.id === row.id)
    setStageQueue(queue)
    setStageIndex(index >= 0 ? index : 0)
    setStageDialogOpen(true)
  }

  /** Step through the queue, keeping the grid page behind the dialog in sync. */
  const navigateStageQueue = (delta: number) => {
    const next = stageIndex + delta
    if (next < 0 || next >= stageQueue.length) return
    setStageIndex(next)

    const target = stageQueue[next]
    const positionInGrid = filteredRows.findIndex((r) => r.id === target.id)
    if (positionInGrid >= 0) {
      setPage(Math.floor(positionInGrid / pageSize) + 1)
      setExpandedId(target.id ?? null)
    }
  }

  /**
   * Patch the deal in place rather than refetching — the row keeps its position
   * under the current filters, and a stage filter would otherwise make the row
   * vanish mid-interaction.
   */
  const handleStageSaved = (result: StageChangeResult) => {
    setDealTrackers((prev) => {
      const next = new Map(prev)
      for (const [key, deal] of next) {
        if (deal.id === result.dealId) next.set(key, { ...deal, ghl_stage: result.newStage })
      }
      return next
    })

    const crmParts: string[] = []
    if (result.crm.stageUpdated) crmParts.push('CRM stage synced')
    if (result.crm.noteSaved) crmParts.push('note added to CRM lead notes')

    setNotice({
      kind: result.crm.stageUpdated ? 'success' : 'info',
      text: `${result.policyNumber}: stage set to "${result.newStage}"${
        crmParts.length ? ` — ${crmParts.join(', ')}.` : '.'
      }${result.crm.message ? ` ${result.crm.message}` : ''}`,
    })
  }

  // ---- Upload handlers ----------------------------------------------------

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setParsing(true)
    setNotice(null)
    setPreview(null)
    setSkippedRows([])
    setFileName(file.name)

    try {
      const parsed = await parseAmamCorrespondenceCsv(file)
      if (!parsed.rows.length) {
        setNotice({ kind: 'error', text: 'No usable rows found in this file.' })
        setSkippedRows(parsed.skipped)
        return
      }
      const annotated = await annotateCorrespondencePreview(parsed.rows)
      setPreview(annotated)
      setSkippedRows(parsed.skipped)
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to parse file' })
    } finally {
      setParsing(false)
      // Allow re-selecting the same file after a failed parse.
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const previewStats = useMemo(() => {
    if (!preview) return null
    const newRows = preview.filter((r) => !r.isExisting && !r.isDuplicateInFile).length
    const existing = preview.filter((r) => r.isExisting).length
    const dupesInFile = preview.filter((r) => r.isDuplicateInFile).length
    const linked = preview.filter((r) => r.hasDealTracker).length
    const noDate = preview.filter((r) => !r.correspondence_date).length
    return {
      total: preview.length,
      newRows,
      existing,
      dupesInFile,
      linked,
      unlinked: preview.length - linked,
      noDate,
    }
  }, [preview])

  const handleSave = async () => {
    if (!preview?.length) return
    setSaving(true)
    setNotice(null)
    try {
      const result = await saveAmamCorrespondence(preview)
      setNotice({
        kind: 'success',
        text: `Saved ${result.saved} correspondence ${result.saved === 1 ? 'record' : 'records'} (${result.inserted} new, ${result.updated} updated).`,
      })
      setPreview(null)
      setSkippedRows([])
      setFileName('')
      setPage(1)
      await Promise.all([loadRows(), loadFacets()])
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to save correspondence' })
    } finally {
      setSaving(false)
    }
  }

  const discardPreview = () => {
    setPreview(null)
    setSkippedRows([])
    setFileName('')
    setNotice(null)
  }

  // ---- Filter chrome ------------------------------------------------------

  const activeFilterCount = [
    debouncedSearch,
    descriptionFilter !== 'all',
    agentFilter !== 'all',
    ghlStageFilter !== 'all',
    policyStatusFilter !== 'all',
    debouncedGhlName.trim(),
    linkFilter !== 'all',
    dateFrom,
    dateTo,
  ].filter(Boolean).length

  const clearFilters = () => {
    setSearchTerm('')
    setDescriptionFilter('all')
    setAgentFilter('all')
    setGhlStageFilter('all')
    setPolicyStatusFilter('all')
    setGhlNameFilter('')
    setLinkFilter('all')
    setDateFrom('')
    setDateTo('')
  }

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="AMAM Correspondence"
        description="Upload the AMAM correspondence export and review each memo alongside its deal in the Deal Tracker, matched on policy number."
        icon={<Mail className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
      />

      {notice && (
        <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', noticeStyles[notice.kind])}>
          {notice.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="min-w-0 flex-1">{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Upload                                                            */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
            <Upload className="h-4 w-4 text-orange-500 dark:text-orange-400" />
            Upload correspondence CSV
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileSelected}
              className="hidden"
            />
            <Button
              type="button"
              variant="outline"
              className={adminOutlineBtn}
              disabled={parsing || saving}
              onClick={() => fileInputRef.current?.click()}
            >
              {parsing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
              {parsing ? 'Reading file…' : 'Choose CSV file'}
            </Button>
            {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
          </div>

          <p className="text-xs text-muted-foreground">
            Expected columns: Agent ID, Agent Name, Policy Number, Policyholder, Date, Description, Form Code, Action
            Item. Re-uploading an overlapping export updates matching rows instead of duplicating them.
          </p>

          {previewStats && (
            <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatTile label="Rows parsed" value={previewStats.total} />
                <StatTile label="New" value={previewStats.newRows} tone="good" />
                <StatTile label="Already saved" value={previewStats.existing} tone="muted" />
                <StatTile label="Duplicates in file" value={previewStats.dupesInFile} tone={previewStats.dupesInFile ? 'warn' : 'muted'} />
                <StatTile label="Matched to a deal" value={previewStats.linked} tone="good" />
                <StatTile label="No deal match" value={previewStats.unlinked} tone={previewStats.unlinked ? 'warn' : 'muted'} />
              </div>

              {(skippedRows.length > 0 || previewStats.noDate > 0) && (
                <div className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                  {skippedRows.length > 0 && (
                    <p>
                      {skippedRows.length} row{skippedRows.length === 1 ? '' : 's'} skipped (no policy number): line
                      {skippedRows.length === 1 ? ' ' : 's '}
                      {skippedRows.slice(0, 10).map((s) => s.csvRow).join(', ')}
                      {skippedRows.length > 10 ? '…' : ''}
                    </p>
                  )}
                  {previewStats.noDate > 0 && (
                    <p>{previewStats.noDate} row(s) have an unreadable date and will be saved without one.</p>
                  )}
                </div>
              )}

              <div className="max-h-80 overflow-auto rounded-lg border border-border dark:border-slate-800">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={adminThPlain}>Status</TableHead>
                      <TableHead className={adminThPlain}>Date</TableHead>
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <TableHead className={adminThPlain}>Policyholder</TableHead>
                      <TableHead className={adminThPlain}>Agent</TableHead>
                      <TableHead className={adminThPlain}>Description</TableHead>
                      <TableHead className={adminThPlain}>Form</TableHead>
                      <TableHead className={adminThPlain}>Deal</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {preview!.slice(0, 200).map((row) => (
                      <TableRow key={`${row.csvRow}-${row.dedupe_key}`} className={adminTableRowInteractive}>
                        <TableCell>
                          {row.isDuplicateInFile ? (
                            <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300">
                              Duplicate
                            </Badge>
                          ) : row.isExisting ? (
                            <Badge variant="outline" className="border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300">
                              Update
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300">
                              New
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          {row.correspondence_date ? formatStoredDateForDisplay(row.correspondence_date) : '—'}
                        </TableCell>
                        <TableCell className={cn(adminTdStrong, 'font-mono text-xs')}>{row.policy_number}</TableCell>
                        <TableCell className={adminTdStrong}>{row.policyholder || '—'}</TableCell>
                        <TableCell className={adminTdMuted}>{row.agent_name || '—'}</TableCell>
                        <TableCell className={adminTdMuted}>{row.description || '—'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'font-mono text-xs')}>{row.form_code || '—'}</TableCell>
                        <TableCell>
                          {row.hasDealTracker ? (
                            <Link2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          ) : (
                            <Link2Off className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {preview!.length > 200 && (
                  <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground dark:border-slate-800">
                    Showing the first 200 of {preview!.length} rows. All {preview!.length} will be saved.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={handleSave} disabled={saving}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
                  {saving ? 'Saving…' : `Save ${previewStats.total} record${previewStats.total === 1 ? '' : 's'}`}
                </Button>
                <Button type="button" variant="outline" className={adminOutlineBtn} onClick={discardPreview} disabled={saving}>
                  Discard
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      {/* Correspondence table                                              */}
      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
              <Mail className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              Correspondence
              <span className="text-sm font-normal text-muted-foreground">
                {loading
                  ? ''
                  : activeFilterCount > 0
                    ? `${filteredRows.length.toLocaleString()} of ${allRows.length.toLocaleString()}`
                    : `${allRows.length.toLocaleString()} total`}
              </span>
            </CardTitle>
            {activeFilterCount > 0 && (
              <Button type="button" variant="outline" size="sm" className={adminOutlineBtn} onClick={clearFilters}>
                <RotateCcw className="mr-2 h-3.5 w-3.5" />
                Clear filters ({activeFilterCount})
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-5">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Policy #, policyholder, or agent"
                className={cn(adminInput, 'pl-9')}
              />
            </div>

            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={ghlNameFilter}
                onChange={(e) => setGhlNameFilter(e.target.value)}
                placeholder="GHL Name"
                className={cn(adminInput, 'pl-9')}
              />
            </div>

            <Select value={ghlStageFilter} onValueChange={setGhlStageFilter}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All GHL stages" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All GHL stages
                </SelectItem>
                {dealFacets.ghlStages.map((stage) => (
                  <SelectItem key={stage} value={stage} className={adminSelectItem}>
                    {stage}
                  </SelectItem>
                ))}
                {dealFacets.hasBlankStage && (
                  <SelectItem value={BLANK_VALUE} className={adminSelectItem}>
                    (No stage set)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>

            <Select value={policyStatusFilter} onValueChange={setPolicyStatusFilter}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All policy statuses" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All policy statuses
                </SelectItem>
                {dealFacets.policyStatuses.map((status) => (
                  <SelectItem key={status} value={status} className={adminSelectItem}>
                    {status}
                  </SelectItem>
                ))}
                {dealFacets.hasBlankStatus && (
                  <SelectItem value={BLANK_VALUE} className={adminSelectItem}>
                    (No status set)
                  </SelectItem>
                )}
              </SelectContent>
            </Select>

            <Select value={descriptionFilter} onValueChange={setDescriptionFilter}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All descriptions" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All descriptions
                </SelectItem>
                {facets.descriptions.map((d) => (
                  <SelectItem key={d} value={d} className={adminSelectItem}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All agents
                </SelectItem>
                {facets.agents.map((a) => (
                  <SelectItem key={a.id} value={a.id} className={adminSelectItem}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={linkFilter} onValueChange={(v) => setLinkFilter(v as LinkFilter)}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All rows" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All rows
                </SelectItem>
                <SelectItem value="linked" className={adminSelectItem}>
                  Matched to a deal
                </SelectItem>
                <SelectItem value="unlinked" className={adminSelectItem}>
                  No deal match
                </SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className={adminDateInput}
                aria-label="Correspondence date from"
              />
              <span className="text-sm text-muted-foreground">to</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className={adminDateInput}
                aria-label="Correspondence date to"
              />
            </div>
          </div>

          {truncated && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              Showing the first {MAX_CORRESPONDENCE_ROWS.toLocaleString()} matching rows. Narrow the date range or
              filters to see the rest.
            </p>
          )}

          <div className="overflow-x-auto rounded-lg border border-border dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={cn(adminThPlain, 'w-8')} />
                  <TableHead className={adminThPlain}>Date</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={adminThPlain}>Policyholder</TableHead>
                  <TableHead className={adminThPlain}>Agent</TableHead>
                  <TableHead className={adminThPlain}>Description</TableHead>
                  <TableHead className={adminThPlain}>Form Code</TableHead>
                  <TableHead className={adminThPlain}>GHL Name</TableHead>
                  <TableHead className={adminThPlain}>GHL Stage</TableHead>
                  <TableHead className={adminThPlain}>Policy Status</TableHead>
                  <TableHead className={cn(adminThPlain, 'text-right')}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : pageRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                      {allRows.length === 0 && activeFilterCount === 0
                        ? 'No correspondence saved yet. Upload a CSV above to get started.'
                        : 'No rows match the current filters.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  pageRows.map((row) => {
                    const deal = dealTrackers.get(row.policy_number_key) ?? null
                    const isExpanded = expandedId === row.id

                    return (
                      <Fragment key={row.id}>
                        <TableRow
                          className={cn(adminTableRowInteractive, 'cursor-pointer')}
                          onClick={() => setExpandedId(isExpanded ? null : row.id ?? null)}
                        >
                          <TableCell className="text-muted-foreground">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell className={cn(adminTdMuted, 'whitespace-nowrap')}>
                            {row.correspondence_date ? formatStoredDateForDisplay(row.correspondence_date) : '—'}
                          </TableCell>
                          <TableCell className={cn(adminTdStrong, 'font-mono text-xs')}>{row.policy_number}</TableCell>
                          <TableCell className={adminTdStrong}>{row.policyholder || '—'}</TableCell>
                          <TableCell className={adminTdMuted}>{row.agent_name || '—'}</TableCell>
                          <TableCell className={adminTdMuted}>{row.description || '—'}</TableCell>
                          <TableCell className={cn(adminTdMuted, 'font-mono text-xs')}>{row.form_code || '—'}</TableCell>

                          <TableCell className={adminTdStrong}>
                            {!deal ? (
                              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                                <Link2Off className="h-4 w-4 shrink-0" />
                                Not in tracker
                              </span>
                            ) : (
                              <span className="flex items-center gap-2">
                                <Link2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                <span className="truncate">{deal.ghl_name || '—'}</span>
                              </span>
                            )}
                          </TableCell>
                          <TableCell>
                            {deal?.ghl_stage ? (
                              <StageBadge stage={deal.ghl_stage} />
                            ) : (
                              <span className={adminTdMuted}>—</span>
                            )}
                          </TableCell>
                          <TableCell className={adminTdMuted}>{deal?.policy_status || '—'}</TableCell>

                          <TableCell className="text-right">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={adminOutlineBtn}
                              disabled={!deal}
                              title={
                                deal
                                  ? 'Change GHL stage and sync to the CRM'
                                  : 'No Deal Tracker row for this policy'
                              }
                              onClick={(e) => {
                                // The row itself toggles the detail panel.
                                e.stopPropagation()
                                openStageDialog(row)
                              }}
                            >
                              <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />
                              Stage
                            </Button>
                          </TableCell>
                        </TableRow>

                        {isExpanded && (
                          <TableRow className={adminExpandRowBg}>
                            <TableCell colSpan={11} className="p-4">
                              <div className="grid gap-6 lg:grid-cols-2">
                                <div className="space-y-2">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Action item
                                  </p>
                                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground dark:text-slate-100">
                                    {row.action_item || 'No action item recorded.'}
                                  </p>
                                  <p className="pt-2 text-xs text-muted-foreground">
                                    Agent {row.agent_id || '—'}
                                    {row.source_file ? ` · from ${row.source_file}` : ''}
                                    {row.source_row ? ` (line ${row.source_row})` : ''}
                                  </p>
                                </div>

                                <div className="space-y-2">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Deal Tracker
                                  </p>
                                  {deal ? (
                                    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Deal Name</dt>
                                        <dd className={adminTdStrong}>{deal.name || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">GHL Name</dt>
                                        <dd className={adminTdStrong}>{deal.ghl_name || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">GHL Stage</dt>
                                        <dd className={adminTdStrong}>{deal.ghl_stage || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Policy Status</dt>
                                        <dd className={adminTdStrong}>{deal.policy_status || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Carrier Status</dt>
                                        <dd className={adminTdStrong}>{deal.carrier_status || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Sales Agent</dt>
                                        <dd className={adminTdStrong}>{deal.sales_agent || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Call Center</dt>
                                        <dd className={adminTdStrong}>{deal.call_center || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Phone</dt>
                                        <dd className={adminTdStrong}>{deal.phone_number || '—'}</dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Effective Date</dt>
                                        <dd className={adminTdStrong}>
                                          {deal.effective_date ? formatStoredDateForDisplay(deal.effective_date) : '—'}
                                        </dd>
                                      </div>
                                      <div>
                                        <dt className="text-xs text-muted-foreground">Monthly Premium</dt>
                                        <dd className={adminTdStrong}>
                                          {deal.monthly_premium != null ? `$${Number(deal.monthly_premium).toFixed(2)}` : '—'}
                                        </dd>
                                      </div>
                                    </dl>
                                  ) : (
                                    <p className="text-sm text-muted-foreground">
                                      No deal in the tracker for policy {row.policy_number}. This is expected for
                                      declined or withdrawn applications.
                                    </p>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <div className={adminPaginationShell}>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>
                Page {page} of {totalPages}
              </span>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className={cn(adminSelectTrigger, 'h-8 w-[110px]')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={adminSelectContent}>
                  {PAGE_SIZES.map((size) => (
                    <SelectItem key={size} value={String(size)} className={adminSelectItem}>
                      {size} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <CorrespondenceStageDialog
        open={stageDialogOpen}
        onOpenChange={setStageDialogOpen}
        row={stageDialogRow}
        deal={stageDialogDeal}
        onSaved={handleStageSaved}
        position={stageQueue.length ? stageIndex + 1 : undefined}
        total={stageQueue.length || undefined}
        onNavigate={navigateStageQueue}
      />
    </div>
  )
}
