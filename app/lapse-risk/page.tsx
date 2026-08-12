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
  AlarmClock,
  Upload,
  FileSpreadsheet,
  Loader2,
  Search,
  Save,
  Download,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  X,
  ChevronDown,
  ChevronRight,
  Calendar,
  Phone,
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
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import {
  detectLapseRisk,
  localToday,
  parseLapseRiskWorkbook,
  type LapseRiskResult,
  type RiskBucket,
  type RiskTier,
} from '@/lib/lapseRisk'
// Generic deal_tracker lookup — handles the zero-padding mismatch between the
// carrier exports and deal_tracker.policy_number. It lives in the AMAM module
// because that page needed it first; nothing about it is AMAM-specific.
import {
  fetchLinkedDealTrackers,
  normalizePolicyKey,
  type LinkedDealTracker,
} from '@/lib/amamCorrespondence'
import { getStageColor } from '@/lib/ghlStageResolver'
import { GhlStageChangeDialog, type StageChangeResult } from '@/components/GhlStageChangeDialog'
import {
  deleteLapseRiskRun,
  listLapseRiskRuns,
  listRunPolicies,
  saveLapseRiskRun,
  toCallListCsv,
  type LapseRiskRun,
  type SavedPolicy,
} from '@/lib/lapseRiskStore'

type Notice = { kind: 'success' | 'error' | 'info'; text: string }

const noticeStyles: Record<Notice['kind'], string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
  info: 'border-blue-500/40 bg-blue-500/10 text-blue-700 dark:text-blue-300',
}

const tierStyles: Record<RiskTier, string> = {
  CRITICAL: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300',
  HIGH: 'border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300',
  EARLY: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300',
}

const BUCKET_LABELS: Record<RiskBucket, string> = {
  AT_RISK: 'At risk',
  NSF_SUSPECT: 'Not clearing',
  PENDING_FIRST_DRAFT: 'First draft pending',
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function StageBadge({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={stage}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: getStageColor(stage) }} />
      <span className="truncate text-sm text-foreground dark:text-slate-100">{stage}</span>
    </span>
  )
}

function Stat({
  label,
  value,
  sub,
  tone = 'default',
}: {
  label: string
  value: string | number
  sub?: string
  tone?: 'default' | 'critical' | 'high' | 'early' | 'muted'
}) {
  const toneClass =
    tone === 'critical'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'high'
        ? 'text-orange-600 dark:text-orange-400'
        : tone === 'early'
          ? 'text-amber-600 dark:text-amber-400'
          : tone === 'muted'
            ? 'text-muted-foreground'
            : 'text-foreground dark:text-white'
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('font-display text-xl font-semibold tabular-nums', toneClass)}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

export default function LapseRiskPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  /** Held so changing the snapshot date can re-run without re-picking the file. */
  const fileRef = useRef<File | null>(null)

  // Upload / analysis
  const [fileName, setFileName] = useState('')
  const [snapshotDate, setSnapshotDate] = useState(localToday)
  const [analyzing, setAnalyzing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<LapseRiskResult | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  // Saved runs
  const [runs, setRuns] = useState<LapseRiskRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState('')
  const [policies, setPolicies] = useState<SavedPolicy[]>([])
  const [loadingRun, setLoadingRun] = useState(false)
  /** deal_tracker rows for this run's policies, keyed by normalized policy number. */
  const [dealTrackers, setDealTrackers] = useState<Map<string, LinkedDealTracker>>(new Map())

  // Stage-change dialog. The queue is snapshotted on open so a stage change
  // (which can move a row out of the current filter) never renumbers underneath.
  const [stageDialogOpen, setStageDialogOpen] = useState(false)
  const [stageQueue, setStageQueue] = useState<SavedPolicy[]>([])
  const [stageIndex, setStageIndex] = useState(0)

  // View filters
  const [bucketFilter, setBucketFilter] = useState<RiskBucket>('AT_RISK')
  const [tierFilter, setTierFilter] = useState<string>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadRuns = useCallback(async () => {
    try {
      const rows = await listLapseRiskRuns()
      setRuns(rows)
      setSelectedRunId((prev) => prev || (rows[0]?.id ?? ''))
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load runs' })
    }
  }, [])

  useEffect(() => {
    loadRuns()
  }, [loadRuns])

  useEffect(() => {
    if (!selectedRunId) {
      setPolicies([])
      setDealTrackers(new Map())
      return
    }
    let cancelled = false
    setLoadingRun(true)
    listRunPolicies(selectedRunId)
      .then(async (rows) => {
        if (cancelled) return
        setPolicies(rows)
        // One batched lookup for the whole run (tens of policies), so every row
        // can show its live GHL stage.
        const deals = await fetchLinkedDealTrackers(rows.map((r) => r.policy_number))
        if (!cancelled) setDealTrackers(deals)
      })
      .catch((err: unknown) => {
        if (!cancelled) setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load policies' })
      })
      .finally(() => {
        if (!cancelled) setLoadingRun(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedRunId])

  const dealFor = useCallback(
    (policyNumber: string) => dealTrackers.get(normalizePolicyKey(policyNumber)) ?? null,
    [dealTrackers]
  )

  // ---- Upload -------------------------------------------------------------

  const runAnalysis = async (file: File, asOf: string) => {
    setAnalyzing(true)
    setNotice(null)
    setResult(null)
    try {
      const rows = await parseLapseRiskWorkbook(file)
      if (rows.length === 0) throw new Error('No policy rows found in the sheet.')
      const detected = detectLapseRisk(rows, asOf)
      setResult(detected)
      if (detected.flagged.length === 0) {
        setNotice({
          kind: 'info',
          text: `Analysed ${detected.activeCount} active policies as of ${asOf} — nothing is at risk.`,
        })
      }
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to analyse the file' })
    } finally {
      setAnalyzing(false)
    }
  }

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    fileRef.current = file
    await runAnalysis(file, snapshotDate)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSnapshotChange = async (value: string) => {
    setSnapshotDate(value)
    if (fileRef.current && value) await runAnalysis(fileRef.current, value)
  }

  const handleSave = async () => {
    if (!result) return
    setSaving(true)
    setNotice(null)
    try {
      const { runId, savedPolicies } = await saveLapseRiskRun({ result, sourceFile: fileName })
      setNotice({
        kind: 'success',
        text: `Saved ${savedPolicies} flagged polic${savedPolicies === 1 ? 'y' : 'ies'} (${result.atRiskCount} at risk) for ${result.snapshotDate}.`,
      })
      setResult(null)
      setFileName('')
      fileRef.current = null
      await loadRuns()
      setSelectedRunId(runId)
      setBucketFilter('AT_RISK')
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to save' })
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteRun = async () => {
    const run = runs.find((r) => r.id === selectedRunId)
    if (!run) return
    if (!confirm(`Delete the ${run.snapshot_date} run and its ${run.at_risk_count} at-risk policies?`)) return
    try {
      await deleteLapseRiskRun(run.id)
      setSelectedRunId('')
      await loadRuns()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to delete run' })
    }
  }

  // ---- Derived view -------------------------------------------------------

  const selectedRun = runs.find((r) => r.id === selectedRunId) ?? null

  const bucketCounts = useMemo(() => {
    const counts: Record<RiskBucket, number> = { AT_RISK: 0, NSF_SUSPECT: 0, PENDING_FIRST_DRAFT: 0 }
    for (const p of policies) counts[p.bucket] = (counts[p.bucket] ?? 0) + 1
    return counts
  }, [policies])

  const visible = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    return policies.filter((p) => {
      if (p.bucket !== bucketFilter) return false
      if (tierFilter !== 'all' && p.tier !== tierFilter) return false
      if (term) {
        const haystack = `${p.policy_number} ${p.insured ?? ''} ${p.phone ?? ''} ${p.agent ?? ''}`.toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })
  }, [policies, bucketFilter, tierFilter, searchTerm])

  // ---- Stage change --------------------------------------------------------

  /** Only rows with a Deal Tracker match can have their stage changed. */
  const actionable = useMemo(() => visible.filter((p) => dealFor(p.policy_number) != null), [visible, dealFor])

  const stageDialogRow = stageQueue[stageIndex] ?? null
  const stageDialogDeal = stageDialogRow ? dealFor(stageDialogRow.policy_number) : null

  const openStageDialog = (row: SavedPolicy) => {
    const queue = actionable
    const index = queue.findIndex((r) => r.id === row.id)
    setStageQueue(queue)
    setStageIndex(index >= 0 ? index : 0)
    setStageDialogOpen(true)
  }

  const navigateStageQueue = (delta: number) => {
    const next = stageIndex + delta
    if (next < 0 || next >= stageQueue.length) return
    setStageIndex(next)
    setExpandedId(stageQueue[next].id)
  }

  /** Patch the local deal map so the GHL Stage column reflects the change at once. */
  const handleStageSaved = (result: StageChangeResult) => {
    setDealTrackers((prev) => {
      const key = normalizePolicyKey(result.policyNumber)
      const existing = prev.get(key)
      if (!existing) return prev
      const next = new Map(prev)
      next.set(key, { ...existing, ghl_stage: result.newStage })
      return next
    })
    const parts = [`Deal Tracker moved to “${result.newStage}”.`]
    parts.push(result.crm.stageUpdated ? 'CRM lead stage synced.' : 'CRM lead stage not synced.')
    if (result.crm.noteSaved) parts.push('Note added to CRM lead notes.')
    setNotice({ kind: result.crm.stageUpdated ? 'success' : 'info', text: parts.join(' ') })
  }

  const downloadCsv = () => {
    const csv = toCallListCsv(visible)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lapse-risk-${selectedRun?.snapshot_date ?? 'export'}-${bucketFilter.toLowerCase()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="Lapse Risk"
        description="Upload the AMH policySummary export to find active policies that have missed a draft and are on track to lapse. The grace period is derived from the file's own lapsed policies, not hardcoded."
        icon={<AlarmClock className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
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
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
            <Upload className="h-4 w-4 text-orange-500 dark:text-orange-400" />
            Upload policySummary
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground dark:text-slate-200">File</label>
              <div className="flex items-center gap-3">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={handleFileSelected}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  className={adminOutlineBtn}
                  disabled={analyzing || saving}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {analyzing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <FileSpreadsheet className="mr-2 h-4 w-4" />
                  )}
                  {analyzing ? 'Analysing…' : 'Choose .xlsx'}
                </Button>
                {fileName && <span className="text-sm text-muted-foreground">{fileName}</span>}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground dark:text-slate-200">Evaluate as of</label>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                <Input
                  type="date"
                  value={snapshotDate}
                  onChange={(e) => handleSnapshotChange(e.target.value)}
                  className={adminDateInput}
                />
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Reads the “Policy Summary” sheet with headers on row 2. A policy is flagged when its last payment is older
            than one draft cycle plus 5 days — not merely because its paid-to date has passed, which is normal for
            quarterly policies paid in monthly installments.
          </p>

          {result && (
            <div className="space-y-4 rounded-xl border border-border bg-muted/20 p-4 dark:border-slate-800 dark:bg-slate-950/40">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Active reviewed" value={result.activeCount} sub={`${result.totalRows} rows in file`} />
                <Stat label="At risk" value={result.atRiskCount} tone="critical" />
                <Stat label="Critical" value={result.criticalCount} tone="critical" sub="≤7 days of grace" />
                <Stat label="High" value={result.highCount} tone="high" sub="8–21 days" />
                <Stat label="Early" value={result.earlyCount} tone="early" sub="22+ days" />
                <Stat label="Annual premium" value={money(result.annualPremiumAtRisk)} sub="at risk" />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Not clearing (NSF)" value={result.nsfSuspectCount} tone="muted" sub="verify with carrier" />
                <Stat
                  label="First draft pending"
                  value={result.pendingFirstDraftCount}
                  tone="muted"
                  sub="Issued Not In Force"
                />
                <Stat
                  label="Grace period used"
                  value={
                    Object.keys(result.graceByCompany).length > 0
                      ? Object.entries(result.graceByCompany)
                          .map(([c, g]) => `${c} ${g.grace_days}d`)
                          .join(', ')
                      : `${result.defaultGraceDays}d (fallback)`
                  }
                  tone="muted"
                  sub={
                    Object.keys(result.graceByCompany).length > 0
                      ? Object.entries(result.graceByCompany)
                          .map(([, g]) => `derived from ${g.confidence}/${g.sample} lapsed`)
                          .join(', ')
                      : 'no lapsed rows in file'
                  }
                />
                <Stat label="Snapshot" value={result.snapshotDate} tone="muted" />
              </div>

              {result.assumedCycleModes.length > 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Assumed a monthly draft cycle for unrecognised payment mode(s):{' '}
                  {result.assumedCycleModes.join(', ')}. Confirm the real cycle before acting on those rows.
                </p>
              )}

              <div className="max-h-96 overflow-auto rounded-lg border border-border dark:border-slate-800">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={adminThPlain}>Tier</TableHead>
                      <TableHead className={adminThPlain}>Policy #</TableHead>
                      <TableHead className={adminThPlain}>Insured</TableHead>
                      <TableHead className={adminThPlain}>Mode</TableHead>
                      <TableHead className={adminThPlain}>Draft</TableHead>
                      <TableHead className={cn(adminThPlain, 'text-right')}>Days left</TableHead>
                      <TableHead className={cn(adminThPlain, 'text-right')}>Since pay</TableHead>
                      <TableHead className={adminThPlain}>Failure</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.flagged.slice(0, 200).map((f) => (
                      <TableRow key={`${f.bucket}-${f.policy_number}`} className={adminTableRowInteractive}>
                        <TableCell>
                          {f.tier ? (
                            <Badge variant="outline" className={tierStyles[f.tier]}>
                              {f.tier}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-border text-muted-foreground">
                              {BUCKET_LABELS[f.bucket]}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className={cn(adminTdStrong, 'font-mono text-xs')}>{f.policy_number}</TableCell>
                        <TableCell className={adminTdStrong}>{f.insured || '—'}</TableCell>
                        <TableCell className={adminTdMuted}>
                          {f.pay_mode || '—'}
                          {f.is_installment ? ' (inst.)' : ''}
                        </TableCell>
                        <TableCell className={adminTdMuted}>{money(f.draft_amount)}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                          {f.days_until_lapse ?? '—'}
                        </TableCell>
                        <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                          {f.days_since_pay ?? '—'}
                        </TableCell>
                        <TableCell className={adminTdMuted}>{f.failure_type.replace(/_/g, ' ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {result.flagged.length > 200 && (
                  <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground dark:border-slate-800">
                    Showing the first 200 of {result.flagged.length}. All will be saved.
                  </p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={handleSave} disabled={saving || result.flagged.length === 0}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                  {saving ? 'Saving…' : `Save ${result.flagged.length} flagged polic${result.flagged.length === 1 ? 'y' : 'ies'}`}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={adminOutlineBtn}
                  disabled={saving}
                  onClick={() => {
                    setResult(null)
                    setFileName('')
                    fileRef.current = null
                  }}
                >
                  Discard
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
              <Phone className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              Call list
              {selectedRun && (
                <span className="text-sm font-normal text-muted-foreground">
                  {selectedRun.snapshot_date} · {selectedRun.active_count} active reviewed ·{' '}
                  {money(selectedRun.annual_premium_at_risk)} at risk
                </span>
              )}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Select value={selectedRunId} onValueChange={setSelectedRunId}>
                <SelectTrigger className={cn(adminSelectTrigger, 'w-[280px]')}>
                  <SelectValue placeholder={runs.length ? 'Pick a run' : 'No saved runs yet'} />
                </SelectTrigger>
                <SelectContent className={adminSelectContent}>
                  {runs.map((r) => (
                    <SelectItem key={r.id} value={r.id} className={adminSelectItem}>
                      {r.snapshot_date} — {r.at_risk_count} at risk ({r.critical_count} critical)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                disabled={visible.length === 0}
                onClick={downloadCsv}
              >
                <Download className="mr-2 h-3.5 w-3.5" />
                CSV
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(adminOutlineBtn, 'text-red-600 hover:text-red-700 dark:text-red-400')}
                disabled={!selectedRun}
                onClick={handleDeleteRun}
                title="Delete this run"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center gap-2">
            {(Object.keys(BUCKET_LABELS) as RiskBucket[]).map((bucket) => (
              <button
                key={bucket}
                type="button"
                onClick={() => {
                  setBucketFilter(bucket)
                  setTierFilter('all')
                }}
                className={cn(
                  'rounded-xl border px-3 py-1.5 text-sm font-medium transition-colors',
                  bucketFilter === bucket
                    ? 'border-orange-500/35 bg-orange-500/15 text-foreground dark:text-white'
                    : 'border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground'
                )}
              >
                {BUCKET_LABELS[bucket]}
                <span className="ml-2 tabular-nums text-xs text-muted-foreground">{bucketCounts[bucket]}</span>
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="relative sm:col-span-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Policy, insured, phone, or agent"
                className={cn(adminInput, 'pl-9')}
              />
            </div>
            <Select value={tierFilter} onValueChange={setTierFilter} disabled={bucketFilter !== 'AT_RISK'}>
              <SelectTrigger className={adminSelectTrigger}>
                <SelectValue placeholder="All tiers" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>
                  All tiers
                </SelectItem>
                {(['CRITICAL', 'HIGH', 'EARLY'] as RiskTier[]).map((t) => (
                  <SelectItem key={t} value={t} className={adminSelectItem}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={cn(adminThPlain, 'w-8')} />
                  <TableHead className={adminThPlain}>Tier</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={adminThPlain}>Insured</TableHead>
                  <TableHead className={adminThPlain}>Phone</TableHead>
                  <TableHead className={adminThPlain}>Agent</TableHead>
                  <TableHead className={adminThPlain}>Draft</TableHead>
                  <TableHead className={cn(adminThPlain, 'text-right')}>Days left</TableHead>
                  <TableHead className={adminThPlain}>Failure</TableHead>
                  <TableHead className={adminThPlain}>GHL Stage</TableHead>
                  <TableHead className={cn(adminThPlain, 'text-right')}>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingRun ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={11} className="py-10 text-center text-sm text-muted-foreground">
                      {runs.length === 0
                        ? 'No saved runs yet. Upload a policySummary file above.'
                        : `Nothing in “${BUCKET_LABELS[bucketFilter]}” for this run.`}
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((p) => {
                    const isExpanded = expandedId === p.id
                    const deal = dealFor(p.policy_number)
                    return (
                      <Fragment key={p.id}>
                        <TableRow
                          className={cn(adminTableRowInteractive, 'cursor-pointer')}
                          onClick={() => setExpandedId(isExpanded ? null : p.id)}
                        >
                          <TableCell className="text-muted-foreground">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </TableCell>
                          <TableCell>
                            {p.tier ? (
                              <Badge variant="outline" className={tierStyles[p.tier]}>
                                {p.tier}
                              </Badge>
                            ) : (
                              <span className={adminTdMuted}>—</span>
                            )}
                          </TableCell>
                          <TableCell className={cn(adminTdStrong, 'font-mono text-xs')}>{p.policy_number}</TableCell>
                          <TableCell className={adminTdStrong}>{p.insured || '—'}</TableCell>
                          <TableCell className={cn(adminTdMuted, 'whitespace-nowrap')}>{p.phone || '—'}</TableCell>
                          <TableCell className={adminTdMuted}>{p.agent || '—'}</TableCell>
                          <TableCell className={adminTdMuted}>{money(p.draft_amount)}</TableCell>
                          <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>
                            {p.days_until_lapse ?? '—'}
                          </TableCell>
                          <TableCell className={adminTdMuted}>{p.failure_type.replace(/_/g, ' ')}</TableCell>

                          <TableCell>
                            {deal?.ghl_stage ? (
                              <StageBadge stage={deal.ghl_stage} />
                            ) : deal ? (
                              <span className={adminTdMuted}>—</span>
                            ) : (
                              <span className="text-sm text-muted-foreground">Not in tracker</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={adminOutlineBtn}
                              disabled={!deal}
                              title={deal ? 'Change GHL stage and note the CRM lead' : 'No Deal Tracker row for this policy'}
                              onClick={() => openStageDialog(p)}
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
                                <div className="space-y-3">
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      Why it was flagged
                                    </p>
                                    <p className="mt-1 text-sm leading-relaxed text-foreground dark:text-slate-100">
                                      {p.logic_one_liner}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                      Action
                                    </p>
                                    <p className="mt-1 text-sm leading-relaxed text-foreground dark:text-slate-100">
                                      {p.action_item}
                                    </p>
                                  </div>
                                </div>
                                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                  {[
                                    ['Pay mode', `${p.pay_mode ?? '—'}${p.is_installment ? ' (installment)' : ''}`],
                                    ['Draft cycle', `${p.cycle_days} days`],
                                    ['Effective date', p.effective_date ?? '—'],
                                    ['Paid to date', p.paid_to_date ?? '—'],
                                    ['Last payment', p.last_payment ?? '—'],
                                    ['Expected next draft', p.expected_next_draft ?? '—'],
                                    ['Payments made', p.payments_made ?? '—'],
                                    ['Days since pay', p.days_since_pay ?? '—'],
                                    ['Modal premium', money(p.modal_premium)],
                                    ['Annual premium', money(p.annual_premium)],
                                    ['State', p.state ?? '—'],
                                    ['Status', p.status_category ?? '—'],
                                    ['GHL Stage', deal?.ghl_stage ?? (deal ? '—' : 'Not in Deal Tracker')],
                                    ['GHL Name', deal?.ghl_name ?? '—'],
                                    ['Deal policy status', deal?.policy_status ?? '—'],
                                    ['Call center', deal?.call_center ?? '—'],
                                  ].map(([label, value]) => (
                                    <div key={String(label)}>
                                      <dt className="text-xs text-muted-foreground">{label}</dt>
                                      <dd className={adminTdStrong}>{String(value)}</dd>
                                    </div>
                                  ))}
                                </dl>
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

          {visible.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Showing {visible.length} of {bucketCounts[bucketFilter]} in “{BUCKET_LABELS[bucketFilter]}”. Sorted by
              days until lapse, then annual premium.
              {actionable.length < visible.length && (
                <> {visible.length - actionable.length} row(s) have no Deal Tracker match, so their stage cannot be changed.</>
              )}
            </p>
          )}
        </CardContent>
      </Card>

      <GhlStageChangeDialog
        open={stageDialogOpen}
        onOpenChange={setStageDialogOpen}
        policyNumber={stageDialogRow?.policy_number ?? null}
        deal={stageDialogDeal}
        rowKey={stageDialogRow?.id ?? null}
        sourceRef={stageDialogRow?.id ?? null}
        defaultNote={
          stageDialogRow
            ? `Lapse risk${stageDialogRow.tier ? ` (${stageDialogRow.tier})` : ''}: ${stageDialogRow.logic_one_liner}`
            : ''
        }
        noteHint="Prefilled from the lapse-risk finding. Clear it to change the stage without writing a note."
        onSaved={handleStageSaved}
        position={stageQueue.length ? stageIndex + 1 : undefined}
        total={stageQueue.length || undefined}
        onNavigate={navigateStageQueue}
        context={
          stageDialogRow ? (
            <>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-foreground dark:text-slate-100">
                  {stageDialogRow.policy_number}
                </span>
                <span className="text-muted-foreground">·</span>
                <span className="text-foreground dark:text-slate-100">{stageDialogRow.insured || '—'}</span>
                {stageDialogRow.tier && (
                  <>
                    <span className="text-muted-foreground">·</span>
                    <Badge variant="outline" className={tierStyles[stageDialogRow.tier]}>
                      {stageDialogRow.tier}
                    </Badge>
                  </>
                )}
              </div>
              <p className="text-foreground dark:text-slate-100">
                {stageDialogRow.failure_type.replace(/_/g, ' ')}
                {stageDialogRow.days_until_lapse != null && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {stageDialogRow.days_until_lapse} day(s) of grace left
                  </span>
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">{stageDialogRow.logic_one_liner}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">{stageDialogRow.action_item}</p>
            </>
          ) : null
        }
      />
    </div>
  )
}
