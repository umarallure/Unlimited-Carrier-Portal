'use client'

import { useState } from 'react'
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
import { Loader2, CheckCircle, XCircle, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DealTrackerPreviewEntry } from '@/lib/dealTracker'

interface DealTrackerVerificationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: DealTrackerPreviewEntry[]
  onConfirm: () => Promise<void>
  onCancel: () => void
}

export function DealTrackerVerificationDialog({
  open,
  onOpenChange,
  entries,
  onConfirm,
  onCancel,
}: DealTrackerVerificationDialogProps) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleConfirm = async () => {
    setSaving(true)
    setError(null)
    try {
      await onConfirm()
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

  const newCount = entries.filter(e => e.isNew).length
  const updatedCount = entries.filter(e => e.isUpdated).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-7xl max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-700 text-slate-50">
        <DialogHeader>
          <DialogTitle className="text-slate-50 text-xl font-semibold">Deal Tracker Verification</DialogTitle>
          <DialogDescription className="text-slate-300">
            Please review the deal tracker entries before saving. <span className="font-semibold text-green-400">{newCount}</span> new entries, <span className="font-semibold text-blue-400">{updatedCount}</span> updated entries.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="bg-red-950/60 border border-red-600 rounded-md p-4 flex items-start gap-2">
            <AlertCircle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-300">Error</p>
              <p className="text-sm text-red-200">{error}</p>
            </div>
          </div>
        )}

        <div className="border border-slate-700 rounded-lg overflow-hidden bg-slate-800">
          <div className="overflow-x-auto max-h-[60vh]">
            <Table>
              <TableHeader className="sticky top-0 bg-slate-800 border-b border-slate-700 z-10">
                <TableRow className="hover:bg-slate-800">
                  <TableHead className="w-20 text-slate-200 font-semibold">Status</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Name</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Policy Status</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Deal Value</TableHead>
                  <TableHead className="text-slate-200 font-semibold">CC Value</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Call Center</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Phone Number</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Deal Creation Date</TableHead>
                  <TableHead className="text-slate-200 font-semibold">Effective Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry, index) => {
                  // Highlight deal_value and cc_value changes for updated entries
                  const isUpdated = entry.isUpdated && !entry.isNew
                  return (
                    <TableRow 
                      key={index} 
                      className={cn(
                        'border-slate-700',
                        isUpdated ? 'bg-blue-950/30 hover:bg-blue-950/40' : 'hover:bg-slate-700/50'
                      )}
                    >
                      <TableCell className="text-slate-100">
                        {entry.isNew ? (
                          <Badge variant="default" className="bg-green-600 hover:bg-green-700 text-white font-semibold">
                            New
                          </Badge>
                        ) : entry.isUpdated ? (
                          <Badge variant="default" className="bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                            Updated
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-medium text-slate-100">{entry.name || <span className="text-slate-500">-</span>}</TableCell>
                      <TableCell className="font-mono text-slate-200">{entry.policy_number}</TableCell>
                      <TableCell>
                        <Badge 
                          variant="outline" 
                          className={cn(
                            'border-slate-600',
                            entry.policy_status === 'Declined' 
                              ? 'bg-red-950/40 border-red-700 text-red-300' 
                              : 'bg-slate-800 text-slate-300'
                          )}
                        >
                          {entry.policy_status || <span className="text-slate-500">-</span>}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn(
                        'text-slate-100',
                        isUpdated && entry.deal_value ? 'font-semibold text-blue-300' : ''
                      )}>
                        {entry.deal_value !== null && entry.deal_value !== undefined
                          ? `$${entry.deal_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : <span className="text-slate-500">-</span>}
                      </TableCell>
                      <TableCell className={cn(
                        'text-slate-100',
                        isUpdated && entry.cc_value ? 'font-semibold text-blue-300' : ''
                      )}>
                        {entry.cc_value !== null && entry.cc_value !== undefined
                          ? `$${entry.cc_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : <span className="text-slate-500">-</span>}
                      </TableCell>
                      <TableCell className="text-slate-200">{entry.sales_agent || <span className="text-slate-500">-</span>}</TableCell>
                      <TableCell className="text-slate-200">{entry.call_center || <span className="text-slate-500">-</span>}</TableCell>
                      <TableCell className="text-slate-200 font-mono">{entry.phone_number || <span className="text-slate-500">-</span>}</TableCell>
                      <TableCell className="text-slate-200">
                        {entry.deal_creation_date
                          ? new Date(entry.deal_creation_date).toLocaleDateString()
                          : <span className="text-slate-500">-</span>}
                      </TableCell>
                      <TableCell className={cn(
                        'text-slate-200',
                        isUpdated && entry.effective_date ? 'font-semibold text-blue-300' : ''
                      )}>
                        {entry.effective_date
                          ? new Date(entry.effective_date).toLocaleDateString()
                          : <span className="text-slate-500">-</span>}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </div>

        <DialogFooter className="border-t border-slate-700 pt-4">
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={saving}
            className="border-slate-600 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={saving || entries.length === 0}
            className="min-w-[120px] bg-blue-600 hover:bg-blue-700 text-white font-semibold"
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
