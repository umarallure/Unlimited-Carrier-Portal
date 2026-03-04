'use client'

import React, { useState, useEffect } from 'react'
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
import { Loader2 } from 'lucide-react'
import type { CommissionDisplayRow } from '@/lib/useCommissionReportUpload'

interface CommissionReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: CommissionDisplayRow[]
  loading?: boolean
  saving?: boolean
  onSave: (editedRows: CommissionDisplayRow[]) => Promise<void>
  onCancel: () => void
  carrierCode: string
}

export function CommissionReportDialog({
  open,
  onOpenChange,
  rows,
  loading = false,
  saving = false,
  onSave,
  onCancel,
  carrierCode,
}: CommissionReportDialogProps) {
  const [editableRows, setEditableRows] = useState<CommissionDisplayRow[]>([])

  useEffect(() => {
    if (open && rows.length > 0) {
      setEditableRows(rows.map((r) => ({ ...r })))
    } else if (open && rows.length === 0 && !loading) {
      setEditableRows([])
    }
  }, [open, rows, loading])

  const updateRow = (index: number, field: keyof CommissionDisplayRow, value: string) => {
    setEditableRows((prev) => {
      const next = [...prev]
      if (next[index]) next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const handleSave = async () => {
    await onSave(editableRows)
  }

  const handleCancel = () => {
    onCancel()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 max-w-6xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-white">
            Commission Report — {carrierCode === 'AMAM' ? 'AMAM' : 'Aetna'}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Review and edit commission rows, then Save. Data will appear on the Commission Report page.
          </DialogDescription>
        </DialogHeader>

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
                  <TableHead className="text-slate-300 font-semibold">Date</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Commission Rate</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Advance</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Charge Back</TableHead>
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
                    <TableCell className="p-1">
                      <Input
                        type="date"
                        value={row.date}
                        onChange={(e) => updateRow(idx, 'date', e.target.value)}
                        className="h-8 bg-slate-800 border-slate-600 text-white text-sm"
                      />
                    </TableCell>
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
            onClick={handleSave}
            disabled={saving || loading || editableRows.length === 0}
            className="bg-orange-600 hover:bg-orange-700"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Saving...
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
