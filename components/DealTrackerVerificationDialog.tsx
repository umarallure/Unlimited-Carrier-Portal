'use client'

import React, { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Loader2, CheckCircle, AlertCircle, PlusCircle, RefreshCw, ChevronDown, ChevronRight, GitCompare, X, ClipboardList } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toYmdForDateInput } from '@/lib/calendarDate'
import { adminOutlineBtn } from '@/lib/adminFieldClasses'
import { isInvalidGhlStageForSave, type DealTrackerPreviewEntry } from '@/lib/dealTracker'

/** Compact inputs inside verification table — theme-aware */
const dialogTableInput =
  'h-8 min-h-8 border-input bg-background text-foreground placeholder:text-muted-foreground text-sm dark:border-slate-800 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500'
const dialogTableInputMono = cn(dialogTableInput, 'font-mono')

type FilterMode = 'all' | 'new' | 'updated' | 'changed' | 'multiple' | 'incomplete'

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  policy_status: 'Policy Status',
  carrier_status: 'Carrier Status (raw)',
  ghl_stage: 'GHL Stage',
  ghl_name: 'GHL Name',
  deal_value: 'Deal Value',
  cc_value: 'CC Value',
  charge_back: 'Charge Back',
  sales_agent: 'Sales Agent',
  writing_number: 'Writing #',
  call_center: 'Call Center',
  phone_number: 'Phone',
  deal_creation_date: 'Deal Date',
  commission_date: 'Commission Date',
  effective_date: 'Effective Date',
  notes: 'Notes',
  status: 'Status',
}

type DdfMatchRow = {
  insured_name: string | null
  call_center: string | null
  phone_number: string | null
}

interface DealTrackerVerificationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: DealTrackerPreviewEntry[]
  /** Shown when dialog is open but entries are still loading (e.g. DDF lookup for large files) */
  loadingMessage?: string | null
  /** Live log lines shown during save (e.g. "Checking existing...", "Inserting batch 1/3...") */
  saveProgressLogs?: string[]
  onConfirm: (entriesToSave: DealTrackerPreviewEntry[]) => Promise<void>
  onCancel: () => void
  /** When set to 'Commission' and onNext is provided, show "Next" instead of "Confirm & Save" to open Commission Report dialog */
  fileType?: string
  onNext?: () => void
}

function formatNum(val: number | null | undefined): string {
  if (val === null || val === undefined) return ''
  return String(val)
}

function parseNum(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t.replace(/[^0-9.-]/g, ''))
  return Number.isNaN(n) ? null : n
}

function dashAsNull(v: unknown): string | null {
  if (v == null) return null
  const t = String(v).trim()
  return t === '' || t === '-' ? null : String(v)
}

export function DealTrackerVerificationDialog({
  open,
  onOpenChange,
  entries,
  loadingMessage,
  saveProgressLogs = [],
  onConfirm,
  onCancel,
  fileType,
  onNext,
}: DealTrackerVerificationDialogProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editableEntries, setEditableEntries] = useState<DealTrackerPreviewEntry[]>([])
  const [filter, setFilter] = useState<FilterMode>('all')
  const isLoading = !!(open && loadingMessage && entries.length === 0)
  const [openDdfRowKey, setOpenDdfRowKey] = useState<string | null>(null)
  const [ddfMatches, setDdfMatches] = useState<Record<string, { loading: boolean; error: string | null; matches: DdfMatchRow[] }>>({})
  const [expandedChangesRowKey, setExpandedChangesRowKey] = useState<string | null>(null)
  const [incompleteSnapshot, setIncompleteSnapshot] = useState<Set<number>>(new Set())

  // Keep editable state in sync with props when dialog opens or entries change
  useEffect(() => {
    if (open && entries.length > 0) {
      setEditableEntries(
        entries.map((e) => ({
          ...e,
          name: dashAsNull(e.name),
          tasks: dashAsNull(e.tasks),
          ghl_name: dashAsNull(e.ghl_name),
          ghl_stage: dashAsNull(e.ghl_stage),
          policy_status: dashAsNull(e.policy_status),
          notes: dashAsNull(e.notes),
          sales_agent: dashAsNull(e.sales_agent),
          writing_number: dashAsNull(e.writing_number),
          call_center: dashAsNull(e.call_center),
          phone_number: dashAsNull(e.phone_number),
          carrier_status: dashAsNull(e.carrier_status),
        }))
      )
      setFilter('all')
      setExpandedChangesRowKey(null)
    }
  }, [open, entries])

  const updateEntry = useCallback((index: number, field: keyof DealTrackerPreviewEntry, value: string | number | null) => {
    setEditableEntries(prev => {
      const next = [...prev]
      const entry = { ...next[index], [field]: value }
      if (field === 'deal_value' && value !== null && typeof value === 'number') {
        entry.cc_value = value / 2
      }
      next[index] = entry
      return next
    })
  }, [])

  // Keep user-typed spacing while editing; only convert truly empty input to null.
  const asNullableInput = (raw: string): string | null => (raw === '' ? null : raw)

  const handleConfirm = async () => {
    const badGhl = editableEntries.find((e) => isInvalidGhlStageForSave(e.ghl_stage))
    if (badGhl) {
      setError(
        'GHL Stage cannot be empty or "-" for any row. Use the Incomplete tab to find and fix those rows before saving.'
      )
      const snap = new Set<number>()
      editableEntries.forEach((e, idx) => {
        if (isInvalidGhlStageForSave(e.ghl_stage)) snap.add(idx)
      })
      setIncompleteSnapshot(snap)
      setFilter('incomplete')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onConfirm(editableEntries)
      onOpenChange(false)
    } catch (err: any) {
      setError(err.message || 'Failed to save entries')
    } finally {
      setSaving(false)
    }
  }

  const handleNextStep = () => {
    const badGhl = editableEntries.find((e) => isInvalidGhlStageForSave(e.ghl_stage))
    if (badGhl) {
      setError(
        'GHL Stage cannot be empty or "-" for any row. Use the Incomplete tab to fix rows before continuing to Commission Report.'
      )
      const snap = new Set<number>()
      editableEntries.forEach((e, idx) => {
        if (isInvalidGhlStageForSave(e.ghl_stage)) snap.add(idx)
      })
      setIncompleteSnapshot(snap)
      setFilter('incomplete')
      return
    }
    setError(null)
    onNext?.()
  }

  const handleCancel = () => {
    setError(null)
    onCancel()
    onOpenChange(false)
  }

  const newCount = editableEntries.filter(e => e.isNew).length
  const updatedCount = editableEntries.filter(e => e.isUpdated && !e.isNew).length
  const changedCount = editableEntries.filter(e => e.isUpdated && !e.isNew && (e.changedFields?.length ?? 0) > 0).length

  // Names that appear more than once among NEW rows (same person, multiple policies) for highlighting
  const duplicateNames = (() => {
    const count = new Map<string, number>()
    editableEntries.forEach(e => {
      if (!e.isNew) return
      const n = (e.name || '').trim().toLowerCase()
      if (n) count.set(n, (count.get(n) || 0) + 1)
    })
    return new Set([...count.entries()].filter(([, c]) => c > 1).map(([name]) => name))
  })()
  const multipleRowsCount = editableEntries.filter(e => {
    if (!e.isNew) return false
    const n = (e.name || '').trim().toLowerCase()
    return n && duplicateNames.has(n)
  }).length

  const incompleteGhlCount = editableEntries.filter((e) => isInvalidGhlStageForSave(e.ghl_stage)).length
  const hasIncompleteGhl = incompleteGhlCount > 0

  const filteredEntries =
    filter === 'new'
      ? editableEntries.filter(e => e.isNew)
      : filter === 'updated'
        ? editableEntries.filter(e => e.isUpdated && !e.isNew)
        : filter === 'changed'
          ? editableEntries.filter(e => e.isUpdated && !e.isNew && (e.changedFields?.length ?? 0) > 0)
          : filter === 'multiple'
            ? editableEntries.filter(e => {
                if (!e.isNew) return false
                const n = (e.name || '').trim().toLowerCase()
                return n && duplicateNames.has(n)
              })
            : filter === 'incomplete'
              ? editableEntries.filter((e, idx) => incompleteSnapshot.has(idx) || isInvalidGhlStageForSave(e.ghl_stage))
              : editableEntries

  const loadDdfMatches = useCallback(async (rowKey: string, carrier: string | null, name: string | null) => {
    const trimmedName = (name || '').trim()
    const trimmedCarrier = (carrier || '').trim()
    if (!trimmedName || !trimmedCarrier) return

    setDdfMatches(prev => {
      const existing = prev[rowKey]
      if (existing && (existing.matches.length > 0 || existing.loading)) {
        return prev
      }
      return {
        ...prev,
        [rowKey]: { loading: true, error: null, matches: [] },
      }
    })

    try {
      const params = new URLSearchParams({ carrier: trimmedCarrier, name: trimmedName })
      const res = await fetch(`/api/ddf-diagnostic?${params.toString()}`)
      const data = await res.json()
      const matches = (data.matchingRows || []) as { insured_name?: string | null; lead_vendor?: string | null; client_phone_number?: string | null }[]
      const mapped: DdfMatchRow[] = matches.map(m => ({
        insured_name: m.insured_name ?? null,
        call_center: (m.lead_vendor as string | null) ?? null,
        phone_number: (m.client_phone_number as string | null) ?? null,
      }))
      setDdfMatches(prev => ({
        ...prev,
        [rowKey]: { loading: false, error: null, matches: mapped },
      }))
    } catch (err: any) {
      setDdfMatches(prev => ({
        ...prev,
        [rowKey]: { loading: false, error: err?.message || 'Failed to load DDF matches', matches: [] },
      }))
    }
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90vh] max-w-[95vw] flex-col overflow-hidden border-border bg-card text-card-foreground sm:rounded-2xl"
        aria-describedby="deal-tracker-desc"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-foreground">Deal Tracker Verification</DialogTitle>
          <DialogDescription id="deal-tracker-desc" className="text-muted-foreground">
            {isLoading ? (loadingMessage ?? 'Loading…') : 'Review and edit entries below.'}
            {!isLoading && <><strong>Call Center</strong> and <strong>Phone</strong> come from Daily Deal Flow (DDF); if they’re empty, no matching row was found in the external DDF for this insured + carrier. You can type them in and save. <strong>Writing #</strong> and <strong>Sales Agent</strong> come from your commission/policy file. Use the filter to see only new or updated rows.</>}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
            <p className="max-w-md text-center text-muted-foreground">{loadingMessage}</p>
          </div>
        )}

        {/* Filter tabs */}
        {!isLoading && (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
            <span className="mr-2 text-sm text-muted-foreground">Show:</span>
            <Button
              type="button"
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'all'
                  ? 'bg-slate-600 text-white hover:bg-slate-700 dark:bg-slate-600 dark:hover:bg-slate-700'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setFilter('all')}
            >
              All ({editableEntries.length})
            </Button>
            <Button
              type="button"
              variant={filter === 'new' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'new'
                  ? 'bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-800'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setFilter('new')}
            >
              <PlusCircle className="mr-1 h-3.5 w-3.5" />
              New ({newCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'updated' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'updated'
                  ? 'bg-blue-600 text-white hover:bg-blue-700 dark:bg-blue-700 dark:hover:bg-blue-800'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setFilter('updated')}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              Updated ({updatedCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'changed' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'changed'
                  ? 'bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-700'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setFilter('changed')}
              title="Rows where at least one field value changed (click a row to see what changed)"
            >
              <GitCompare className="mr-1 h-3.5 w-3.5" />
              Changed ({changedCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'multiple' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'multiple'
                  ? 'bg-amber-700 text-white hover:bg-amber-800 dark:bg-amber-800 dark:hover:bg-amber-900'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setFilter('multiple')}
            >
              <AlertCircle className="mr-1 h-3.5 w-3.5" />
              Multiple ({multipleRowsCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'incomplete' ? 'default' : 'outline'}
              size="sm"
              className={
                filter === 'incomplete'
                  ? 'bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-800'
                  : cn(adminOutlineBtn, 'h-8', hasIncompleteGhl && 'border-rose-400/80 text-rose-800 dark:border-rose-500/60 dark:text-rose-300')
              }
              onClick={() => {
                const snap = new Set<number>()
                editableEntries.forEach((e, idx) => {
                  if (isInvalidGhlStageForSave(e.ghl_stage)) snap.add(idx)
                })
                setIncompleteSnapshot(snap)
                setFilter('incomplete')
              }}
              title="Rows where GHL Stage is missing or set to “-” (cannot save until fixed)"
            >
              <ClipboardList className="mr-1 h-3.5 w-3.5" />
              Incomplete ({incompleteGhlCount})
            </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn(adminOutlineBtn, 'h-8')}
                onClick={() => {
                  const template = editableEntries[0]
                  const base: DealTrackerPreviewEntry = {
                    agency_carrier_id: template?.agency_carrier_id ?? '',
                    name: null,
                    tasks: null,
                    ghl_name: template?.ghl_name ?? null,
                    ghl_stage: template?.ghl_stage ?? null,
                    policy_status: null,
                    deal_creation_date: null,
                    commission_date: null,
                    policy_number: '',
                    carrier: template?.carrier ?? '',
                    carrier_id: template?.carrier_id ?? null,
                    deal_value: null,
                    cc_value: null,
                    charge_back: null,
                    notes: null,
                    status: null,
                    last_updated: new Date().toISOString(),
                    sales_agent: null,
                    writing_number: null,
                    commission_type: null,
                    effective_date: null,
                    call_center: null,
                    phone_number: null,
                    cc_pmt_ws: null,
                    cc_cb_ws: null,
                    carrier_status: null,
                    policy_type: null,
                    daily_deal_flow_fetched: false,
                    daily_deal_flow_fetched_at: null,
                    source_policy_table: null,
                    source_policy_id: null,
                    source_commission_table: null,
                    source_commission_id: null,
                    isNew: true,
                    isUpdated: false,
                  }
                  setEditableEntries(prev => [...prev, base])
                  setFilter('new')
                }}
              >
                <PlusCircle className="mr-1 h-3.5 w-3.5" />
                Add row
              </Button>
            </div>
          </div>
        )}

        {!isLoading && hasIncompleteGhl && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800/80 dark:bg-rose-950/50 dark:text-rose-100"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span>
              <strong>{incompleteGhlCount}</strong> row{incompleteGhlCount === 1 ? ' has' : 's have'} no valid{' '}
              <strong>GHL Stage</strong> (empty or &quot;-&quot;). Fix them on the <strong>Incomplete</strong> tab — saving and
              continuing to Commission Report are blocked until every row has a real stage.
            </span>
          </div>
        )}

        {!isLoading && saving && saveProgressLogs.length > 0 && (
          <div className="max-h-[180px] shrink-0 overflow-y-auto rounded-lg border border-border bg-muted/60 p-4 dark:border-slate-600 dark:bg-slate-800/80">
            <p className="mb-2 text-xs font-medium text-muted-foreground">Saving progress</p>
            <ul className="space-y-1 font-mono text-sm text-foreground/90">
              {saveProgressLogs.map((line, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-blue-600 dark:text-blue-400">›</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isLoading && error && (
          <div className="flex shrink-0 items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-600 dark:bg-red-950/60">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-800 dark:text-red-300">Error</p>
              <p className="text-sm text-red-700 dark:text-red-200">{error}</p>
            </div>
          </div>
        )}

        {!isLoading ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-muted/30 dark:bg-slate-800/40">
            <div className="min-h-[280px] flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 border-b border-border bg-muted/95 backdrop-blur dark:border-slate-700 dark:bg-slate-800/95">
                <TableRow className="border-border hover:bg-transparent dark:border-slate-700">
                  <TableHead className="w-20 font-semibold text-foreground">Status</TableHead>
                  <TableHead className="min-w-[120px] font-semibold text-foreground">Name</TableHead>
                  <TableHead className="w-28 font-semibold text-foreground">Policy #</TableHead>
                  <TableHead className="min-w-[100px] font-semibold text-foreground">Policy Status</TableHead>
                  <TableHead className="min-w-[110px] font-semibold text-foreground">GHL Stage</TableHead>
                  <TableHead className="min-w-[100px] font-semibold text-foreground" title="Raw status from carrier file (no mapping)">Carrier Status (raw)</TableHead>
                  <TableHead className="min-w-[90px] font-semibold text-foreground" title="Rule-based: NOT yet paid / Charge Back / Paid from deal value">Status</TableHead>
                  <TableHead className="w-24 font-semibold text-foreground">Deal Value</TableHead>
                  <TableHead className="w-24 font-semibold text-foreground">CC Value</TableHead>
                  <TableHead className="min-w-[100px] font-semibold text-foreground">Sales Agent</TableHead>
                  <TableHead className="w-24 font-semibold text-foreground">Writing #</TableHead>
                  <TableHead className="w-12 font-semibold text-foreground" title="Daily Deal Flow: did we get call center/phone from external DDF?">DDF</TableHead>
                  <TableHead className="min-w-[90px] font-semibold text-foreground">Call Center</TableHead>
                  <TableHead className="min-w-[100px] font-semibold text-foreground">Phone</TableHead>
                  <TableHead className="w-28 font-semibold text-foreground" title="Policy / deal creation date from carrier">
                    Deal Date
                  </TableHead>
                  <TableHead className="w-28 font-semibold text-foreground" title="Statement / report date from commission file (e.g. AMAM RptDate, Corebridge statement)">
                    Commission Date
                  </TableHead>
                  <TableHead className="w-28 font-semibold text-foreground">Effective Date</TableHead>
                  <TableHead className="min-w-[80px] font-semibold text-foreground">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={18} className="py-8 text-center text-muted-foreground">
                      {filter === 'incomplete'
                        ? 'No incomplete GHL Stage rows — all rows have a valid stage.'
                        : 'No entries match the current filter. Switch to &quot;All&quot; to see all rows.'}
                    </TableCell>
                  </TableRow>
                ) : filteredEntries.map((entry, idx) => {
                  const globalIndex = editableEntries.findIndex(e => e.policy_number === entry.policy_number && e.agency_carrier_id === entry.agency_carrier_id)
                  const isUpdated = entry.isUpdated && !entry.isNew
                  const changed = entry.changedFields ?? []
                  const isDuplicateName = (entry.name || '').trim().toLowerCase() && duplicateNames.has((entry.name || '').trim().toLowerCase())
                  const rowKey = `${entry.agency_carrier_id}-${entry.policy_number}-${globalIndex}`
                  const ddfState = ddfMatches[rowKey] || { loading: false, error: null, matches: [] }
                  const isExpanded = openDdfRowKey === rowKey
                  const changesExpanded = expandedChangesRowKey === rowKey
                  const hasChanges = changed.length > 0
                  const cellChanged = (field: string) => isUpdated && changed.includes(field)
                  const formatChangeValue = (v: unknown): string => {
                    if (v == null) return '—'
                    if (typeof v === 'number') return String(v)
                    const s = String(v).trim()
                    return s || '—'
                  }
                  return (
                    <React.Fragment key={rowKey}>
                    <TableRow
                      className={cn(
                        'border-border dark:border-slate-700',
                        entry.isNew && 'bg-green-50/90 hover:bg-green-100/90 dark:bg-green-950/25 dark:hover:bg-green-950/35',
                        isUpdated && 'bg-blue-50/90 hover:bg-blue-100/90 dark:bg-blue-950/25 dark:hover:bg-blue-950/35',
                        isDuplicateName &&
                          'border-l-2 border-l-amber-500 bg-amber-50/80 hover:bg-amber-100/80 dark:bg-amber-950/30 dark:hover:bg-amber-950/40'
                      )}
                    >
                      <TableCell className="align-middle py-1">
                        <div className="flex flex-col gap-1">
                          {entry.isNew ? (
                            <Badge className="w-fit bg-green-600 text-xs font-semibold text-white hover:bg-green-700">New</Badge>
                          ) : entry.isUpdated ? (
                            <Badge className="w-fit bg-blue-600 text-xs font-semibold text-white hover:bg-blue-700">Updated</Badge>
                          ) : null}
                          {hasChanges && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="flex h-6 w-fit items-center gap-0.5 px-1.5 text-xs text-amber-700 hover:bg-amber-100 hover:text-amber-800 dark:text-amber-400 dark:hover:bg-amber-950/40 dark:hover:text-amber-300"
                              onClick={() => setExpandedChangesRowKey(k => k === rowKey ? null : rowKey)}
                              title="Show what changed"
                            >
                              {changesExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              <GitCompare className="w-3 h-3" />
                              <span>Changes</span>
                            </Button>
                          )}
                          {isDuplicateName && (
                            <Badge variant="outline" className="w-fit border-amber-600 text-xs text-amber-800 dark:border-amber-500 dark:text-amber-400" title="Same insured name appears on multiple rows (multiple policies)">Multiple</Badge>
                          )}
                          <div className="flex">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 w-fit px-1.5 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                              onClick={() =>
                                setEditableEntries(prev => prev.filter((_, i) => i !== globalIndex))
                              }
                              title="Remove this row from this upload (will not be saved/updated)"
                            >
                              <X className="w-3.5 h-3.5" />
                              <span className="ml-0.5">Remove</span>
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('name') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.name ?? ''}
                          onChange={e => updateEntry(globalIndex, 'name', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1 align-middle', cellChanged('policy_number') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        {entry.isNew ? (
                          <Input
                            value={entry.policy_number ?? ''}
                            onChange={e => updateEntry(globalIndex, 'policy_number', e.target.value)}
                            className={dialogTableInputMono}
                            placeholder="Policy #"
                          />
                        ) : (
                          <span className="font-mono text-sm text-muted-foreground">{entry.policy_number}</span>
                        )}
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('policy_status') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.policy_status ?? ''}
                          onChange={e => updateEntry(globalIndex, 'policy_status', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('ghl_stage') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.ghl_stage ?? ''}
                          onChange={e => updateEntry(globalIndex, 'ghl_stage', asNullableInput(e.target.value))}
                          className={cn(
                            dialogTableInput,
                            isInvalidGhlStageForSave(entry.ghl_stage) &&
                              'border-rose-500 ring-2 ring-rose-500/40 dark:border-rose-500 dark:ring-rose-500/30'
                          )}
                          placeholder="Required — not “-”"
                          aria-invalid={isInvalidGhlStageForSave(entry.ghl_stage)}
                        />
                      </TableCell>
                      <TableCell className={cn('p-1 text-sm text-muted-foreground', cellChanged('carrier_status') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')} title="Raw status from carrier file">
                        {entry.carrier_status ?? '-'}
                      </TableCell>
                      <TableCell className={cn('p-1 align-middle text-sm text-muted-foreground', cellChanged('status') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')} title="Rule-based from deal value: NOT yet paid / Charge Back / Paid">
                        <span className="font-medium">{entry.status ?? '—'}</span>
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('deal_value') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          type="number"
                          step="0.01"
                          value={formatNum(entry.deal_value)}
                          onChange={e => {
                            const v = parseNum(e.target.value)
                            updateEntry(globalIndex, 'deal_value', v)
                          }}
                          className={cn(dialogTableInput, 'w-22')}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('cc_value') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          type="number"
                          step="0.01"
                          value={formatNum(entry.cc_value)}
                          onChange={e => updateEntry(globalIndex, 'cc_value', parseNum(e.target.value))}
                          className={cn(dialogTableInput, 'w-22')}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('sales_agent') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.sales_agent ?? ''}
                          onChange={e => updateEntry(globalIndex, 'sales_agent', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('writing_number') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.writing_number ?? ''}
                          onChange={e => updateEntry(globalIndex, 'writing_number', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className="py-1 align-middle text-center" title={(entry.call_center || entry.phone_number) ? 'Call center/phone from Daily Deal Flow' : 'No DDF data for this row (no match or empty in DDF)'}>
                        <div className="flex flex-col items-center gap-1">
                          {(entry.call_center || entry.phone_number) ? (
                            <span className="font-semibold text-green-600 dark:text-green-400">✓</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                          {isDuplicateName && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 border-amber-600 px-2 text-[11px] text-amber-800 hover:bg-amber-50 dark:border-amber-500 dark:text-amber-300 dark:hover:bg-amber-900/40"
                              onClick={() => {
                                const nextOpen = isExpanded ? null : rowKey
                                setOpenDdfRowKey(nextOpen)
                                if (!isExpanded) {
                                  loadDdfMatches(rowKey, entry.carrier, entry.name)
                                }
                              }}
                            >
                              {isExpanded ? 'Hide DDF' : 'View DDF'}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('call_center') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.call_center ?? ''}
                          onChange={e => updateEntry(globalIndex, 'call_center', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('phone_number') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.phone_number ?? ''}
                          onChange={e => updateEntry(globalIndex, 'phone_number', asNullableInput(e.target.value))}
                          className={dialogTableInputMono}
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('deal_creation_date') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          type="date"
                          value={toYmdForDateInput(entry.deal_creation_date)}
                          onChange={e => updateEntry(globalIndex, 'deal_creation_date', asNullableInput(e.target.value))}
                          className={cn(dialogTableInput, '[color-scheme:light] dark:[color-scheme:dark]')}
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('commission_date') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          type="date"
                          value={toYmdForDateInput(entry.commission_date)}
                          onChange={e => updateEntry(globalIndex, 'commission_date', asNullableInput(e.target.value))}
                          className={cn(dialogTableInput, '[color-scheme:light] dark:[color-scheme:dark]')}
                          title="From commission file (not stored on deal_tracker row)"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('effective_date') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          type="date"
                          value={toYmdForDateInput(entry.effective_date)}
                          onChange={e => updateEntry(globalIndex, 'effective_date', asNullableInput(e.target.value))}
                          className={cn(dialogTableInput, '[color-scheme:light] dark:[color-scheme:dark]')}
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('notes') && 'border-l-2 border-amber-500 bg-amber-100/50 dark:bg-amber-500/20')}>
                        <Input
                          value={entry.notes ?? ''}
                          onChange={e => updateEntry(globalIndex, 'notes', asNullableInput(e.target.value))}
                          className={dialogTableInput}
                          placeholder="-"
                        />
                      </TableCell>
                    </TableRow>
                    {changesExpanded && hasChanges && (
                      <TableRow className="border-border bg-muted/70 dark:border-slate-700 dark:bg-slate-950/80">
                        <TableCell colSpan={18} className="border-t-0 px-4 py-3">
                          <div className="mb-2 text-xs font-medium text-muted-foreground">What changed (previous → current)</div>
                          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                            {(entry.changedFields ?? []).map(field => {
                              const label = FIELD_LABELS[field] ?? field.replace(/_/g, ' ')
                              const oldVal = entry.previousValues?.[field]
                              const newVal = (entry as unknown as Record<string, unknown>)[field]
                              return (
                                <div key={field} className="flex items-center gap-2 text-foreground">
                                  <span className="shrink-0 text-muted-foreground">{label}:</span>
                                  <span className="text-red-600 line-through dark:text-red-300/90">{formatChangeValue(oldVal)}</span>
                                  <span className="text-muted-foreground">→</span>
                                  <span className="font-medium text-green-700 dark:text-green-300/90">{formatChangeValue(newVal)}</span>
                                </div>
                              )
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {isExpanded && (
                      <TableRow key={`${rowKey}-ddf`}>
                        <TableCell colSpan={18} className="border-t border-border bg-muted/50 py-2 dark:border-slate-700 dark:bg-slate-950/60">
                          {ddfState.loading && (
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              Loading DDF matches…
                            </div>
                          )}
                          {!ddfState.loading && ddfState.error && (
                            <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-300">
                              <AlertCircle className="h-4 w-4" />
                              {ddfState.error}
                            </div>
                          )}
                          {!ddfState.loading && !ddfState.error && ddfState.matches.length === 0 && (
                            <div className="text-xs text-muted-foreground">No DDF matches found for this name/carrier.</div>
                          )}
                          {!ddfState.loading && !ddfState.error && ddfState.matches.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-xs text-muted-foreground">DDF matches for this insured (click &quot;Use&quot; to apply Call Center/Phone):</div>
                              <div className="overflow-hidden rounded-md border border-border dark:border-slate-700">
                                <Table>
                                  <TableHeader>
                                    <TableRow className="bg-muted/80 dark:bg-slate-900">
                                      <TableHead className="text-xs text-foreground">Insured (DDF)</TableHead>
                                      <TableHead className="text-xs text-foreground">Call Center</TableHead>
                                      <TableHead className="text-xs text-foreground">Phone</TableHead>
                                      <TableHead className="w-20 text-right text-xs text-foreground">Action</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {ddfState.matches.map((m, i) => (
                                      <TableRow key={`${rowKey}-ddf-${i}`} className="bg-background/80 dark:bg-slate-900/60">
                                        <TableCell className="text-xs text-foreground">{m.insured_name ?? '-'}</TableCell>
                                        <TableCell className="text-xs text-foreground">{m.call_center ?? '-'}</TableCell>
                                        <TableCell className="font-mono text-xs text-foreground">{m.phone_number ?? '-'}</TableCell>
                                        <TableCell className="text-right">
                                          <Button
                                            type="button"
                                            size="sm"
                                            className="h-6 px-2 text-[11px]"
                                            onClick={() => {
                                              updateEntry(globalIndex, 'call_center', m.call_center ?? null)
                                              updateEntry(globalIndex, 'phone_number', m.phone_number ?? null)
                                            }}
                                          >
                                            Use
                                          </Button>
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                    </React.Fragment>
                  )
                })}
              </TableBody>
            </Table>
            </div>
          </div>
        ) : null}

        <DialogFooter className="shrink-0 border-t border-border pt-4 dark:border-slate-700">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={saving}
            className={adminOutlineBtn}
          >
            Cancel
          </Button>
          {fileType === 'Commission' && onNext ? (
            <Button
              onClick={handleNextStep}
              disabled={isLoading || editableEntries.length === 0 || hasIncompleteGhl}
              title={
                hasIncompleteGhl
                  ? 'Set a valid GHL Stage on every row (use Incomplete tab) before continuing'
                  : undefined
              }
              className="min-w-[120px] bg-orange-600 font-semibold text-white hover:bg-orange-700"
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={handleConfirm}
              disabled={saving || isLoading || editableEntries.length === 0 || hasIncompleteGhl}
              title={
                hasIncompleteGhl
                  ? 'Set a valid GHL Stage on every row (use Incomplete tab) before saving'
                  : undefined
              }
              className="min-w-[140px] bg-blue-600 font-semibold text-white hover:bg-blue-700"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                <>
                  <CheckCircle className="w-4 h-4 mr-2" />
                  Confirm & Save
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
