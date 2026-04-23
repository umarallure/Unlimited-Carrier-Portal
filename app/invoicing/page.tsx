'use client'

import { useEffect, useState } from 'react'
import { Calendar, Loader2, Shield } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { createClient } from '@/lib/supabase/client'
import {
  buildInvoiceDraft,
  buildBpoInvoiceLines,
  formatInvoicingStatusLabel,
  getPreviousChargebackByCallCenter,
  markInvoiceBatchPaid,
  normalizeCallCenterName,
  type BpoInvoiceLine,
  type InvoicingStatus,
  type InvoiceDraftResult,
  type BpoInvoiceDetailResult,
} from '@/lib/invoicing'
import { cn } from '@/lib/utils'

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function normalizePolicyNumberForMatch(policyNumber: string | null | undefined): string {
  const raw = String(policyNumber ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
  if (!raw) return ''
  if (!/^\d+$/.test(raw)) return raw
  return raw.replace(/^0+/, '') || '0'
}

const invoiceTableHead =
  'whitespace-nowrap border-b border-slate-200 bg-slate-50 px-2 py-2 text-left text-xs font-semibold text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
const invoiceCell = 'border-b border-slate-100 px-2 py-1.5 align-middle text-xs text-slate-800 dark:border-slate-800 dark:text-slate-200'

export default function InvoicingPage() {
  const supabase = createClient()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraftResult | null>(null)
  const [bpoDetail, setBpoDetail] = useState<BpoInvoiceDetailResult | null>(null)
  const [previousChargebackByCallCenter, setPreviousChargebackByCallCenter] = useState<Record<string, string>>({})
  const [excludedPolicyKeys, setExcludedPolicyKeys] = useState<Record<string, true>>({})
  const [lineEdits, setLineEdits] = useState<Record<string, Partial<BpoInvoiceLine>>>({})
  const [availableCallCenters, setAvailableCallCenters] = useState<string[]>([])
  const [selectedCallCenter, setSelectedCallCenter] = useState<string>('ALL')

  const balanceDueForBpo = (callCenter: string, subtotal: number): number => {
    const raw = previousChargebackByCallCenter[callCenter] ?? '0'
    const prev = Number.parseFloat(raw)
    const p = Number.isNaN(prev) ? 0 : prev
    return round2(subtotal - p)
  }

  function round2(n: number): number {
    return Math.round(n * 100) / 100
  }

  useEffect(() => {
    const loadCallCenters = async () => {
      const { data, error } = await supabase
        .from('deal_tracker')
        .select('call_center')
        .not('call_center', 'is', null)
        .limit(5000)
      if (error) return
      const rows = (data || []) as Array<{ call_center: string | null }>
      const centers = Array.from(
        new Set(rows.map((r) => normalizeCallCenterName(r.call_center)).filter((v) => v.length > 0)),
      ).sort((a, b) => a.localeCompare(b))
      setAvailableCallCenters(centers)
    }
    void loadCallCenters()
  }, [])

  const generateInvoice = async (callCenterFilter?: string | null) => {
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
        buildInvoiceDraft(dateFrom, dateTo, callCenterFilter),
        buildBpoInvoiceLines(dateFrom, dateTo, callCenterFilter),
      ])
      const previous = await getPreviousChargebackByCallCenter(result.groups.map((g) => g.callCenter))
      const previousText: Record<string, string> = {}
      for (const [k, v] of Object.entries(previous)) previousText[k] = String(v || 0)
      setDraft(result)
      setBpoDetail(bpo)
      setPreviousChargebackByCallCenter(previousText)
      setExcludedPolicyKeys({})
      setLineEdits({})
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate invoice draft.'
      alert(message)
    } finally {
      setLoading(false)
    }
  }

  const markPaid = async () => {
    if (!visibleDraft || visibleDraft.groups.length === 0) return
    setSaving(true)
    try {
      const { data } = await supabase.auth.getUser()
      const previousChargebacks: Record<string, number> = {}
      for (const [center, raw] of Object.entries(previousChargebackByCallCenter)) {
        const parsed = Number.parseFloat(raw)
        previousChargebacks[center] = Number.isNaN(parsed) ? 0 : parsed
      }

      const { batchId } = await markInvoiceBatchPaid({
        startDate: visibleDraft.startDate,
        endDate: visibleDraft.endDate,
        groups: visibleDraft.groups,
        overridesByPolicyKey: {},
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
      })
      alert(`Invoice batch marked as paid. Batch ID: ${batchId}`)
      setDraft(null)
      setBpoDetail(null)
      setPreviousChargebackByCallCenter({})
      setExcludedPolicyKeys({})
      setLineEdits({})
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to mark invoice as paid.'
      alert(message)
    } finally {
      setSaving(false)
    }
  }

  const markGroupPaid = async (callCenter: string) => {
    if (!visibleDraft) return
    const group = visibleDraft.groups.find((g) => g.callCenter === callCenter)
    if (!group) return
    setSaving(true)
    try {
      const { data } = await supabase.auth.getUser()
      const prevRaw = previousChargebackByCallCenter[callCenter] ?? '0'
      const parsed = Number.parseFloat(prevRaw)
      const previousChargebacks: Record<string, number> = {
        [callCenter]: Number.isNaN(parsed) ? 0 : parsed,
      }
      const { batchId } = await markInvoiceBatchPaid({
        startDate: visibleDraft.startDate,
        endDate: visibleDraft.endDate,
        groups: [group],
        overridesByPolicyKey: {},
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
      })
      alert(`${callCenter} marked as paid. Batch ID: ${batchId}`)
      setDraft((prev) => {
        if (!prev) return prev
        return { ...prev, groups: prev.groups.filter((g) => g.callCenter !== callCenter) }
      })
      setBpoDetail((prev) => {
        if (!prev) return prev
        return { ...prev, groups: prev.groups.filter((g) => g.callCenter !== callCenter) }
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : `Failed to mark ${callCenter} as paid.`
      alert(message)
    } finally {
      setSaving(false)
    }
  }

  const policyKeyByCenterAndNumber = new Map<string, string>()
  const resolvePolicyKey = (callCenter: string, policyNumber: string): string | undefined => {
    const direct = policyKeyByCenterAndNumber.get(`${callCenter}::${policyNumber}`)
    if (direct) return direct
    const normalized = normalizePolicyNumberForMatch(policyNumber)
    if (!normalized) return undefined
    return policyKeyByCenterAndNumber.get(`${callCenter}::${normalized}`)
  }
  if (draft) {
    for (const group of draft.groups) {
      for (const p of group.policies) {
        policyKeyByCenterAndNumber.set(`${group.callCenter}::${p.policyNumber}`, p.policyKey)
        const normalized = normalizePolicyNumberForMatch(p.policyNumber)
        if (normalized && normalized !== p.policyNumber) {
          policyKeyByCenterAndNumber.set(`${group.callCenter}::${normalized}`, p.policyKey)
        }
      }
    }
  }

  const visibleDraft: InvoiceDraftResult | null = draft
    ? {
        ...draft,
        groups: draft.groups
          .map((group) => {
            const policies = group.policies.filter((p) => !excludedPolicyKeys[p.policyKey])
            const grossTotal = round2(policies.reduce((sum, p) => sum + p.grossNet, 0))
            const ccInvoiceTotal = round2(policies.reduce((sum, p) => sum + p.ccNet, 0))
            return {
              ...group,
              policies,
              policyCount: policies.length,
              grossTotal,
              ccInvoiceTotal,
            }
          })
          .filter((group) => group.policies.length > 0),
      }
    : null

  const applyLineEdit = (line: BpoInvoiceLine): BpoInvoiceLine => {
    const edit = lineEdits[line.id]
    return edit ? { ...line, ...edit } : line
  }

  const visibleBpoDetail: BpoInvoiceDetailResult | null = bpoDetail
    ? {
        ...bpoDetail,
        groups: bpoDetail.groups
          .map((group) => {
            const salesLines = group.salesLines.filter((line) => {
              const key = resolvePolicyKey(group.callCenter, line.policyNumber)
              return !key || !excludedPolicyKeys[key]
            }).map(applyLineEdit)
            const chargebackLines = group.chargebackLines.filter((line) => {
              const key = resolvePolicyKey(group.callCenter, line.policyNumber)
              return !key || !excludedPolicyKeys[key]
            }).map(applyLineEdit)
            const newBusinessTotal = round2(salesLines.reduce((s, l) => s + l.leadValue, 0))
            const chargebacksTotal = round2(chargebackLines.reduce((s, l) => s + l.leadValue, 0))
            const subtotal = round2(newBusinessTotal + chargebacksTotal)
            return {
              ...group,
              salesLines,
              chargebackLines,
              newBusinessTotal,
              chargebacksTotal,
              subtotal,
            }
          })
          .filter((group) => group.salesLines.length > 0 || group.chargebackLines.length > 0),
      }
    : null

  const policyKeyByLineId = new Map<string, string>()
  if (draft && bpoDetail) {
    for (const group of bpoDetail.groups) {
      const lines = [...group.salesLines, ...group.chargebackLines]
      for (const line of lines) {
        const key = resolvePolicyKey(group.callCenter, line.policyNumber)
        if (key) policyKeyByLineId.set(line.id, key)
      }
    }
  }

  const updateLineField = <K extends keyof BpoInvoiceLine>(lineId: string, field: K, value: BpoInvoiceLine[K]) => {
    setLineEdits((prev) => ({
      ...prev,
      [lineId]: {
        ...(prev[lineId] || {}),
        [field]: value,
      },
    }))
  }

  const confirmAndExcludePolicy = (policyKey: string) => {
    const confirmed = window.confirm(
      'Removing this policy will remove its payment from the current invoice cycle. It will be included again in the next invoicing cycle when you regenerate invoices. Do you want to continue?'
    )
    if (!confirmed) return
    setExcludedPolicyKeys((prev) => ({ ...prev, [policyKey]: true }))
  }

  const exportPdfForGroup = async (group: BpoInvoiceDetailResult['groups'][number]) => {
    if (!visibleBpoDetail) return
    const safeFilePart = (v: string) => v.replace(/[^a-zA-Z0-9._-]+/g, '_')
    const suggested = `${safeFilePart(group.callCenter)}_${safeFilePart(visibleBpoDetail.startDate)}_${safeFilePart(visibleBpoDetail.endDate)}.pdf`
    const previousChargeback = Number.parseFloat(previousChargebackByCallCenter[group.callCenter] ?? '0')
    const previousNegativeBalance = Number.isNaN(previousChargeback) ? 0 : previousChargeback
    const payload = {
      callCenter: group.callCenter,
      rangeLabel: visibleBpoDetail.rangeLabel,
      fileName: suggested,
      salesLines: group.salesLines.map((line) => ({
        insuredName: line.insuredName,
        leadValue: line.leadValue,
        carrier: line.carrier,
        product: line.product ?? null,
        agentAccount: line.agentAccount,
        draftDate: line.draftDate,
        monthlyPremium: line.monthlyPremium,
        coverageAmount: line.coverageAmount,
        comPct: line.comPct ?? null,
        comType: line.comType,
      })),
      chargebackLines: group.chargebackLines.map((line) => ({
        insuredName: line.insuredName,
        leadValue: line.leadValue,
        carrier: line.carrier,
        product: line.product ?? null,
        agentAccount: line.agentAccount,
        draftDate: line.draftDate,
        monthlyPremium: line.monthlyPremium,
        coverageAmount: line.coverageAmount,
        comPct: line.comPct ?? null,
        comType: line.comType,
      })),
      newBusinessTotal: group.newBusinessTotal,
      chargebacksTotal: group.chargebacksTotal,
      previousNegativeBalance,
      balanceDue: balanceDueForBpo(group.callCenter, group.subtotal),
    }

    try {
      const res = await fetch('/api/invoicing/export-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        throw new Error(`PDF export failed (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggested
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (error) {
      console.error('PDF export failed:', error)
      window.alert('PDF export failed. Please try again.')
    }
  }

  const exportPdf = async () => {
    if (!visibleBpoDetail || visibleBpoDetail.groups.length === 0) return
    for (const group of visibleBpoDetail.groups) {
      await exportPdfForGroup(group)
    }
  }

  const exportExcel = () => {
    if (!visibleBpoDetail || visibleBpoDetail.groups.length === 0) return
    const wb = XLSX.utils.book_new()

    for (const group of visibleBpoDetail.groups) {
      const tableHeaders = [
        'Policy #',
        'Name',
        'Lead Value (50%)',
        'Carrier',
        'Product Type',
        'Agent Account',
        'Draft Date',
        'Monthly Premium',
        'Coverage Amount',
        'Com %',
        'Com Type',
        'Status',
      ]
      const rows: Array<Array<string | number>> = []
      rows.push(['Call Center', group.callCenter])
      rows.push(['Invoice Range', visibleBpoDetail.rangeLabel])
      rows.push([])
      rows.push(['Sales'])
      rows.push(tableHeaders)
      if (group.salesLines.length === 0) {
        rows.push(['', 'No sales in this period.'])
      } else {
        for (const line of group.salesLines) {
          rows.push([
            line.policyNumber,
            line.insuredName,
            round2(line.leadValue),
            line.carrier,
            line.product ?? '—',
            line.agentAccount,
            line.draftDate,
            line.monthlyPremium != null ? round2(line.monthlyPremium) : '—',
            line.coverageAmount != null ? round2(line.coverageAmount) : '—',
            line.comPct ?? '—',
            line.comType,
            formatInvoicingStatusLabel(line.invoicingStatus),
          ])
        }
      }

      rows.push([])
      rows.push(['Chargebacks'])
      rows.push(tableHeaders)
      if (group.chargebackLines.length === 0) {
        rows.push(['', 'No chargebacks in this period.'])
      } else {
        for (const line of group.chargebackLines) {
          rows.push([
            line.policyNumber,
            line.insuredName,
            round2(line.leadValue),
            line.carrier,
            line.product ?? '—',
            line.agentAccount,
            line.draftDate,
            line.monthlyPremium != null ? round2(line.monthlyPremium) : '—',
            line.coverageAmount != null ? round2(line.coverageAmount) : '—',
            line.comPct ?? '—',
            line.comType,
            formatInvoicingStatusLabel(line.invoicingStatus),
          ])
        }
      }

      rows.push([])
      const previousChargeback = Number.parseFloat(previousChargebackByCallCenter[group.callCenter] ?? '0')
      const prev = Number.isNaN(previousChargeback) ? 0 : previousChargeback
      rows.push(['Summary'])
      rows.push(['New Business Total', round2(group.newBusinessTotal)])
      rows.push(['Chargebacks Total', round2(group.chargebacksTotal)])
      rows.push(['Previous Chargeback', round2(prev)])
      rows.push(['Balance Due', round2(balanceDueForBpo(group.callCenter, group.subtotal))])

      const sheetName = group.callCenter.slice(0, 31) || 'CallCenter'
      const ws = XLSX.utils.aoa_to_sheet(rows)
      ws['!cols'] = [
        { wch: 14 }, // Policy #
        { wch: 28 }, // Name
        { wch: 16 }, // Lead Value
        { wch: 28 }, // Carrier
        { wch: 18 }, // Product Type
        { wch: 20 }, // Agent Account
        { wch: 14 }, // Draft Date
        { wch: 16 }, // Monthly Premium
        { wch: 16 }, // Coverage
        { wch: 10 }, // Com %
        { wch: 16 }, // Com Type
        { wch: 16 }, // Status
      ]
      XLSX.utils.book_append_sheet(wb, ws, sheetName)
    }

    const fileFrom = visibleBpoDetail.startDate.replace(/-/g, '')
    const fileTo = visibleBpoDetail.endDate.replace(/-/g, '')
    XLSX.writeFile(wb, `invoices_${fileFrom}_${fileTo}.xlsx`)
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
            <Button
              onClick={() => void generateInvoice(selectedCallCenter === 'ALL' ? null : selectedCallCenter)}
              disabled={loading}
              className="bg-orange-500 text-black hover:bg-orange-400"
            >
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
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Call Center</span>
            <select
              value={selectedCallCenter}
              onChange={(e) => setSelectedCallCenter(e.target.value)}
              className="h-9 min-w-[260px] rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              style={{ colorScheme: 'dark' }}
            >
              <option value="ALL" style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>All Call Centers</option>
              {availableCallCenters.map((center) => (
                <option key={center} value={center} style={{ color: '#0f172a', backgroundColor: '#ffffff' }}>
                  {center}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {visibleDraft && visibleDraft.groups.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 print:hidden dark:border-slate-800">
          <div className="text-sm text-muted-foreground">
            {visibleBpoDetail && visibleBpoDetail.groups.length > 0 ? (
              <>
                Invoice period: <span className="font-medium text-foreground">{visibleBpoDetail.rangeLabel}</span>
              </>
            ) : (
              <span>Review invoices below, then mark the batch as paid when settled.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={exportExcel} variant="outline" disabled={!visibleBpoDetail || visibleBpoDetail.groups.length === 0}>
              Export Excel
            </Button>
            <Button onClick={() => void exportPdf()} variant="outline" disabled={!visibleBpoDetail || visibleBpoDetail.groups.length === 0}>
              Export PDF
            </Button>
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
        </div>
      )}

      {visibleBpoDetail && visibleBpoDetail.groups.length === 0 && visibleDraft && visibleDraft.groups.length === 0 && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground">
            No commission transactions found in this date range.
          </CardContent>
        </Card>
      )}

      {visibleBpoDetail?.groups.map((group) => (
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
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{visibleBpoDetail.rangeLabel}</p>
            <div className="mt-3 print:hidden">
              <div className="flex items-center justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void exportPdfForGroup(group)}>
                  Export PDF
                </Button>
                <Button
                  size="sm"
                  onClick={() => void markGroupPaid(group.callCenter)}
                  disabled={saving}
                  className="bg-green-600 text-white hover:bg-green-700"
                >
                  Mark Paid
                </Button>
              </div>
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {/* Sales section */}
            <div className="mb-6">
              <div className="rounded-t-md bg-teal-600 px-3 py-2 text-center text-sm font-semibold text-white dark:bg-teal-700">
                Sales
              </div>
              <div className="min-w-0 overflow-x-auto rounded-b-md border border-t-0 border-slate-200 dark:border-slate-700">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className={cn(invoiceTableHead, 'print:hidden')}>Policy #</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'min-w-[100px]')}>Sales</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Lead value (50%)</TableHead>
                        <TableHead className={invoiceTableHead}>Carrier</TableHead>
                        <TableHead className={invoiceTableHead}>Product Type</TableHead>
                        <TableHead className={invoiceTableHead}>Agent Account</TableHead>
                        <TableHead className={invoiceTableHead}>Draft Date</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Monthly Premium</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Coverage Amount</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Com %</TableHead>
                        <TableHead className={invoiceTableHead}>Com Type</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'print:hidden')}>Status</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'print:hidden text-right')}>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.salesLines.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={13} className={cn(invoiceCell, 'text-muted-foreground')}>
                            No sales in this period.
                          </TableCell>
                        </TableRow>
                      ) : (
                        group.salesLines.map((line) => (
                          <TableRow key={line.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-900/50">
                            <TableCell className={cn(invoiceCell, 'font-mono print:hidden')}>
                              <Input
                                value={line.policyNumber}
                                onChange={(e) => updateLineField(line.id, 'policyNumber', e.target.value)}
                                className="h-8 min-w-[120px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.insuredName}
                                onChange={(e) => updateLineField(line.id, 'insuredName', e.target.value)}
                                className="h-8 min-w-[160px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right font-mono')}>
                              <Input
                                type="number"
                                value={line.leadValue}
                                onChange={(e) => updateLineField(line.id, 'leadValue', round2(Number(e.target.value) || 0))}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.carrier}
                                onChange={(e) => updateLineField(line.id, 'carrier', e.target.value)}
                                className="h-8 min-w-[150px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.product ?? ''}
                                onChange={(e) => updateLineField(line.id, 'product', e.target.value)}
                                className="h-8 min-w-[140px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.agentAccount}
                                onChange={(e) => updateLineField(line.id, 'agentAccount', e.target.value)}
                                className="h-8 min-w-[140px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.draftDate}
                                onChange={(e) => updateLineField(line.id, 'draftDate', e.target.value)}
                                className="h-8 w-[110px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                type="number"
                                value={line.monthlyPremium ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  updateLineField(line.id, 'monthlyPremium', raw === '' ? null : round2(Number(raw) || 0))
                                }}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                type="number"
                                value={line.coverageAmount ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  updateLineField(line.id, 'coverageAmount', raw === '' ? null : round2(Number(raw) || 0))
                                }}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                value={line.comPct ?? ''}
                                onChange={(e) => updateLineField(line.id, 'comPct', e.target.value)}
                                className="h-8 w-[80px] text-right"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.comType}
                                onChange={(e) => updateLineField(line.id, 'comType', e.target.value)}
                                className="h-8 min-w-[120px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'print:hidden')}>
                              <select
                                value={line.invoicingStatus}
                                onChange={(e) => updateLineField(line.id, 'invoicingStatus', e.target.value as InvoicingStatus)}
                                className="h-8 rounded border border-slate-300 bg-transparent px-2 text-xs dark:border-slate-700"
                              >
                                {['new_sale', 'New Charge Back', 'repay', 'rechargeback', 'paid_delete', 'cb_delete', 'cb_never_paid', 'cb_repay'].map((s) => (
                                  <option key={s} value={s}>{formatInvoicingStatusLabel(s as InvoicingStatus)}</option>
                                ))}
                              </select>
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'print:hidden text-right')}>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const policyKey = policyKeyByLineId.get(line.id) ?? resolvePolicyKey(group.callCenter, line.policyNumber)
                                  if (!policyKey) return
                                  confirmAndExcludePolicy(policyKey)
                                }}
                              >
                                Remove
                              </Button>
                            </TableCell>
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
              <div className="min-w-0 overflow-x-auto rounded-b-md border border-t-0 border-slate-200 dark:border-slate-700">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className={cn(invoiceTableHead, 'print:hidden')}>Policy #</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'min-w-[100px]')}>Chargebacks</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Lead value (50%)</TableHead>
                        <TableHead className={invoiceTableHead}>Carrier</TableHead>
                        <TableHead className={invoiceTableHead}>Product Type</TableHead>
                        <TableHead className={invoiceTableHead}>Agent Account</TableHead>
                        <TableHead className={invoiceTableHead}>Draft Date</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Monthly Premium</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Coverage Amount</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'text-right')}>Com %</TableHead>
                        <TableHead className={invoiceTableHead}>Com Type</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'print:hidden')}>Status</TableHead>
                        <TableHead className={cn(invoiceTableHead, 'print:hidden text-right')}>Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.chargebackLines.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={13} className={cn(invoiceCell, 'text-muted-foreground')}>
                            No chargebacks in this period.
                          </TableCell>
                        </TableRow>
                      ) : (
                        group.chargebackLines.map((line) => (
                          <TableRow key={line.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-900/50">
                            <TableCell className={cn(invoiceCell, 'font-mono print:hidden')}>
                              <Input
                                value={line.policyNumber}
                                onChange={(e) => updateLineField(line.id, 'policyNumber', e.target.value)}
                                className="h-8 min-w-[120px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.insuredName}
                                onChange={(e) => updateLineField(line.id, 'insuredName', e.target.value)}
                                className="h-8 min-w-[160px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right font-mono text-rose-700 dark:text-rose-400')}>
                              <Input
                                type="number"
                                value={line.leadValue}
                                onChange={(e) => updateLineField(line.id, 'leadValue', round2(Number(e.target.value) || 0))}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.carrier}
                                onChange={(e) => updateLineField(line.id, 'carrier', e.target.value)}
                                className="h-8 min-w-[150px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.product ?? ''}
                                onChange={(e) => updateLineField(line.id, 'product', e.target.value)}
                                className="h-8 min-w-[140px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.agentAccount}
                                onChange={(e) => updateLineField(line.id, 'agentAccount', e.target.value)}
                                className="h-8 min-w-[140px]"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.draftDate}
                                onChange={(e) => updateLineField(line.id, 'draftDate', e.target.value)}
                                className="h-8 w-[110px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                type="number"
                                value={line.monthlyPremium ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  updateLineField(line.id, 'monthlyPremium', raw === '' ? null : round2(Number(raw) || 0))
                                }}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                type="number"
                                value={line.coverageAmount ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value
                                  updateLineField(line.id, 'coverageAmount', raw === '' ? null : round2(Number(raw) || 0))
                                }}
                                className="h-8 w-[120px] text-right font-mono"
                                step="0.01"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'text-right')}>
                              <Input
                                value={line.comPct ?? ''}
                                onChange={(e) => updateLineField(line.id, 'comPct', e.target.value)}
                                className="h-8 w-[80px] text-right"
                              />
                            </TableCell>
                            <TableCell className={invoiceCell}>
                              <Input
                                value={line.comType}
                                onChange={(e) => updateLineField(line.id, 'comType', e.target.value)}
                                className="h-8 min-w-[120px]"
                              />
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'print:hidden')}>
                              <select
                                value={line.invoicingStatus}
                                onChange={(e) => updateLineField(line.id, 'invoicingStatus', e.target.value as InvoicingStatus)}
                                className="h-8 rounded border border-slate-300 bg-transparent px-2 text-xs dark:border-slate-700"
                              >
                                {['new_sale', 'New Charge Back', 'repay', 'rechargeback', 'paid_delete', 'cb_delete', 'cb_never_paid', 'cb_repay'].map((s) => (
                                  <option key={s} value={s}>{formatInvoicingStatusLabel(s as InvoicingStatus)}</option>
                                ))}
                              </select>
                            </TableCell>
                            <TableCell className={cn(invoiceCell, 'print:hidden text-right')}>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const policyKey = policyKeyByLineId.get(line.id) ?? resolvePolicyKey(group.callCenter, line.policyNumber)
                                  if (!policyKey) return
                                  confirmAndExcludePolicy(policyKey)
                                }}
                              >
                                Remove
                              </Button>
                            </TableCell>
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
                    New Business From {visibleBpoDetail.rangeLabel}
                  </span>
                  <span className="font-semibold tabular-nums text-emerald-800 dark:text-emerald-300">
                    ${formatMoney(group.newBusinessTotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-4 rounded-md bg-rose-50 px-3 py-2 dark:bg-rose-950/40">
                  <span className="text-slate-700 dark:text-rose-100/90">
                    Charge-Backs From {visibleBpoDetail.rangeLabel}
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
