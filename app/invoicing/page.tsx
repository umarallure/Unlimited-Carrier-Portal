'use client'

import { useState } from 'react'
import { Calendar, Loader2, Shield } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { createClient } from '@/lib/supabase/client'
import {
  buildInvoiceDraft,
  buildBpoInvoiceLines,
  getPreviousChargebackByCallCenter,
  markInvoiceBatchPaid,
  type InvoiceDraftResult,
  type BpoInvoiceDetailResult,
} from '@/lib/invoicing'
import { cn } from '@/lib/utils'

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const invoiceTableHead =
  'border-b border-slate-200 bg-slate-50 px-2 py-2 text-left text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
const invoiceCell = 'border-b border-slate-100 px-2 py-1.5 text-xs text-slate-800 dark:border-slate-800 dark:text-slate-200'

export default function InvoicingPage() {
  const supabase = createClient()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraftResult | null>(null)
  const [bpoDetail, setBpoDetail] = useState<BpoInvoiceDetailResult | null>(null)
  const [previousChargebackByCallCenter, setPreviousChargebackByCallCenter] = useState<Record<string, string>>({})

  const balanceDueForBpo = (callCenter: string, subtotal: number): number => {
    const raw = previousChargebackByCallCenter[callCenter] ?? '0'
    const prev = Number.parseFloat(raw)
    const p = Number.isNaN(prev) ? 0 : prev
    return round2(subtotal - p)
  }

  function round2(n: number): number {
    return Math.round(n * 100) / 100
  }

  const generateInvoice = async () => {
    if (!dateFrom || !dateTo) {
      alert('Please select both From and To dates.')
      return
    }
    if (new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
      alert('From date must be before or equal to To date.')
      return
    }

    setLoading(true)
    try {
      const [result, bpo] = await Promise.all([
        buildInvoiceDraft(dateFrom, dateTo),
        buildBpoInvoiceLines(dateFrom, dateTo),
      ])
      const previous = await getPreviousChargebackByCallCenter(result.groups.map((g) => g.callCenter))
      const previousText: Record<string, string> = {}
      for (const [k, v] of Object.entries(previous)) previousText[k] = String(v || 0)
      setDraft(result)
      setBpoDetail(bpo)
      setPreviousChargebackByCallCenter(previousText)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate invoice draft.'
      alert(message)
    } finally {
      setLoading(false)
    }
  }

  const markPaid = async () => {
    if (!draft || draft.groups.length === 0) return
    setSaving(true)
    try {
      const { data } = await supabase.auth.getUser()
      const previousChargebacks: Record<string, number> = {}
      for (const [center, raw] of Object.entries(previousChargebackByCallCenter)) {
        const parsed = Number.parseFloat(raw)
        previousChargebacks[center] = Number.isNaN(parsed) ? 0 : parsed
      }

      const { batchId } = await markInvoiceBatchPaid({
        startDate: draft.startDate,
        endDate: draft.endDate,
        groups: draft.groups,
        overridesByPolicyKey: {},
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
      })
      alert(`Invoice batch marked as paid. Batch ID: ${batchId}`)
      setDraft(null)
      setBpoDetail(null)
      setPreviousChargebackByCallCenter({})
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to mark invoice as paid.'
      alert(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-page space-y-6 print:space-y-4">
      <PageHeader
        title="Invoicing"
        description="Generate BPO (call center) invoices: sales first, then chargebacks. Lead value shows 50% of the underlying commission amount (not gross). Use Mark paid when the batch is settled."
        icon={<span className="text-xl font-bold text-orange-400">$</span>}
      />

      <Card className="print:hidden">
        <CardHeader>
          <CardTitle>Invoice range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[180px]" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[180px]" />
              </div>
            </div>
            <Button onClick={generateInvoice} disabled={loading} className="bg-orange-500 text-black hover:bg-orange-400">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                'Generate Invoice'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {draft && draft.groups.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 print:hidden dark:border-slate-800">
          <div className="text-sm text-muted-foreground">
            {bpoDetail && bpoDetail.groups.length > 0 ? (
              <>
                Invoice period: <span className="font-medium text-foreground">{bpoDetail.rangeLabel}</span>
              </>
            ) : (
              <span>Review invoices below, then mark the batch as paid when settled.</span>
            )}
          </div>
          <Button onClick={markPaid} disabled={saving} className="shrink-0 bg-green-600 text-white hover:bg-green-700">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Mark paid'
            )}
          </Button>
        </div>
      )}

      {bpoDetail && bpoDetail.groups.length === 0 && draft && draft.groups.length === 0 && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            No commission transactions found in this date range.
          </CardContent>
        </Card>
      )}

      {bpoDetail?.groups.map((group) => (
        <div
          key={group.callCenter}
          className={cn(
            'overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-950',
            'print:break-inside-avoid print:border print:shadow-none',
          )}
        >
          {/* Invoice header — matches sample: title + date range */}
          <div className="border-b border-slate-200 bg-white px-6 py-6 text-center dark:border-slate-800 dark:bg-slate-950">
            <div className="mb-3 flex justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900">
                <Shield className="h-8 w-8 text-slate-500 dark:text-slate-400" />
              </div>
            </div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">{group.callCenter}</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{bpoDetail.rangeLabel}</p>
          </div>

          <div className="p-4 sm:p-6">
            {/* Sales section */}
            <div className="mb-6">
              <div className="rounded-t-md bg-teal-600 px-3 py-2 text-center text-sm font-semibold text-white dark:bg-teal-700">
                Sales
              </div>
              <div className="overflow-x-auto rounded-b-md border border-t-0 border-slate-200 dark:border-slate-700">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className={cn(invoiceTableHead, 'min-w-[100px]')}>Sales</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Lead value (50%)</TableHead>
                      <TableHead className={invoiceTableHead}>Carrier</TableHead>
                      <TableHead className={invoiceTableHead}>Agent Account</TableHead>
                      <TableHead className={invoiceTableHead}>Draft Date</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Coverage Amount</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Com %</TableHead>
                      <TableHead className={invoiceTableHead}>Com Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.salesLines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className={cn(invoiceCell, 'text-muted-foreground')}>
                          No sales in this period.
                        </TableCell>
                      </TableRow>
                    ) : (
                      group.salesLines.map((line) => (
                        <TableRow key={line.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-900/50">
                          <TableCell className={invoiceCell}>{line.insuredName}</TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right font-mono')}>${formatMoney(line.leadValue)}</TableCell>
                          <TableCell className={invoiceCell}>{line.carrier}</TableCell>
                          <TableCell className={invoiceCell}>{line.agentAccount}</TableCell>
                          <TableCell className={invoiceCell}>{line.draftDate}</TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right')}>
                            {line.coverageAmount != null ? `$${formatMoney(line.coverageAmount)}` : '—'}
                          </TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right')}>{line.comPct}</TableCell>
                          <TableCell className={invoiceCell}>{line.comType}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Chargebacks section */}
            <div className="mb-6">
              <div className="rounded-t-md bg-orange-400 px-3 py-2 text-center text-sm font-semibold text-slate-900 dark:bg-orange-600 dark:text-white">
                Chargebacks
              </div>
              <div className="overflow-x-auto rounded-b-md border border-t-0 border-slate-200 dark:border-slate-700">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className={cn(invoiceTableHead, 'min-w-[100px]')}>Chargebacks</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Lead value (50%)</TableHead>
                      <TableHead className={invoiceTableHead}>Carrier</TableHead>
                      <TableHead className={invoiceTableHead}>Agent Account</TableHead>
                      <TableHead className={invoiceTableHead}>Draft Date</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Coverage Amount</TableHead>
                      <TableHead className={cn(invoiceTableHead, 'text-right')}>Com %</TableHead>
                      <TableHead className={invoiceTableHead}>Com Type</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.chargebackLines.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} className={cn(invoiceCell, 'text-muted-foreground')}>
                          No chargebacks in this period.
                        </TableCell>
                      </TableRow>
                    ) : (
                      group.chargebackLines.map((line) => (
                        <TableRow key={line.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-900/50">
                          <TableCell className={invoiceCell}>{line.insuredName}</TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right font-mono text-rose-700 dark:text-rose-400')}>
                            ${formatMoney(line.leadValue)}
                          </TableCell>
                          <TableCell className={invoiceCell}>{line.carrier}</TableCell>
                          <TableCell className={invoiceCell}>{line.agentAccount}</TableCell>
                          <TableCell className={invoiceCell}>{line.draftDate}</TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right')}>
                            {line.coverageAmount != null ? `$${formatMoney(line.coverageAmount)}` : '—'}
                          </TableCell>
                          <TableCell className={cn(invoiceCell, 'text-right')}>{line.comPct}</TableCell>
                          <TableCell className={invoiceCell}>{line.comType}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </div>
            </div>

            {/* Summary — sample-style boxes */}
            <div className="flex flex-col items-end gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="flex w-full max-w-md flex-col gap-2 text-sm">
                <div className="flex items-center justify-between gap-4 rounded-md bg-emerald-50 px-3 py-2 dark:bg-emerald-950/40">
                  <span className="text-slate-700 dark:text-emerald-100/90">
                    New Business From {bpoDetail.rangeLabel}
                  </span>
                  <span className="font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                    ${formatMoney(group.newBusinessTotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md bg-rose-50 px-3 py-2 dark:bg-rose-950/40">
                  <span className="text-slate-700 dark:text-rose-100/90">
                    Charge-Backs From {bpoDetail.rangeLabel}
                  </span>
                  <span className="font-semibold tabular-nums text-rose-800 dark:text-rose-300">
                    ${formatMoney(group.chargebacksTotal)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/80">
                  <span className="text-slate-600 dark:text-slate-400">Negative balance from last week&apos;s invoice</span>
                  <Input
                    value={previousChargebackByCallCenter[group.callCenter] ?? '0'}
                    onChange={(e) =>
                      setPreviousChargebackByCallCenter((prev) => ({
                        ...prev,
                        [group.callCenter]: e.target.value,
                      }))
                    }
                    className="h-9 w-[140px] text-right font-mono text-sm"
                    placeholder="0.00"
                  />
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md bg-slate-900 px-3 py-2.5 text-white dark:bg-black">
                  <span className="font-medium">Balance due</span>
                  <span className="text-lg font-bold tabular-nums">
                    ${formatMoney(balanceDueForBpo(group.callCenter, group.subtotal))}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}

    </div>
  )
}
