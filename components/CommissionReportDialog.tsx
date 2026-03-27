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
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Loader2, PlusCircle, X, AlertTriangle } from 'lucide-react'
import {
  findWithinFileCommissionDuplicates,
  findTrackerCommissionDuplicates,
  type CommissionDisplayRow,
  type CommissionDuplicateIssue,
} from '@/lib/useCommissionReportUpload'

interface CommissionReportDialogProps {
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
}: CommissionReportDialogProps) {
  const isCorebridge = carrierCode === 'COREBRIDGE'
  const [editableRows, setEditableRows] = useState<CommissionDisplayRow[]>([])
  /** One statement date for all Corebridge rows (PDF / statement_date). */
  const [headerStatementDate, setHeaderStatementDate] = useState('')
  const [duplicateIssues, setDuplicateIssues] = useState<CommissionDuplicateIssue[] | null>(null)
  const [checkingDuplicates, setCheckingDuplicates] = useState(false)

  useEffect(() => {
    if (open && rows.length > 0) {
      const copied = rows.map((r) => ({ ...r }))
      setEditableRows(copied)
      if (isCorebridge) {
        const firstDate =
          copied.find((r) => r.date && String(r.date).trim())?.date ?? copied[0]?.date ?? ''
        setHeaderStatementDate(String(firstDate))
      } else {
        setHeaderStatementDate('')
      }
    } else if (open && rows.length === 0 && !loading) {
      setEditableRows([])
      setHeaderStatementDate('')
    }
  }, [open, rows, loading, isCorebridge])

  useEffect(() => {
    if (!open) setDuplicateIssues(null)
  }, [open])

  const buildSavePayload = useCallback((): CommissionDisplayRow[] => {
    return isCorebridge
      ? editableRows.map((r) => ({ ...r, date: headerStatementDate }))
      : editableRows
  }, [isCorebridge, editableRows, headerStatementDate])

  const applyStatementDateToAllRows = (ymd: string) => {
    setHeaderStatementDate(ymd)
    setEditableRows((prev) => prev.map((r) => ({ ...r, date: ymd })))
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
    const stmt = isCorebridge ? headerStatementDate : ''

    if (!forceIgnoreDuplicates) {
      setCheckingDuplicates(true)
      try {
        const within = findWithinFileCommissionDuplicates(payload, carrierCode, stmt)
        const tracker =
          agencyCarrierId && fileId
            ? await findTrackerCommissionDuplicates(agencyCarrierId, payload, carrierCode, stmt)
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
    await onSave(payload)
  }

  const handleCancel = () => {
    setDuplicateIssues(null)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 max-w-6xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-white">
            Commission Report —{' '}
            {carrierCode === 'AMAM'
              ? 'AMAM'
              : carrierCode === 'MOH'
                ? 'MOH'
                : carrierCode === 'COREBRIDGE'
                  ? 'Corebridge'
                  : 'Aetna'}
          </DialogTitle>
          <DialogDescription className="text-slate-400 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <span className="min-w-0">
              Review and edit commission rows, then Save. Data will appear on the Commission Report page.
            </span>
            {!loading && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 border-slate-600 text-slate-200 hover:bg-slate-800 sm:self-start"
                onClick={() => {
                  const template = editableRows[0]
                  const base: CommissionDisplayRow = {
                    id: undefined,
                    name: '',
                    date: isCorebridge ? headerStatementDate : '',
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
          {isCorebridge && !loading && editableRows.length > 0 && (
            <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg border border-slate-700 bg-slate-800/40 px-3 py-2.5">
              <div className="space-y-1">
                <Label htmlFor="commission-statement-date" className="text-xs font-medium text-slate-300">
                  Statement date (from PDF — edit if needed)
                </Label>
                <Input
                  id="commission-statement-date"
                  type="date"
                  value={headerStatementDate}
                  onChange={(e) => applyStatementDateToAllRows(e.target.value)}
                  className="h-9 w-[11.5rem] bg-slate-800 border-slate-600 text-white text-sm"
                />
              </div>
              <p className="text-xs text-slate-500 max-w-md pb-0.5">
                Applies to every row in this file. This updates <span className="text-slate-400">statement_date</span>{' '}
                in Corebridge commissions when you save.
              </p>
            </div>
          )}
        </DialogHeader>

        {duplicateIssues && duplicateIssues.length > 0 && (
          <div
            role="alert"
            className="shrink-0 rounded-lg border border-amber-600/80 bg-amber-950/40 px-4 py-3 text-amber-100"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400 mt-0.5" />
              <div className="min-w-0 space-y-2">
                <p className="text-sm font-semibold text-amber-50">
                  Duplicate commission (same policy, date, and amount)
                </p>
                <ul className="text-xs text-amber-100/90 list-disc pl-4 space-y-1 max-h-40 overflow-y-auto">
                  {duplicateIssues.map((issue, i) => (
                    <li key={i}>
                      <span className="font-mono text-amber-200/95">{issue.policy_number}</span>
                      {' · '}
                      {issue.date}
                      {' · '}
                      {issue.amountDisplay}
                      {' — '}
                      {issue.summary}
                    </li>
                  ))}
                </ul>
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-slate-500 text-slate-200 hover:bg-slate-800"
                    onClick={() => setDuplicateIssues(null)}
                  >
                    Back to editing
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="bg-amber-700 hover:bg-amber-600 text-white"
                    onClick={() => runSave(true)}
                    disabled={saving || checkingDuplicates}
                  >
                    Save anyway
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto min-h-0 border border-slate-700 rounded-lg">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
            </div>
          ) : editableRows.length === 0 ? (
            <div className="py-8 text-center text-slate-400">No commission rows for this file.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-b border-slate-700 hover:bg-transparent">
                  <TableHead className="text-slate-300 font-semibold">Name</TableHead>
                  {!isCorebridge && <TableHead className="text-slate-300 font-semibold">Date</TableHead>}
                  <TableHead className="text-slate-300 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Commission Rate</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Advance</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Charge Back</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-center w-20">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {editableRows.map((row, idx) => (
                  <TableRow key={row.id ?? `${row.policy_number}-${idx}`} className="border-b border-slate-800">
                    <TableCell className="p-1">
                      <Input
                        value={row.name}
                        onChange={(e) => updateRow(idx, 'name', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm"
                      />
                    </TableCell>
                    {!isCorebridge && (
                      <TableCell className="p-1">
                        <Input
                          type="date"
                          value={row.date}
                          onChange={(e) => updateRow(idx, 'date', e.target.value)}
                          className="h-8 bg-slate-800 border-slate-600 text-white text-sm"
                        />
                      </TableCell>
                    )}
                    <TableCell className="p-1">
                      <Input
                        value={row.policy_number}
                        onChange={(e) => updateRow(idx, 'policy_number', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm font-mono"
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      <Input
                        value={row.carrier}
                        onChange={(e) => updateRow(idx, 'carrier', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm"
                      />
                    </TableCell>
                    <TableCell className="p-1">
                      <Input
                        value={row.sales_agent}
                        onChange={(e) => updateRow(idx, 'sales_agent', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm"
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.commission_rate}
                        onChange={(e) => updateRow(idx, 'commission_rate', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm text-right"
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.advance}
                        onChange={(e) => updateRow(idx, 'advance', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm text-right"
                      />
                    </TableCell>
                    <TableCell className="p-1 text-right">
                      <Input
                        value={row.charge_back}
                        onChange={(e) => updateRow(idx, 'charge_back', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm text-right"
                      />
                    </TableCell>
                    <TableCell className="p-1 text-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-400 hover:text-red-300 hover:bg-red-950/40 text-xs"
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

        <DialogFooter className="border-t border-slate-700 pt-4 shrink-0">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={saving}
            className="border-slate-600 text-slate-300"
          >
            Cancel
          </Button>
          <Button
            onClick={() => runSave(false)}
            disabled={saving || loading || checkingDuplicates || editableRows.length === 0 || !!duplicateIssues?.length}
            className="bg-orange-600 hover:bg-orange-700"
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
