'use client'

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, PlusCircle, X, AlertTriangle, ClipboardList, AlertCircle } from 'lucide-react'
import {
  findWithinFileCommissionDuplicates,
  findTrackerCommissionDuplicates,
  isCommissionRowIncomplete,
  validateCommissionRowsForSave,
  type CommissionDisplayRow,
  type CommissionDuplicateIssue,
} from '@/lib/useCommissionReportUpload'
import { cn } from '@/lib/utils'
import { extractYmdFromDbValue, toYmdForDateInput } from '@/lib/calendarDate'
import { adminOutlineBtn, adminSelectTrigger } from '@/lib/adminFieldClasses'

const commissionDialogInput =
  'h-8 min-h-8 border-input bg-background text-foreground placeholder:text-muted-foreground text-sm dark:border-slate-800 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500'
const commissionDialogInputMono = cn(commissionDialogInput, 'font-mono')

function fieldEmptyOrDash(v: string): boolean {
  const t = (v || '').trim()
  return t === '' || t === '-'
}

/** YYYY-MM-DD for date inputs; prefer literal calendar day from DB (no UTC shift). */
function normalizeToYmd(val: string): string {
  const t = (val || '').trim()
  if (!t) return ''
  const ymd = extractYmdFromDbValue(t)
  if (ymd) return ymd
  return toYmdForDateInput(t)
}

function todayYmd(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function commissionReportCarrierTitle(code: string): string {
  const c = (code || '').toUpperCase()
  if (c === 'AMAM') return 'AMAM'
  if (c === 'MOH') return 'MOH'
  if (c === 'COREBRIDGE') return 'Corebridge'
  if (c === 'AETNA') return 'Aetna'
  if (c === 'AFLAC') return 'Aflac'
  if (c === 'AHL') return 'AHL'
  return code?.trim() || 'Carrier'
}

type CommissionRowFilter = 'all' | 'incomplete'

export interface CommissionReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: CommissionDisplayRow[]
  loading?: boolean
  saving?: boolean
  onSave: (editedRows: CommissionDisplayRow[]) => Promise<void>
  carrierCode: string
  /** When set, payload is checked against commission_tracker before save. */
  agencyCarrierId?: string
  fileId?: string
  /** With duplicate warnings: save deal tracker only and roll back this upload commission rows (optional). */
  onSaveDealTrackerOnly?: () => Promise<void>
}

export function CommissionReportDialog({
  open,
  onOpenChange,
  rows,
  loading = false,
  saving = false,
  onSave,
  carrierCode,
  agencyCarrierId,
  fileId,
  onSaveDealTrackerOnly,
}: CommissionReportDialogProps) {
  const [editableRows, setEditableRows] = useState<CommissionDisplayRow[]>([])
  /** One statement / commission date for every row in this file (all carriers). */
  const [headerStatementDate, setHeaderStatementDate] = useState('')
  const [duplicateIssues, setDuplicateIssues] = useState<CommissionDuplicateIssue[] | null>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)
  const [rowFilter, setRowFilter] = useState<CommissionRowFilter>('all')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [incompleteSnapshot, setIncompleteSnapshot] = useState<Set<number>>(new Set())
  const [savingDealTrackerOnly, setSavingDealTrackerOnly] = useState(false)

  useEffect(() => {
    if (open && rows.length > 0) {
      const copied = rows.map((r) => ({ ...r }))
      setEditableRows(copied)
      const fromFile = copied.find((r) => r.date && String(r.date).trim())?.date?.trim() ?? ''
      const ymd = normalizeToYmd(fromFile) || todayYmd()
      setHeaderStatementDate(ymd)
    } else if (open && rows.length === 0 && !loading) {
      setEditableRows([])
      setHeaderStatementDate('')
    }
  }, [open, rows, loading])

  useEffect(() => {
    if (!open) setDuplicateIssues(null)
  }, [open])

  useEffect(() => {
    if (open) {
      setSaveError(null)
      setRowFilter('all')
    }
  }, [open])

  const buildSavePayload = useCallback((): CommissionDisplayRow[] => {
    const ymd = headerStatementDate.trim() || todayYmd()
    return editableRows.map((r) => ({ ...r, date: ymd }))
  }, [editableRows, headerStatementDate])

  const applyStatementDateToAllRows = (ymd: string) => {
    const d = (ymd || '').trim() || todayYmd()
    setHeaderStatementDate(d)
    setEditableRows((prev) => prev.map((r) => ({ ...r, date: d })))
  }

  const updateRow = (index: number, field: keyof CommissionDisplayRow, value: string) => {
    setEditableRows((prev) => {
      const next = [...prev]
      if (next[index]) next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const runSave = async (forceIgnoreDuplicates: boolean) => {
    const payload = buildSavePayload()
    const stmt = headerStatementDate.trim() || todayYmd()

    const validationErr = validateCommissionRowsForSave(payload)
    if (validationErr) {
      setSaveError(validationErr)
      const snap = new Set<number>()
      editableRows.forEach((r, idx) => {
        if (isCommissionRowIncomplete(r)) snap.add(idx)
      })
      setIncompleteSnapshot(snap)
      setRowFilter('incomplete')
      return
    }
    setSaveError(null)

    if (!forceIgnoreDuplicates) {
      setCheckingDuplicates(true)
      try {
        const within = findWithinFileCommissionDuplicates(payload, carrierCode, stmt)
        const tracker =
          agencyCarrierId && fileId
            ? await findTrackerCommissionDuplicates(agencyCarrierId, payload, carrierCode, stmt, fileId)
            : []
        const combined = [...within, ...tracker]
        if (combined.length) {
          setDuplicateIssues(combined)
          return
        }
      } finally {
        setCheckingDuplicates(false)
      }
    }

    setDuplicateIssues(null)
    try {
      await onSave(payload)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Save failed'
      setSaveError(msg)
    }
  }

  const handleCancel = () => {
    setDuplicateIssues(null)
    setSaveError(null)
    onOpenChange(false)
  }

  const runSaveDealTrackerOnly = async () => {
    if (!onSaveDealTrackerOnly) return
    setSaveError(null)
    setSavingDealTrackerOnly(true)
    try {
      await onSaveDealTrackerOnly()
      setDuplicateIssues(null)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to save deal tracker'
      setSaveError(msg)
    } finally {
      setSavingDealTrackerOnly(false)
    }
  }

  const incompleteCommissionCount = useMemo(
    () => editableRows.filter((r) => isCommissionRowIncomplete(r)).length,
    [editableRows]
  )
  const hasIncompleteCommission = incompleteCommissionCount > 0

  const rowsToShow = useMemo(() => {
    if (rowFilter === 'incomplete') {
      return editableRows
        .map((row, idx) => ({ row, idx }))
        .filter(({ row, idx }) => incompleteSnapshot.has(idx) || isCommissionRowIncomplete(row))
    }
    return editableRows.map((row, idx) => ({ row, idx }))
  }, [editableRows, rowFilter, incompleteSnapshot])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] max-w-6xl flex-col border-border bg-card text-card-foreground sm:rounded-2xl">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            Commission Report — {commissionReportCarrierTitle(carrierCode)}
          </DialogTitle>
          <DialogDescription className="flex flex-col gap-3 text-muted-foreground sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <span className="min-w-0">
              Review and edit commission rows, then Save. Data will appear on the Commission Report page.
            </span>
            {!loading && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={cn('shrink-0 sm:self-start', adminOutlineBtn)}
                onClick={() => {
                  const template = editableRows[0]
                  const base: CommissionDisplayRow = {
                    id: undefined,
                    name: '',
                    date: headerStatementDate.trim() || todayYmd(),
                    policy_number: '',
                    carrier: template?.carrier ?? (carrierCode || ''),
                    sales_agent: '',
                    commission_rate: '',
                    advance: '',
                    charge_back: '',
                  }
                  setEditableRows(prev => [...prev, base])
                }}
              >
                <PlusCircle className="w-3.5 h-3.5 mr-1" />
                Add row
              </Button>
            )}
          </DialogDescription>
          {!loading && editableRows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 dark:border-slate-700 dark:bg-slate-800/40">
              <div className="space-y-1">
                <Label htmlFor="commission-statement-date" className="text-xs font-medium text-foreground">
                  Statement / commission date (one date for this entire file)
                </Label>
                <Input
                  id="commission-statement-date"
                  type="date"
                  value={headerStatementDate.trim() ? headerStatementDate : todayYmd()}
                  onChange={(e) => applyStatementDateToAllRows(e.target.value)}
                  className={cn('h-9 w-[11.5rem] text-sm [color-scheme:light] dark:[color-scheme:dark]', adminSelectTrigger)}
                />
              </div>
              <p className="max-w-md pb-0.5 text-xs text-muted-foreground">
                Defaults to <span className="text-foreground/80">today</span> when the file has no parseable date. Applies
                to every row on Save (
                <span className="text-foreground/80">
                  e.g. AMAM <code className="text-[11px]">statement_date</code>, Aetna{' '}
                  <code className="text-[11px]">commissionpaiddate</code>, MOH{' '}
                  <code className="text-[11px]">activity_date</code>, Corebridge{' '}
                  <code className="text-[11px]">statement_date</code>
                </span>
                ).
              </p>
            </div>
          )}
        </DialogHeader>

        {!loading && editableRows.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            <Button
              type="button"
              size="sm"
              variant={rowFilter === 'all' ? 'default' : 'outline'}
              className={
                rowFilter === 'all'
                  ? 'h-8 bg-slate-600 text-white hover:bg-slate-700 dark:bg-slate-600 dark:hover:bg-slate-700'
                  : cn(adminOutlineBtn, 'h-8')
              }
              onClick={() => setRowFilter('all')}
            >
              All ({editableRows.length})
            </Button>
            <Button
              type="button"
              size="sm"
              variant={rowFilter === 'incomplete' ? 'default' : 'outline'}
              className={
                rowFilter === 'incomplete'
                  ? 'h-8 bg-rose-600 text-white hover:bg-rose-700 dark:bg-rose-700 dark:hover:bg-rose-800'
                  : cn(adminOutlineBtn, 'h-8', hasIncompleteCommission && 'border-rose-400/80 text-rose-800 dark:border-rose-500/60 dark:text-rose-300')
              }
              onClick={() => {
                const snap = new Set<number>()
                editableRows.forEach((r, idx) => {
                  if (isCommissionRowIncomplete(r)) snap.add(idx)
                })
                setIncompleteSnapshot(snap)
                setRowFilter('incomplete')
              }}
              title="Rows where Name, Policy number, or Carrier is empty or “-”"
            >
              <ClipboardList className="mr-1 h-3.5 w-3.5" />
              Incomplete ({incompleteCommissionCount})
            </Button>
          </div>
        )}

        {!loading && hasIncompleteCommission && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900 dark:border-rose-800/80 dark:bg-rose-950/50 dark:text-rose-100"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            <span>
              <strong>{incompleteCommissionCount}</strong> row{incompleteCommissionCount === 1 ? ' needs' : 's need'}{' '}
              Name, Policy number, and Carrier (cannot be empty or &quot;-&quot;). Use the <strong>Incomplete</strong> tab to fix
              them. Save is blocked until every row is valid.
            </span>
          </div>
        )}

        {saveError && !duplicateIssues?.length && (
          <div
            role="alert"
            className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/50 dark:text-red-100"
          >
            {saveError}
          </div>
        )}

        {duplicateIssues && duplicateIssues.length > 0 && (
          <div
            role="alert"
            className="shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-600/80 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-semibold text-amber-900 dark:text-amber-50">
                  Duplicate commission (same policy, date, and amount)
                </p>
                <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-4 text-xs text-amber-900/90 dark:text-amber-100/90">
                  {duplicateIssues.map((issue, i) => (
                    <li key={i}>
                      <span className="font-mono text-amber-800 dark:text-amber-200/95">{issue.policy_number}</span>
                      {' · '}
                      {issue.date}
                      {' · '}
                      {issue.amountDisplay}
                      {' — '}
                      {issue.summary}
                    </li>
                  ))}
                </ul>
                {saveError ? (
                  <p className="text-xs font-medium text-red-700 dark:text-red-300">{saveError}</p>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className={adminOutlineBtn}
                    onClick={() => setDuplicateIssues(null)}
                    disabled={saving || savingDealTrackerOnly || checkingDuplicates}
                  >
                    Back to editing
                  </Button>
                  {onSaveDealTrackerOnly ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={cn(adminOutlineBtn, 'border-emerald-600/50 text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950/50')}
                      onClick={() => void runSaveDealTrackerOnly()}
                      disabled={saving || savingDealTrackerOnly || checkingDuplicates}
                    >
                      {savingDealTrackerOnly ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving deal tracker…
                        </>
                      ) : (
                        'Save deal tracker only'
                      )}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    className="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-700 dark:hover:bg-amber-600"
                    onClick={() => runSave(true)}
                    disabled={saving || savingDealTrackerOnly || checkingDuplicates}
                  >
                    Save anyway
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/20 dark:border-slate-700">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-orange-500 dark:text-orange-400" />
            </div>
          ) : editableRows.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">No commission rows for this file.</div>
          ) : rowsToShow.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              {rowFilter === 'incomplete'
                ? 'No incomplete rows — every row has valid Name, Policy number, and Carrier.'
                : 'No rows to show.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent dark:border-slate-700">
                  <TableHead className="font-semibold text-foreground">Name</TableHead>
                  <TableHead className="font-semibold text-foreground">Policy Number</TableHead>
                  <TableHead className="font-semibold text-foreground">Carrier</TableHead>
                  <TableHead className="font-semibold text-foreground">Sales Agent</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Commission Rate</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Advance</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Charge Back</TableHead>
                  <TableHead className="w-20 text-center font-semibold text-foreground">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rowsToShow.map(({ row, idx }) => (
                  <TableRow key={row.id ?? `${row.policy_number}-${idx}`} className="border-b border-border dark:border-slate-800">
                    <TableCell className="p-1">
                      <Input
                        value={row.name}
                        onChange={(e) => updateRow(idx, 'name', e.target.value)}
                        className={cn(
                          commissionDialogInput,
                          fieldEmptyOrDash(row.name) &&
                            'border-rose-500 ring-2 ring-rose-500/40 dark:border-rose-500 dark:ring-rose-500/30'
                        )}
                        aria-invalid={fieldEmptyOrDash(row.name)}
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      <Input
                        value={row.policy_number}
                        onChange={(e) => updateRow(idx, 'policy_number', e.target.value)}
                        className={cn(
                          commissionDialogInputMono,
                          fieldEmptyOrDash(row.policy_number) &&
                            'border-rose-500 ring-2 ring-rose-500/40 dark:border-rose-500 dark:ring-rose-500/30'
                        )}
                        aria-invalid={fieldEmptyOrDash(row.policy_number)}
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      <Input
                        value={row.carrier}
                        onChange={(e) => updateRow(idx, 'carrier', e.target.value)}
                        className={cn(
                          commissionDialogInput,
                          fieldEmptyOrDash(row.carrier) &&
                            'border-rose-500 ring-2 ring-rose-500/40 dark:border-rose-500 dark:ring-rose-500/30'
                        )}
                        aria-invalid={fieldEmptyOrDash(row.carrier)}
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      <Input
                        value={row.sales_agent}
                        onChange={(e) => updateRow(idx, 'sales_agent', e.target.value)}
                        className={commissionDialogInput}
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.commission_rate}
                        onChange={(e) => updateRow(idx, 'commission_rate', e.target.value)}
                        className={cn(commissionDialogInput, 'text-right')}
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.advance}
                        onChange={(e) => updateRow(idx, 'advance', e.target.value)}
                        className={cn(commissionDialogInput, 'text-right')}
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.charge_back}
                        onChange={(e) => updateRow(idx, 'charge_back', e.target.value)}
                        className={cn(commissionDialogInput, 'text-right')}
                      />
                    </TableCell>
                    <TableCell className="p-1 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                        onClick={() => setEditableRows(prev => prev.filter((_, i) => i !== idx))}
                        title="Remove this commission row from this file"
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border pt-4 dark:border-slate-700">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={saving || savingDealTrackerOnly}
            className={adminOutlineBtn}
          >
            Cancel
          </Button>
          <Button
            onClick={() => runSave(false)}
            disabled={
              saving ||
              savingDealTrackerOnly ||
              loading ||
              checkingDuplicates ||
              editableRows.length === 0 ||
              !!duplicateIssues?.length ||
              hasIncompleteCommission
            }
            title={
              hasIncompleteCommission
                ? 'Fix Name, Policy number, and Carrier on every row (use Incomplete tab) before saving'
                : undefined
            }
            className="bg-orange-600 text-white hover:bg-orange-700"
          >
            {saving || checkingDuplicates ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {checkingDuplicates ? 'Checking…' : 'Saving...'}
              </>
            ) : (
              'Save'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
