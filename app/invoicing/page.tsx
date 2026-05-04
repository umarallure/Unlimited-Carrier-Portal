'use client'

import { useState } from 'react'
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
  saveInvoiceDraftSnapshot,
  loadInvoiceDraftSnapshot,
  clearInvoiceDraftSnapshot,
  normalizeCallCenterName,
  type InvoiceDraftSnapshot,
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

const PRESET_CALL_CENTERS = [
  'AJ BPO',
  'Alternative BPO',
  'Ambition BPO',
  'Argon Comm',
  'Argon Comm BPO',
  'Ark Tech',
  'ArkTech BPO',
  'Ascendra BPO',
  'Avenue Consultancy',
  'Broker Leads BPO',
  'Care Solutions',
  'Cerberus BPO',
  'Core Marketing',
  'Corebiz',
  'Corebiz BPO',
  'CoreBiz BPO',
  'Crafting Leads BPO',
  'CrossNotch',
  'CrossNotch BPO',
  'Crown Connect BPO',
  'Cyber Leads',
  'Digicon BPO',
  'DownTown',
  'DownTown BPO',
  'ECH09X',
  'Emperor BPO',
  'Everest BPO',
  'Everline solution BPO',
  'Exito BPO',
  'F24051656878',
  'GrowthOnics BPO',
  'Helix BPO',
  'HYF-TEL',
  'INB BPO',
  'Inrernal BPO',
  'Internal',
  'Internal BPO',
  'Jason BPO',
  'Lavish BPO',
  'Leads BPO',
  'Libra BPO',
  'Maverick Communications',
  'NanoTech',
  'Networkize',
  'NexGen BPO',
  'NextPoint BPO',
  'Optimum BPO',
  'Plexi',
  'Plexi BPO',
  'Poshenee Tech',
  'Pro Soliutions BPO',
  'Pro Solutions BPO',
  'Progressive BPO',
  'Quotes BPO',
  'Reliant',
  'Retention BPO',
  'Rock BPO',
  'Seller',
  'SellerZ',
  'SellerZ BPO',
  'StratiX BPO',
  'TechPlanet',
  'TechVated Marketing',
  'The Zupax Marketing',
  'Trust Link',
  'Unified Systems BPO',
  'Vize BPO',
  'VYN BPO',
  'WinBPO',
  'Winners Limited',
  'Wolf Innovations',
  'Zupax Marketing',
] as const

export default function InvoicingPage() {
  const INVOICE_SLAB_DAYS = 14
  const supabase = createClient()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraftResult | null>(null)
  const [bpoDetail, setBpoDetail] = useState<BpoInvoiceDetailResult | null>(null)
  const [previousChargebackByCallCenter, setPreviousChargebackByCallCenter] = useState<Record<string, string>>({})
  const [excludedPolicyKeys, setExcludedPolicyKeys] = useState<Record<string, true>>({})
  const [excludedLineIds, setExcludedLineIds] = useState<Record<string, true>>({})
  const [lineEdits, setLineEdits] = useState<Record<string, Partial<BpoInvoiceLine>>>({})
  const [pdfExportedByCenter, setPdfExportedByCenter] = useState<Record<string, true>>({})
  const [availableCallCenters] = useState<string[]>(() =>
    Array.from(new Set(PRESET_CALL_CENTERS.map((c) => normalizeCallCenterName(c)))).sort((a, b) =>
      a.localeCompare(b),
    ),
  )
  const [selectedCallCenter, setSelectedCallCenter] = useState<string>('ALL')
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  const [showWeekScript, setShowWeekScript] = useState(false)
  const [weekScriptRowsFromDrafts, setWeekScriptRowsFromDrafts] = useState<Array<{ callCenter: string; payment: number }>>([])
  const [weekScriptLoading, setWeekScriptLoading] = useState(false)

  const balanceDueForBpo = (callCenter: string, subtotal: number): number => {
    const raw = previousChargebackByCallCenter[callCenter] ?? '0'
    const prev = Number.parseFloat(raw)
    const p = Number.isNaN(prev) ? 0 : prev
    return round2(subtotal - p)
  }

  function round2(n: number): number {
    return Math.round(n * 100) / 100
  }

  function addDays(ymd: string, days: number): string {
    if (!ymd) return ''
    const d = new Date(`${ymd}T00:00:00`)
    if (Number.isNaN(d.getTime())) return ''
    d.setDate(d.getDate() + days)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  const applySlabFrom = (fromYmd: string) => {
    setDateFrom(fromYmd)
    setDateTo(addDays(fromYmd, INVOICE_SLAB_DAYS - 1))
  }

  const shiftSlab = (direction: -1 | 1) => {
    if (!dateFrom) return
    const nextFrom = addDays(dateFrom, direction * INVOICE_SLAB_DAYS)
    if (!nextFrom) return
    applySlabFrom(nextFrom)
  }

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
      setExcludedLineIds({})
      setLineEdits({})
      setPdfExportedByCenter({})
      setDraftSavedAt(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate invoice draft.'
      alert(message)
    } finally {
      setLoading(false)
    }
  }

  const saveDraftLocally = async () => {
    if (selectedCallCenter === 'ALL') {
      alert('Please select one call center. Drafts are saved per slab per call center.')
      return
    }
    if (!draft || !bpoDetail) {
      alert('Generate invoice first, then move it to draft.')
      return
    }
    const payload: InvoiceDraftSnapshot = {
      dateFrom,
      dateTo,
      selectedCallCenter,
      draft,
      bpoDetail,
      previousChargebackByCallCenter,
      excludedPolicyKeys,
      excludedLineIds,
      lineEdits,
      pdfExportedByCenter,
      savedAt: new Date().toISOString(),
    }
    try {
      const { data } = await supabase.auth.getUser()
      await saveInvoiceDraftSnapshot({
        startDate: dateFrom,
        endDate: dateTo,
        callCenterFilter: selectedCallCenter,
        payload,
        savedByEmail: data.user?.email || null,
      })
      setDraftSavedAt(payload.savedAt)
      alert('Invoice moved to draft. You can load and continue editing anytime.')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to save draft.'
      alert(message)
    }
  }

  const loadDraftLocally = async () => {
    if (selectedCallCenter === 'ALL') {
      alert('Please select one call center to load its draft.')
      return
    }
    if (!dateFrom || !dateTo) {
      alert('Select invoice date range first to load server draft.')
      return
    }
    try {
      const record = await loadInvoiceDraftSnapshot({
        startDate: dateFrom,
        endDate: dateTo,
        callCenterFilter: selectedCallCenter,
      })
      if (!record?.payload) {
        alert('No saved draft found for this cycle/call center.')
        return
      }
      const saved = record.payload
      setDateFrom(saved.dateFrom || dateFrom)
      setDateTo(saved.dateTo || dateTo)
      setSelectedCallCenter(saved.selectedCallCenter || selectedCallCenter)
      setDraft(saved.draft)
      setBpoDetail(saved.bpoDetail)
      setPreviousChargebackByCallCenter(saved.previousChargebackByCallCenter || {})
      setExcludedPolicyKeys(saved.excludedPolicyKeys || {})
      setExcludedLineIds(saved.excludedLineIds || {})
      setLineEdits(saved.lineEdits || {})
      setPdfExportedByCenter(saved.pdfExportedByCenter || {})
      setDraftSavedAt(record.updated_at || saved.savedAt || null)
      alert('Draft loaded successfully.')
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load draft.'
      alert(message)
    }
  }

  const markPaid = async () => {
    if (!visibleDraft || visibleDraft.groups.length === 0) return
    const missingPdfCenters = visibleDraft.groups
      .map((g) => g.callCenter)
      .filter((center) => !pdfExportedByCenter[center])
    if (missingPdfCenters.length > 0) {
      alert(`Please export PDF first for: ${missingPdfCenters.join(', ')}`)
      return
    }
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
      setExcludedLineIds({})
      setLineEdits({})
      try {
        await clearInvoiceDraftSnapshot({
          startDate: visibleDraft.startDate,
          endDate: visibleDraft.endDate,
          callCenterFilter: selectedCallCenter === 'ALL' ? null : selectedCallCenter,
        })
      } catch (draftClearError) {
        console.warn('Failed to clear saved draft after mark paid:', draftClearError)
      }
      setDraftSavedAt(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to mark invoice as paid.'
      alert(message)
    } finally {
      setSaving(false)
    }
  }

  const markGroupPaid = async (callCenter: string) => {
    if (!visibleDraft) return
    if (!pdfExportedByCenter[callCenter]) {
      alert(`Please export PDF for ${callCenter} before marking paid.`)
      return
    }
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
      setPdfExportedByCenter((prev) => {
        const next = { ...prev }
        delete next[callCenter]
        return next
      })
      try {
        await clearInvoiceDraftSnapshot({
          startDate: visibleDraft.startDate,
          endDate: visibleDraft.endDate,
          callCenterFilter: selectedCallCenter === 'ALL' ? null : selectedCallCenter,
        })
      } catch (draftClearError) {
        console.warn('Failed to clear saved draft after center mark paid:', draftClearError)
      }
      setDraftSavedAt(null)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : `Failed to mark ${callCenter} as paid.`
      alert(message)
    } finally {
      setSaving(false)
    }
  }

  const addManualRow = (callCenter: string, kind: 'sales' | 'chargeback') => {
    setBpoDetail((prev) => {
      if (!prev) return prev
      const groups = prev.groups.map((group) => {
        if (group.callCenter !== callCenter) return group
        const newLine: BpoInvoiceLine = {
          id: `manual-${kind}-${callCenter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          insuredName: '',
          leadValue: 0,
          invoicingStatus: kind === 'sales' ? 'new_sale' : 'New Charge Back',
          carrier: '',
          product: null,
          agentAccount: '',
          draftDate: '',
          monthlyPremium: null,
          coverageAmount: null,
          comPct: null,
          comType: kind === 'sales' ? 'Advance' : 'Recover Unea',
          policyNumber: '',
        }
        return kind === 'sales'
          ? { ...group, salesLines: [...group.salesLines, newLine] }
          : { ...group, chargebackLines: [...group.chargebackLines, newLine] }
      })
      return { ...prev, groups }
    })
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
              if (excludedLineIds[line.id]) return false
              const key = resolvePolicyKey(group.callCenter, line.policyNumber)
              return !key || !excludedPolicyKeys[key]
            }).map(applyLineEdit)
            const chargebackLines = group.chargebackLines.filter((line) => {
              if (excludedLineIds[line.id]) return false
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

  const confirmAndExcludeLine = (lineId: string) => {
    const confirmed = window.confirm(
      'Removing this policy will remove its payment from the current invoice cycle. It will be included again in the next invoicing cycle when you regenerate invoices. Do you want to continue?'
    )
    if (!confirmed) return
    setExcludedLineIds((prev) => ({ ...prev, [lineId]: true }))
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
      setPdfExportedByCenter((prev) => ({ ...prev, [group.callCenter]: true }))
    } catch (error) {
      console.error('PDF export failed:', error)
      const esc = (v: string) =>
        v
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      const money = (n: number | null | undefined) => (n == null ? '—' : `$${formatMoney(n)}`)
      const salesRows = group.salesLines
        .map(
          (line) => `
            <tr>
              <td>${esc(line.insuredName)}</td>
              <td style="text-align:right;">${money(line.leadValue)}</td>
              <td>${esc(line.carrier)}</td>
              <td>${esc(line.product ?? '—')}</td>
              <td>${esc(line.agentAccount)}</td>
              <td>${esc(line.draftDate)}</td>
              <td style="text-align:right;">${money(line.monthlyPremium)}</td>
              <td style="text-align:right;">${money(line.coverageAmount)}</td>
              <td style="text-align:right;">${esc(line.comPct ?? '—')}</td>
              <td>${esc(line.comType)}</td>
            </tr>
          `,
        )
        .join('')
      const chargeRows = group.chargebackLines
        .map(
          (line) => `
            <tr>
              <td>${esc(line.insuredName)}</td>
              <td style="text-align:right;">${money(line.leadValue)}</td>
              <td>${esc(line.carrier)}</td>
              <td>${esc(line.product ?? '—')}</td>
              <td>${esc(line.agentAccount)}</td>
              <td>${esc(line.draftDate)}</td>
              <td style="text-align:right;">${money(line.monthlyPremium)}</td>
              <td style="text-align:right;">${money(line.coverageAmount)}</td>
              <td style="text-align:right;">${esc(line.comPct ?? '—')}</td>
              <td>${esc(line.comType)}</td>
            </tr>
          `,
        )
        .join('')
      const prevNeg = Number.parseFloat(previousChargebackByCallCenter[group.callCenter] ?? '0') || 0
      const html = `<!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>${esc(suggested)}</title>
        <style>
          :root {
            --bg: #020922;
            --panel: #071638;
            --text: #e5ecff;
            --muted: #9fb2de;
            --line: #1f376f;
            --sales: #00c2b2;
            --chargebacks: #ff5a1f;
            --summary: #2f3f76;
          }
          body {
            font-family: Arial, sans-serif;
            margin: 18px;
            color: var(--text);
            background: var(--bg);
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .header-wrap {
            border: 1px solid var(--line);
            border-radius: 10px;
            padding: 14px 16px;
            background: linear-gradient(180deg, #071c47 0%, #051433 100%);
          }
          h1 { margin: 0; font-size: 20px; color: #ffffff; }
          .sub { margin: 4px 0 0; color: var(--muted); font-size: 12px; }
          .section-title {
            margin: 16px 0 0;
            color: #fff;
            font-size: 13px;
            font-weight: 700;
            padding: 7px 10px;
            border-radius: 6px 6px 0 0;
          }
          .section-title.sales { background: var(--sales); }
          .section-title.chargebacks { background: var(--chargebacks); }
          table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 10px; table-layout: fixed; }
          th, td { border: 1px solid var(--line); padding: 6px 7px; text-align: left; }
          thead th {
            background: #0a204f;
            color: #cfe0ff;
            font-size: 10px;
            text-transform: uppercase;
            letter-spacing: 0.02em;
          }
          tbody td { background: var(--panel); }
          .summary {
            margin-top: 12px;
            width: 360px;
            margin-left: auto;
            border-collapse: collapse;
          }
          .summary td {
            border: 1px solid var(--line);
            padding: 8px;
            background: var(--panel);
          }
          .summary td:first-child {
            background: var(--summary);
            font-weight: 600;
          }
          @page { size: A4 landscape; margin: 8mm; }
          @media print {
            body {
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
            }
          }
        </style>
      </head>
      <body>
        <div class="header-wrap">
          <h1>${esc(group.callCenter)}</h1>
          <div class="sub">${esc(visibleBpoDetail.rangeLabel)}</div>
        </div>
        <div class="section-title sales">Sales</div>
        <table>
          <thead><tr><th>Sales</th><th>Lead value (50%)</th><th>Carrier</th><th>Product Type</th><th>Agent Account</th><th>Draft Date</th><th>Monthly Premium</th><th>Coverage Amount</th><th>Com %</th><th>Com Type</th></tr></thead>
          <tbody>${salesRows || '<tr><td colspan="10">No sales in this period.</td></tr>'}</tbody>
        </table>
        <div class="section-title chargebacks">Chargebacks</div>
        <table>
          <thead><tr><th>Chargebacks</th><th>Lead value (50%)</th><th>Carrier</th><th>Product Type</th><th>Agent Account</th><th>Draft Date</th><th>Monthly Premium</th><th>Coverage Amount</th><th>Com %</th><th>Com Type</th></tr></thead>
          <tbody>${chargeRows || '<tr><td colspan="10">No chargebacks in this period.</td></tr>'}</tbody>
        </table>
        <table class="summary">
          <tbody>
            <tr><td>New Business Total</td><td style="text-align:right;">${money(group.newBusinessTotal)}</td></tr>
            <tr><td>Chargebacks Total</td><td style="text-align:right;">${money(group.chargebacksTotal)}</td></tr>
            <tr><td>Negative Balance From Last Week</td><td style="text-align:right;">-${money(Math.abs(prevNeg))}</td></tr>
            <tr><td>Balance Due</td><td style="text-align:right;">${money(balanceDueForBpo(group.callCenter, group.subtotal))}</td></tr>
          </tbody>
        </table>
      </body>
      </html>`
      const w = window.open('', '_blank')
      if (w) {
        w.document.open()
        w.document.write(html)
        w.document.close()
        setTimeout(() => {
          w.focus()
          w.print()
        }, 250)
        setPdfExportedByCenter((prev) => ({ ...prev, [group.callCenter]: true }))
        window.alert('Server PDF export failed on this environment. Opened print dialog fallback (Save as PDF).')
      } else {
        window.alert('PDF export failed and popup was blocked. Please allow popups and try again.')
      }
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

  const loadWeekScriptForCycle = async () => {
    if (!dateFrom || !dateTo) {
      alert('Select invoice slab first.')
      return
    }
    setWeekScriptLoading(true)
    try {
      const { data, error } = await supabase
        .from('invoicing_drafts')
        .select('payload, updated_at')
        .eq('start_date', dateFrom)
        .eq('end_date', dateTo)
        .is('locked_at', null)
        .is('paid_batch_id', null)
        .order('updated_at', { ascending: false })
      if (error) throw error

      const merged = new Map<string, { payment: number; updatedAt: string }>()
      const rows = (data || []) as Array<{ payload?: InvoiceDraftSnapshot; updated_at?: string }>

      const computePayloadGroupSubtotal = (
        payload: InvoiceDraftSnapshot,
        group: InvoiceDraftSnapshot['bpoDetail']['groups'][number],
      ): number => {
        const policyKeyByCenterAndNumber = new Map<string, string>()
        for (const draftGroup of payload.draft?.groups || []) {
          for (const p of draftGroup.policies || []) {
            policyKeyByCenterAndNumber.set(`${draftGroup.callCenter}::${p.policyNumber}`, p.policyKey)
            const normalized = normalizePolicyNumberForMatch(p.policyNumber)
            if (normalized && normalized !== p.policyNumber) {
              policyKeyByCenterAndNumber.set(`${draftGroup.callCenter}::${normalized}`, p.policyKey)
            }
          }
        }

        const resolvePayloadPolicyKey = (callCenter: string, policyNumber: string): string | undefined => {
          const direct = policyKeyByCenterAndNumber.get(`${callCenter}::${policyNumber}`)
          if (direct) return direct
          const normalized = normalizePolicyNumberForMatch(policyNumber)
          if (!normalized) return undefined
          return policyKeyByCenterAndNumber.get(`${callCenter}::${normalized}`)
        }

        const applyPayloadEdit = (line: BpoInvoiceLine): BpoInvoiceLine => {
          const edit = payload.lineEdits?.[line.id]
          return edit ? { ...line, ...edit } : line
        }

        const toLeadValue = (line: BpoInvoiceLine): number => {
          const n = Number(line.leadValue)
          return Number.isFinite(n) ? n : 0
        }

        const salesLines = (group.salesLines || [])
          .filter((line) => {
            if (payload.excludedLineIds?.[line.id]) return false
            const key = resolvePayloadPolicyKey(group.callCenter, line.policyNumber)
            return !key || !payload.excludedPolicyKeys?.[key]
          })
          .map(applyPayloadEdit)

        const chargebackLines = (group.chargebackLines || [])
          .filter((line) => {
            if (payload.excludedLineIds?.[line.id]) return false
            const key = resolvePayloadPolicyKey(group.callCenter, line.policyNumber)
            return !key || !payload.excludedPolicyKeys?.[key]
          })
          .map(applyPayloadEdit)

        const subtotal = round2(
          salesLines.reduce((s, l) => s + toLeadValue(l), 0) +
          chargebackLines.reduce((s, l) => s + toLeadValue(l), 0),
        )
        return subtotal
      }

      for (const row of rows) {
        const payload = row.payload
        if (!payload?.bpoDetail?.groups) continue
        for (const group of payload.bpoDetail.groups) {
          const center = normalizeCallCenterName(group.callCenter)
          const prevRaw = payload.previousChargebackByCallCenter?.[group.callCenter] ?? payload.previousChargebackByCallCenter?.[center] ?? '0'
          const prev = Number.parseFloat(String(prevRaw))
          const previous = Number.isNaN(prev) ? 0 : prev
          const recomputedSubtotal = computePayloadGroupSubtotal(payload, group)
          const payment = round2(recomputedSubtotal - previous)
          const existing = merged.get(center)
          const stamp = row.updated_at || ''
          if (!existing || stamp >= existing.updatedAt) {
            merged.set(center, { payment, updatedAt: stamp })
          }
        }
      }

      // Include currently loaded draft in priority so latest in-UI edits show up instantly.
      if (visibleBpoDetail) {
        for (const group of visibleBpoDetail.groups) {
          const center = normalizeCallCenterName(group.callCenter)
          const payment = round2(balanceDueForBpo(group.callCenter, group.subtotal))
          merged.set(center, { payment, updatedAt: new Date().toISOString() })
        }
      }

      setWeekScriptRowsFromDrafts(
        Array.from(merged.entries()).map(([callCenter, v]) => ({ callCenter, payment: v.payment })),
      )
      setShowWeekScript(true)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to load week script.'
      alert(message)
    } finally {
      setWeekScriptLoading(false)
    }
  }

  const weekScriptRows = weekScriptRowsFromDrafts
  const payableRows = weekScriptRows
    .filter((r) => r.payment > 0)
    .sort((a, b) => b.payment - a.payment)
  const noPaymentRows = weekScriptRows
    .filter((r) => r.payment <= 0)
    .sort((a, b) => a.payment - b.payment)
  const totalPayout = round2(payableRows.reduce((sum, r) => sum + r.payment, 0))

  const exportWeekScriptCsv = () => {
    if (weekScriptRows.length === 0) {
      alert('No week script data loaded. Click Week Script first.')
      return
    }
    const escCsv = (v: string) => `"${String(v).replace(/"/g, '""')}"`
    const lines: string[] = []
    lines.push('Call Center,Payment')
    for (const r of payableRows) {
      lines.push(`${escCsv(r.callCenter)},${r.payment.toFixed(2)}`)
    }
    lines.push(`${escCsv('Total Payout')},${totalPayout.toFixed(2)}`)
    if (noPaymentRows.length > 0) {
      lines.push('')
      lines.push('Call Centers with No Payment this Week,Payment')
      for (const r of noPaymentRows) {
        lines.push(`${escCsv(r.callCenter)},${r.payment.toFixed(2)}`)
      }
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const from = dateFrom ? dateFrom.replace(/-/g, '') : 'from'
    const to = dateTo ? dateTo.replace(/-/g, '') : 'to'
    a.href = url
    a.download = `week_script_${from}_${to}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
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
                <Input type="date" value={dateFrom} onChange={(e) => applySlabFrom(e.target.value)} className="h-9 w-[180px]" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input type="date" value={dateTo} readOnly className="h-9 w-[180px] opacity-80" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => shiftSlab(-1)} disabled={!dateFrom}>
                Prev Slab
              </Button>
              <Button type="button" variant="outline" onClick={() => shiftSlab(1)} disabled={!dateFrom}>
                Next Slab
              </Button>
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
            <Button size="sm" variant="outline" onClick={() => void saveDraftLocally()}>
              Move to Draft
            </Button>
            <Button size="sm" variant="outline" onClick={() => void loadDraftLocally()} disabled={selectedCallCenter === 'ALL'}>
              Load Draft
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void loadWeekScriptForCycle()}
              disabled={weekScriptLoading || !dateFrom || !dateTo}
            >
              {weekScriptLoading ? 'Loading Summary...' : 'Breakout Summary'}
            </Button>
            <Button size="sm" variant="outline" onClick={exportWeekScriptCsv} disabled={weekScriptRows.length === 0}>
              Export Breakout CSV
            </Button>
            {showWeekScript && (
              <Button size="sm" variant="outline" onClick={() => setShowWeekScript(false)}>
                Hide Summary
              </Button>
            )}
            {draftSavedAt && (
              <span className="text-xs text-muted-foreground">
                Draft saved: {new Date(draftSavedAt).toLocaleString()}
              </span>
            )}
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
            <Button
              onClick={markPaid}
              disabled={
                saving ||
                !visibleDraft ||
                visibleDraft.groups.length === 0 ||
                visibleDraft.groups.some((g) => !pdfExportedByCenter[g.callCenter])
              }
              className="shrink-0 bg-green-600 text-white hover:bg-green-700"
            >
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

      {showWeekScript && (
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Breakout Summary ({dateFrom && dateTo ? `${dateFrom} to ${dateTo}` : 'Current slab'})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr>
                    <th className="border border-slate-300 bg-slate-100 px-3 py-2 text-left dark:border-slate-700 dark:bg-slate-900">Call Center</th>
                    <th className="border border-slate-300 bg-slate-100 px-3 py-2 text-right dark:border-slate-700 dark:bg-slate-900">Payment</th>
                  </tr>
                </thead>
                <tbody>
                  {payableRows.map((r) => (
                    <tr key={`payable-${r.callCenter}`}>
                      <td className="border border-slate-300 px-3 py-1.5 dark:border-slate-700">{r.callCenter}</td>
                      <td className="border border-slate-300 px-3 py-1.5 text-right font-mono dark:border-slate-700">${formatMoney(r.payment)}</td>
                    </tr>
                  ))}
                  <tr className="bg-emerald-50 dark:bg-emerald-950/30">
                    <td className="border border-slate-300 px-3 py-2 font-semibold dark:border-slate-700">Total Payout</td>
                    <td className="border border-slate-300 px-3 py-2 text-right font-mono font-bold dark:border-slate-700">${formatMoney(totalPayout)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {noPaymentRows.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr>
                      <th className="border border-orange-300 bg-orange-100 px-3 py-2 text-left text-orange-900 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-200">
                        Call Centers with No Payment this Week
                      </th>
                      <th className="border border-orange-300 bg-orange-100 px-3 py-2 text-right text-orange-900 dark:border-orange-800 dark:bg-orange-950/30 dark:text-orange-200">
                        Payment
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {noPaymentRows.map((r) => (
                      <tr key={`nopay-${r.callCenter}`}>
                        <td className="border border-slate-300 px-3 py-1.5 dark:border-slate-700">{r.callCenter}</td>
                        <td className="border border-slate-300 px-3 py-1.5 text-right font-mono dark:border-slate-700">${formatMoney(r.payment)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
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
                <Button size="sm" variant="outline" onClick={() => addManualRow(group.callCenter, 'sales')}>
                  Add Sales Row
                </Button>
                <Button size="sm" variant="outline" onClick={() => addManualRow(group.callCenter, 'chargeback')}>
                  Add Chargeback Row
                </Button>
                <Button
                  size="sm"
                  onClick={() => void markGroupPaid(group.callCenter)}
                  disabled={saving || !pdfExportedByCenter[group.callCenter]}
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
                                  if (policyKey) confirmAndExcludePolicy(policyKey)
                                  else confirmAndExcludeLine(line.id)
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
                                  if (policyKey) confirmAndExcludePolicy(policyKey)
                                  else confirmAndExcludeLine(line.id)
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