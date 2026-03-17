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
import { Loader2, CheckCircle, AlertCircle, PlusCircle, RefreshCw, ChevronDown, ChevronRight, GitCompare, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DealTrackerPreviewEntry } from '@/lib/dealTracker'

type FilterMode = 'all' | 'new' | 'updated' | 'changed' | 'multiple'

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

/** Normalize date for input[type="date"]: expect YYYY-MM-DD or ISO string */
function toDateInputValue(val: string | null | undefined): string {
  if (!val) return ''
  const d = new Date(val)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
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

  // Keep editable state in sync with props when dialog opens or entries change
  useEffect(() => {
    if (open && entries.length > 0) {
      setEditableEntries(entries.map(e => ({ ...e })))
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

  const handleConfirm = async () => {
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
      <DialogContent className="max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col bg-slate-900 border-slate-700 text-slate-50" aria-describedby="deal-tracker-desc">
        <DialogHeader>
          <DialogTitle className="text-slate-50 text-xl font-semibold">Deal Tracker Verification</DialogTitle>
          <DialogDescription id="deal-tracker-desc" className="text-slate-300">
            {isLoading ? (loadingMessage ?? 'Loading…') : 'Review and edit entries below.'}
            {!isLoading && <><strong>Call Center</strong> and <strong>Phone</strong> come from Daily Deal Flow (DDF); if they’re empty, no matching row was found in the external DDF for this insured + carrier. You can type them in and save. <strong>Writing #</strong> and <strong>Sales Agent</strong> come from your commission/policy file. Use the filter to see only new or updated rows.</>}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex flex-col items-center justify-center gap-4 py-12">
            <Loader2 className="h-10 w-10 animate-spin text-slate-400" />
            <p className="text-slate-300 text-center max-w-md">{loadingMessage}</p>
          </div>
        )}

        {/* Filter tabs */}
        {!isLoading && (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-400 text-sm mr-2">Show:</span>
            <Button
              type="button"
              variant={filter === 'all' ? 'default' : 'outline'}
              size="sm"
              className={filter === 'all' ? 'bg-slate-600 hover:bg-slate-700' : 'border-slate-600 text-slate-300'}
              onClick={() => setFilter('all')}
            >
              All ({editableEntries.length})
            </Button>
            <Button
              type="button"
              variant={filter === 'new' ? 'default' : 'outline'}
              size="sm"
              className={filter === 'new' ? 'bg-green-700 hover:bg-green-800' : 'border-slate-600 text-slate-300'}
              onClick={() => setFilter('new')}
            >
              <PlusCircle className="w-3.5 h-3.5 mr-1" />
              New ({newCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'updated' ? 'default' : 'outline'}
              size="sm"
              className={filter === 'updated' ? 'bg-blue-700 hover:bg-blue-800' : 'border-slate-600 text-slate-300'}
              onClick={() => setFilter('updated')}
            >
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Updated ({updatedCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'changed' ? 'default' : 'outline'}
              size="sm"
              className={filter === 'changed' ? 'bg-amber-600 hover:bg-amber-700' : 'border-slate-600 text-slate-300'}
              onClick={() => setFilter('changed')}
              title="Rows where at least one field value changed (click a row to see what changed)"
            >
              <GitCompare className="w-3.5 h-3.5 mr-1" />
              Changed ({changedCount})
            </Button>
            <Button
              type="button"
              variant={filter === 'multiple' ? 'default' : 'outline'}
              size="sm"
              className={filter === 'multiple' ? 'bg-amber-700 hover:bg-amber-800' : 'border-slate-600 text-slate-300'}
              onClick={() => setFilter('multiple')}
            >
              <AlertCircle className="w-3.5 h-3.5 mr-1" />
              Multiple ({multipleRowsCount})
            </Button>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="border-slate-600 text-slate-200 hover:bg-slate-800"
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
                <PlusCircle className="w-3.5 h-3.5 mr-1" />
                Add row
              </Button>
            </div>
          </div>
        )}

        {!isLoading && saving && saveProgressLogs.length > 0 && (
          <div className="bg-slate-800/80 border border-slate-600 rounded-lg p-4 shrink-0 max-h-[180px] overflow-y-auto">
            <p className="text-xs font-medium text-slate-400 mb-2">Saving progress</p>
            <ul className="space-y-1 text-sm font-mono text-slate-300">
              {saveProgressLogs.map((line, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="text-blue-400">›</span>
                  {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        {!isLoading && error && (
          <div className="bg-red-950/60 border border-red-600 rounded-md p-4 flex items-start gap-2 shrink-0">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-300">Error</p>
              <p className="text-sm text-red-200">{error}</p>
            </div>
          </div>
        )}

        {!isLoading ? (
          <div className="border border-slate-700 rounded-lg overflow-hidden bg-slate-800 flex-1 min-h-0 flex flex-col">
            <div className="overflow-auto flex-1 min-h-[280px]">
            <Table>
              <TableHeader className="sticky top-0 bg-slate-800 border-b border-slate-700 z-10">
                <TableRow className="hover:bg-slate-800">
                  <TableHead className="w-20 text-slate-200 font-semibold">Status</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[120px]">Name</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-28">Policy #</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[100px]">Policy Status</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[110px]">GHL Stage</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[100px]" title="Raw status from carrier file (no mapping)">Carrier Status (raw)</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[90px]" title="Rule-based: NOT yet paid / Charge Back / Paid from deal value">Status</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-24">Deal Value</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-24">CC Value</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[100px]">Sales Agent</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-24">Writing #</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-12" title="Daily Deal Flow: did we get call center/phone from external DDF?">DDF</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[90px]">Call Center</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[100px]">Phone</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-28">Deal Date</TableHead>
                  <TableHead className="text-slate-200 font-semibold w-28">Effective Date</TableHead>
                  <TableHead className="text-slate-200 font-semibold min-w-[80px]">Notes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={17} className="text-center text-slate-500 py-8">
                      No entries match the current filter. Switch to &quot;All&quot; to see all rows.
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
                        'border-slate-700',
                        entry.isNew && 'bg-green-950/25 hover:bg-green-950/35',
                        isUpdated && 'bg-blue-950/25 hover:bg-blue-950/35',
                        isDuplicateName && 'bg-amber-950/30 hover:bg-amber-950/40 border-l-2 border-l-amber-500'
                      )}
                    >
                      <TableCell className="align-middle py-1">
                        <div className="flex flex-col gap-1">
                          {entry.isNew ? (
                            <Badge className="bg-green-600 hover:bg-green-700 text-white font-semibold text-xs w-fit">New</Badge>
                          ) : entry.isUpdated ? (
                            <Badge className="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs w-fit">Updated</Badge>
                          ) : null}
                          {hasChanges && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-amber-400 hover:text-amber-300 hover:bg-amber-950/40 text-xs flex items-center gap-0.5 w-fit"
                              onClick={() => setExpandedChangesRowKey(k => k === rowKey ? null : rowKey)}
                              title="Show what changed"
                            >
                              {changesExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                              <GitCompare className="w-3 h-3" />
                              <span>Changes</span>
                            </Button>
                          )}
                          {isDuplicateName && (
                            <Badge variant="outline" className="border-amber-500 text-amber-400 text-xs w-fit" title="Same insured name appears on multiple rows (multiple policies)">Multiple</Badge>
                          )}
                          <div className="flex">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 px-1.5 text-red-400 hover:text-red-300 hover:bg-red-950/40 text-xs w-fit"
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
                      <TableCell className={cn('p-1', cellChanged('name') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.name ?? ''}
                          onChange={e => updateEntry(globalIndex, 'name', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1 align-middle', cellChanged('policy_number') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.isNew ? (
                          <Input
                            value={entry.policy_number ?? ''}
                            onChange={e => updateEntry(globalIndex, 'policy_number', e.target.value.trim())}
                            className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm font-mono"
                            placeholder="Policy #"
                          />
                        ) : (
                          <span className="font-mono text-slate-300 text-sm">{entry.policy_number}</span>
                        )}
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('policy_status') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.policy_status ?? ''}
                          onChange={e => updateEntry(globalIndex, 'policy_status', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('ghl_stage') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.ghl_stage ?? ''}
                          onChange={e => updateEntry(globalIndex, 'ghl_stage', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1 text-slate-300 text-sm', cellChanged('carrier_status') && 'bg-amber-500/20 border-l-2 border-amber-500')} title="Raw status from carrier file">
                        {entry.carrier_status ?? '-'}
                      </TableCell>
                      <TableCell className={cn('p-1 text-slate-300 text-sm align-middle', cellChanged('status') && 'bg-amber-500/20 border-l-2 border-amber-500')} title="Rule-based from deal value: NOT yet paid / Charge Back / Paid">
                        <span className="font-medium">{entry.status ?? '—'}</span>
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('deal_value') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          type="number"
                          step="0.01"
                          value={formatNum(entry.deal_value)}
                          onChange={e => {
                            const v = parseNum(e.target.value)
                            updateEntry(globalIndex, 'deal_value', v)
                          }}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm w-22"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('cc_value') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          type="number"
                          step="0.01"
                          value={formatNum(entry.cc_value)}
                          onChange={e => updateEntry(globalIndex, 'cc_value', parseNum(e.target.value))}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm w-22"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('sales_agent') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.sales_agent ?? ''}
                          onChange={e => updateEntry(globalIndex, 'sales_agent', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('writing_number') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.writing_number ?? ''}
                          onChange={e => updateEntry(globalIndex, 'writing_number', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className="py-1 align-middle text-center" title={(entry.call_center || entry.phone_number) ? 'Call center/phone from Daily Deal Flow' : 'No DDF data for this row (no match or empty in DDF)'}>
                        <div className="flex flex-col items-center gap-1">
                          {(entry.call_center || entry.phone_number) ? (
                            <span className="text-green-400 font-semibold">✓</span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                          {isDuplicateName && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px] border-amber-500 text-amber-300 hover:bg-amber-900/40"
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
                      <TableCell className={cn('p-1', cellChanged('call_center') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.call_center ?? ''}
                          onChange={e => updateEntry(globalIndex, 'call_center', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('phone_number') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.phone_number ?? ''}
                          onChange={e => updateEntry(globalIndex, 'phone_number', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm font-mono"
                          placeholder="-"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('deal_creation_date') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          type="date"
                          value={toDateInputValue(entry.deal_creation_date)}
                          onChange={e => updateEntry(globalIndex, 'deal_creation_date', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('effective_date') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          type="date"
                          value={toDateInputValue(entry.effective_date)}
                          onChange={e => updateEntry(globalIndex, 'effective_date', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                        />
                      </TableCell>
                      <TableCell className={cn('p-1', cellChanged('notes') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Input
                          value={entry.notes ?? ''}
                          onChange={e => updateEntry(globalIndex, 'notes', e.target.value.trim() || null)}
                          className="h-8 bg-slate-900 border-slate-600 text-slate-100 text-sm"
                          placeholder="-"
                        />
                      </TableCell>
                    </TableRow>
                    {changesExpanded && hasChanges && (
                      <TableRow className="bg-slate-950/80 border-slate-700">
                        <TableCell colSpan={17} className="py-3 px-4 border-t-0">
                          <div className="text-xs font-medium text-slate-400 mb-2">What changed (previous → current)</div>
                          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
                            {(entry.changedFields ?? []).map(field => {
                              const label = FIELD_LABELS[field] ?? field.replace(/_/g, ' ')
                              const oldVal = entry.previousValues?.[field]
                              const newVal = (entry as unknown as Record<string, unknown>)[field]
                              return (
                                <div key={field} className="flex items-center gap-2 text-slate-200">
                                  <span className="text-slate-500 shrink-0">{label}:</span>
                                  <span className="text-red-300/90 line-through">{formatChangeValue(oldVal)}</span>
                                  <span className="text-slate-500">→</span>
                                  <span className="text-green-300/90 font-medium">{formatChangeValue(newVal)}</span>
                                </div>
                              )
                            })}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                    {isExpanded && (
                      <TableRow key={`${rowKey}-ddf`}>
                        <TableCell colSpan={17} className="bg-slate-950/60 border-t border-slate-700 py-2">
                          {ddfState.loading && (
                            <div className="flex items-center gap-2 text-xs text-slate-300">
                              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                              Loading DDF matches…
                            </div>
                          )}
                          {!ddfState.loading && ddfState.error && (
                            <div className="text-xs text-red-300 flex items-center gap-2">
                              <AlertCircle className="h-4 w-4" />
                              {ddfState.error}
                            </div>
                          )}
                          {!ddfState.loading && !ddfState.error && ddfState.matches.length === 0 && (
                            <div className="text-xs text-slate-400">No DDF matches found for this name/carrier.</div>
                          )}
                          {!ddfState.loading && !ddfState.error && ddfState.matches.length > 0 && (
                            <div className="space-y-1">
                              <div className="text-xs text-slate-400">DDF matches for this insured (click &quot;Use&quot; to apply Call Center/Phone):</div>
                              <div className="border border-slate-700 rounded-md overflow-hidden">
                                <Table>
                                  <TableHeader>
                                    <TableRow className="bg-slate-900">
                                      <TableHead className="text-xs text-slate-300">Insured (DDF)</TableHead>
                                      <TableHead className="text-xs text-slate-300">Call Center</TableHead>
                                      <TableHead className="text-xs text-slate-300">Phone</TableHead>
                                      <TableHead className="text-xs text-slate-300 w-20 text-right">Action</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {ddfState.matches.map((m, i) => (
                                      <TableRow key={`${rowKey}-ddf-${i}`} className="bg-slate-900/60">
                                        <TableCell className="text-xs text-slate-200">{m.insured_name ?? '-'}</TableCell>
                                        <TableCell className="text-xs text-slate-200">{m.call_center ?? '-'}</TableCell>
                                        <TableCell className="text-xs text-slate-200 font-mono">{m.phone_number ?? '-'}</TableCell>
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

        <DialogFooter className="border-t border-slate-700 pt-4 shrink-0">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={saving}
            className="border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          >
            Cancel
          </Button>
          {fileType === 'Commission' && onNext ? (
            <Button
              onClick={() => onNext()}
              disabled={isLoading || editableEntries.length === 0}
              className="min-w-[120px] bg-orange-600 hover:bg-orange-700 text-white font-semibold"
            >
              Next
            </Button>
          ) : (
            <Button
              onClick={handleConfirm}
              disabled={saving || isLoading || editableEntries.length === 0}
              className="min-w-[140px] bg-blue-600 hover:bg-blue-700 text-white font-semibold"
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
