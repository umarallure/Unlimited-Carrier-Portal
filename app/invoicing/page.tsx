'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Calendar, ChevronLeft, ChevronRight, ClipboardList, Loader2, Shield } from 'lucide-react'
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import * as XLSX from 'xlsx'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { MultiSelectFilter } from '@/components/filters/MultiSelectFilter'
import { createClient } from '@/lib/supabase/client'
import {
  buildInvoiceDraft,
  buildBpoInvoiceLines,
  formatInvoicingStatusLabel,
  getPreviousChargebackByCallCenter,
  getCallCentersWithUnpaidPreviousSlab,
  markInvoiceBatchPaid,
  saveInvoiceDraftSnapshot,
  loadInvoiceDraftSnapshot,
  normalizeCallCenterName,
  PRESET_ALL_CALL_CENTERS_FILTER,
  type InvoiceDraftSnapshot,
  type BpoInvoiceLine,
  type InvoicingStatus,
  type InvoiceDraftResult,
  type BpoInvoiceDetailResult,
  type UnpaidPreviousSlabCallCenter,
} from '@/lib/invoicing'
import { policyLookupCandidates } from '@/lib/leadNotesSync'
import { cn } from '@/lib/utils'

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

type AuditCommRow = { date: string; advance_amount: number | null; charge_back_amount: number | null; carrier: string }
type AuditInvHistRow = { invoicing_status: string; effective_date: string; week_of: string | null; lead_value: number | null }
type AuditDetails = { loading: boolean; commHistory: AuditCommRow[]; invHistory: AuditInvHistRow[] }

function auditStatusMeta(status: InvoicingStatus): { headline: string; isChargeback: boolean } {
  switch (status) {
    case 'new_sale': return { headline: 'New Sale', isChargeback: false }
    case 'repay': return { headline: 'Repay — Reinstated after Chargeback', isChargeback: false }
    case 'cb_repay': return { headline: 'CB Repay', isChargeback: false }
    case 'New Charge Back': return { headline: 'New Chargeback', isChargeback: true }
    case 'rechargeback': return { headline: 'Re-Chargeback', isChargeback: true }
    case 'cb_never_paid': return { headline: 'Chargeback — Never Invoiced', isChargeback: true }
    default: return { headline: formatInvoicingStatusLabel(status), isChargeback: false }
  }
}

function auditSourceLabel(lineId: string): string {
  if (lineId.startsWith('stage-cb-')) return 'Chargeback pipeline stage (no commission received)'
  if (lineId.startsWith('stage-repay-')) return 'Customer pipeline stage (stage-triggered repay)'
  if (lineId.startsWith('cp-deal-')) return 'Customer pipeline (no commission statement in period)'
  return 'Commission statement'
}

function auditMonthsActive(effectiveDate: string | null | undefined, referenceDate: string): number {
  if (!effectiveDate) return 0
  const eff = new Date(effectiveDate)
  const ref = new Date(referenceDate)
  if (isNaN(eff.getTime()) || isNaN(ref.getTime()) || ref < eff) return 0
  let m = (ref.getFullYear() - eff.getFullYear()) * 12 + (ref.getMonth() - eff.getMonth())
  if (ref.getDate() < eff.getDate()) m -= 1
  return Math.max(0, m)
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
  'Ascendra Elite',
  'Broker bpo',
  'Crossnotch',
  'Crownconnect',
  'Downtown',
  'E reego bpo',
  'Enigma global sol',
  'Everest bpo',
  'Exito',
  'Leads bpo',
  'Leaders bpo',
  'Jsons bpo',
  'Nanotech',
  'Nexpoint',
  'NexGen Bpo',
  'Reedemar',
  'Techvated',
  'Zupax Marketing',
  'Unified System',
  'Win bpo',
  'Sellerz',
  'Tauras Technology',
  'Winnerz limited',
  'Alternative',
  'INB',
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
  // Populated from live deal_tracker data (canonicalized) on mount; falls back
  // to the preset list if the fetch fails. See the effect below.
  const [availableCallCenters, setAvailableCallCenters] = useState<string[]>(() =>
    PRESET_CALL_CENTERS.slice().sort((a, b) => a.localeCompare(b)),
  )
  // Multi-select: empty array means "All Call Centers". One selected center
  // enables per-center draft save/load (drafts are stored per call center).
  const [selectedCenters, setSelectedCenters] = useState<string[]>([])
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null)
  const [showWeekScript, setShowWeekScript] = useState(false)
  const [weekScriptRowsFromDrafts, setWeekScriptRowsFromDrafts] = useState<Array<{ callCenter: string; payment: number }>>([])
  const [weekScriptLoading, setWeekScriptLoading] = useState(false)
  /** When false, To is always start + 13 days (14-day slab). When true, To is editable. */
  const [customEndDate, setCustomEndDate] = useState(false)
  const [unpaidPreviousSlabBlocked, setUnpaidPreviousSlabBlocked] = useState<UnpaidPreviousSlabCallCenter[]>([])
  const [checkingUnpaidPreviousSlab, setCheckingUnpaidPreviousSlab] = useState(false)
  const [unpaidPreviousSlabCheckError, setUnpaidPreviousSlabCheckError] = useState<string | null>(null)
  const [auditLine, setAuditLine] = useState<BpoInvoiceLine | null>(null)
  const [mergePickFrom, setMergePickFrom] = useState('')
  const [mergePickTo, setMergePickTo] = useState('')
  const [mergePickLoading, setMergePickLoading] = useState(false)
  const [centerNavLoading, setCenterNavLoading] = useState(false)
  const [mergePickError, setMergePickError] = useState<string | null>(null)
  const [mergingCallCenter, setMergingCallCenter] = useState<string | null>(null)
  const [mergePreview, setMergePreview] = useState<{
    callCenter: string
    slabs: Array<{ rangeLabel: string; salesLines: BpoInvoiceLine[]; chargebackLines: BpoInvoiceLine[] }>
    allSalesLines: BpoInvoiceLine[]
    allChargebackLines: BpoInvoiceLine[]
    newBusinessTotal: number
    chargebacksTotal: number
    subtotal: number
  } | null>(null)
  const [mergePreviewPrevNeg, setMergePreviewPrevNeg] = useState('0')
  const [auditDetails, setAuditDetails] = useState<AuditDetails | null>(null)
  const [auditAllLines, setAuditAllLines] = useState<BpoInvoiceLine[]>([])
  const auditFetchRef = useRef(0)

  useEffect(() => {
    if (!auditLine) { setAuditDetails(null); return }
    const seq = ++auditFetchRef.current
    setAuditDetails({ loading: true, commHistory: [], invHistory: [] })
    const candidates = policyLookupCandidates(auditLine.policyNumber)
    ;(async () => {
      const [commRes, histRes] = await Promise.all([
        supabase.from('commission_tracker')
          .select('date, advance_amount, charge_back_amount, carrier')
          .in('policy_number', candidates)
          .order('date', { ascending: false })
          .limit(50),
        supabase.from('invoicing_status_history')
          .select('invoicing_status, effective_date, week_of, lead_value')
          .in('policy_number', candidates)
          .order('effective_date', { ascending: false })
          .limit(30),
      ])
      if (seq !== auditFetchRef.current) return
      setAuditDetails({
        loading: false,
        commHistory: (commRes.data || []) as AuditCommRow[],
        invHistory: (histRes.data || []) as AuditInvHistRow[],
      })
    })().catch(() => {
      if (seq !== auditFetchRef.current) return
      setAuditDetails((p) => p ? { ...p, loading: false } : null)
    })
  }, [auditLine, supabase])

  const openAudit = (line: BpoInvoiceLine, groupLines: BpoInvoiceLine[]) => {
    setAuditLine(line)
    setAuditAllLines(groupLines)
  }

  const auditLineIdx = auditAllLines.findIndex((l) => l.id === auditLine?.id)

  const goAudit = (dir: 1 | -1) => {
    const next = auditAllLines[auditLineIdx + dir]
    if (next) setAuditLine(next)
  }

  useEffect(() => {
    if (!auditLine) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); goAudit(1) }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); goAudit(-1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const invoiceCallCenterFilter =
    selectedCenters.length === 0 ? PRESET_ALL_CALL_CENTERS_FILTER : selectedCenters

  const generateInvoiceBlocked =
    unpaidPreviousSlabBlocked.length > 0 || !!unpaidPreviousSlabCheckError

  // Block invoice generation when the immediately previous slab is not marked paid.
  useEffect(() => {
    if (!dateFrom) {
      setUnpaidPreviousSlabBlocked([])
      setUnpaidPreviousSlabCheckError(null)
      return
    }
    let cancelled = false
    const run = async () => {
      setCheckingUnpaidPreviousSlab(true)
      setUnpaidPreviousSlabCheckError(null)
      try {
        const blocked = await getCallCentersWithUnpaidPreviousSlab({
          startDate: dateFrom,
          callCenterFilter: invoiceCallCenterFilter,
        })
        if (!cancelled) setUnpaidPreviousSlabBlocked(blocked)
      } catch (error: unknown) {
        if (!cancelled) {
          setUnpaidPreviousSlabBlocked([])
          setUnpaidPreviousSlabCheckError(
            error instanceof Error ? error.message : 'Failed to check previous slab payment status.',
          )
        }
      } finally {
        if (!cancelled) setCheckingUnpaidPreviousSlab(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [dateFrom, invoiceCallCenterFilter])

  // Load call-center options from live deal_tracker data, collapsing variant
  // spellings to their canonical name (handles the "different versions" problem).
  // Unmapped centers normalize to themselves, so new ones still appear.
  useEffect(() => {
    let cancelled = false
    const loadCallCenters = async () => {
      try {
        const rows: { call_center: string | null }[] = []
        for (let from = 0; ; from += 1000) {
          const { data, error } = await supabase
            .from('deal_tracker')
            .select('call_center')
            .order('created_at', { ascending: false })
            .range(from, from + 999)
          if (error) throw error
          rows.push(...((data as { call_center: string | null }[]) || []))
          if (!data || data.length < 1000) break
        }
        if (cancelled) return
        const canonical = new Set<string>()
        for (const r of rows) {
          const raw = String(r.call_center ?? '').trim()
          if (!raw) continue
          canonical.add(normalizeCallCenterName(raw))
        }
        if (canonical.size > 0) {
          setAvailableCallCenters(Array.from(canonical).sort((a, b) => a.localeCompare(b)))
        }
      } catch {
        // Keep the preset fallback already in state.
      }
    }
    void loadCallCenters()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    if (customEndDate || !dateFrom) return
    const nextFrom = addDays(dateFrom, direction * INVOICE_SLAB_DAYS)
    if (!nextFrom) return
    applySlabFrom(nextFrom)
  }

  const setCustomEndDateMode = (enabled: boolean) => {
    setCustomEndDate(enabled)
    if (!enabled && dateFrom) {
      applySlabFrom(dateFrom)
    }
  }

  const generateInvoice = async (callCenterFilter?: string | string[] | null) => {
    if (!dateFrom || !dateTo) {
      alert('Please select both From and To dates.')
      return
    }
    if (new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
      alert('From date must be before or equal to To date.')
      return
    }

    try {
      const blockedCenters = await getCallCentersWithUnpaidPreviousSlab({
        startDate: dateFrom,
        callCenterFilter,
      })
      if (blockedCenters.length > 0) {
        const details = blockedCenters
          .map(
            (entry) =>
              `${entry.callCenter}: mark the previous slab (${entry.previousRangeLabel}) as paid first`,
          )
          .join('\n')
        alert(
          `Cannot generate invoice. The previous slab invoice is not paid for the following call center(s):\n\n${details}`,
        )
        return
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to validate previous slab payment status.'
      alert(message)
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
    if (selectedCenters.length !== 1) {
      alert('Please select exactly one call center. Drafts are saved per slab per call center.')
      return
    }
    const center = selectedCenters[0]
    if (!draft || !bpoDetail) {
      alert('Generate invoice first, then move it to draft.')
      return
    }
    const payload: InvoiceDraftSnapshot = {
      dateFrom,
      dateTo,
      selectedCallCenter: center,
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
        callCenterFilter: center,
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
    if (selectedCenters.length !== 1) {
      alert('Please select exactly one call center to load its draft.')
      return
    }
    const center = selectedCenters[0]
    if (!dateFrom || !dateTo) {
      alert('Select invoice date range first to load server draft.')
      return
    }
    try {
      const record = await loadInvoiceDraftSnapshot({
        startDate: dateFrom,
        endDate: dateTo,
        callCenterFilter: center,
      })
      if (!record?.payload) {
        alert('No saved draft found for this cycle/call center.')
        return
      }
      const saved = record.payload
      setDateFrom(saved.dateFrom || dateFrom)
      setDateTo(saved.dateTo || dateTo)
      setSelectedCenters(saved.selectedCallCenter ? [saved.selectedCallCenter] : [])
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

  const currentCenterIndex = useMemo(() => {
    if (selectedCenters.length !== 1) return -1
    return availableCallCenters.indexOf(selectedCenters[0])
  }, [selectedCenters, availableCallCenters])

  const navigateCenter = async (direction: 'prev' | 'next') => {
    if (currentCenterIndex === -1 || !dateFrom || !dateTo) return
    const total = availableCallCenters.length
    if (total === 0) return
    const targetIndex = direction === 'next'
      ? (currentCenterIndex + 1) % total
      : (currentCenterIndex - 1 + total) % total
    const newCenter = availableCallCenters[targetIndex]

    setCenterNavLoading(true)
    try {
      const record = await loadInvoiceDraftSnapshot({
        startDate: dateFrom,
        endDate: dateTo,
        callCenterFilter: newCenter,
      })
      if (record?.payload) {
        const saved = record.payload
        setSelectedCenters([newCenter])
        setDateFrom(saved.dateFrom || dateFrom)
        setDateTo(saved.dateTo || dateTo)
        setDraft(saved.draft)
        setBpoDetail(saved.bpoDetail)
        setPreviousChargebackByCallCenter(saved.previousChargebackByCallCenter || {})
        setExcludedPolicyKeys(saved.excludedPolicyKeys || {})
        setExcludedLineIds(saved.excludedLineIds || {})
        setLineEdits(saved.lineEdits || {})
        setPdfExportedByCenter(saved.pdfExportedByCenter || {})
        setDraftSavedAt(record.updated_at || saved.savedAt || null)
      }
    } catch {
      // Silent — stay on current center
    } finally {
      setCenterNavLoading(false)
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

      const leadValueByPolicyKey: Record<string, number> = {}
      if (visibleBpoDetail) {
        for (const g of visibleBpoDetail.groups) {
          for (const line of [...g.salesLines, ...g.chargebackLines]) {
            const key = resolvePolicyKey(g.callCenter, line.policyNumber)
            if (!key) continue
            leadValueByPolicyKey[key] = round2((leadValueByPolicyKey[key] ?? 0) + line.leadValue)
          }
        }
      }

      const { batchId } = await markInvoiceBatchPaid({
        startDate: visibleDraft.startDate,
        endDate: visibleDraft.endDate,
        groups: visibleDraft.groups,
        overridesByPolicyKey: {},
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
        leadValueByPolicyKey,
      })
      alert(`Invoice batch marked as paid. Batch ID: ${batchId}`)
      // Keep draft and saved snapshot on screen so users can review or re-export; do not clear.
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
      const leadValueByPolicyKey: Record<string, number> = {}
      const bpoGroup = visibleBpoDetail?.groups.find((g) => g.callCenter === callCenter)
      if (bpoGroup) {
        for (const line of [...bpoGroup.salesLines, ...bpoGroup.chargebackLines]) {
          const key = resolvePolicyKey(callCenter, line.policyNumber)
          if (!key) continue
          leadValueByPolicyKey[key] = round2((leadValueByPolicyKey[key] ?? 0) + line.leadValue)
        }
      }
      const { batchId } = await markInvoiceBatchPaid({
        startDate: visibleDraft.startDate,
        endDate: visibleDraft.endDate,
        groups: [group],
        overridesByPolicyKey: {},
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
        leadValueByPolicyKey,
      })
      alert(`${callCenter} marked as paid. Batch ID: ${batchId}`)
      // Keep draft and saved snapshot; do not remove groups or clear server draft.
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

  const loadAndMergeSecondSlab = async () => {
    if (!mergingCallCenter || !mergePickFrom || !mergePickTo) return
    setMergePickLoading(true)
    setMergePickError(null)

    // Slab 1: the currently loaded visibleBpoDetail group for this call center
    const currentGroup = visibleBpoDetail?.groups.find(
      (g) => normalizeCallCenterName(g.callCenter) === normalizeCallCenterName(mergingCallCenter) ||
             g.callCenter.toLowerCase() === mergingCallCenter.toLowerCase(),
    )
    if (!currentGroup) {
      setMergePickError('Current loaded draft has no data for this call center.')
      setMergePickLoading(false)
      return
    }

    try {
      // Slab 2: load from invoicing_drafts — match same call center and date range
      const { data, error } = await supabase
        .from('invoicing_drafts')
        .select('payload, updated_at')
        .eq('start_date', mergePickFrom)
        .eq('end_date', mergePickTo)
        .eq('call_center_filter', mergingCallCenter)
        .is('locked_at', null)
        .is('paid_batch_id', null)
        .order('updated_at', { ascending: false })
        .limit(1)
      if (error) throw new Error(error.message)
      if (!data || data.length === 0) {
        throw new Error(`No saved draft for "${mergingCallCenter}" in ${mergePickFrom} → ${mergePickTo}. Save a draft for that period first.`)
      }
      const snap = (data[0] as { payload: InvoiceDraftSnapshot }).payload
      if (!snap?.bpoDetail) throw new Error('Draft has no invoice data.')

      // Apply exclusions / edits from the second draft
      const pkMap = new Map<string, string>()
      for (const dg of snap.draft?.groups || []) {
        for (const p of dg.policies || []) {
          pkMap.set(`${dg.callCenter}::${p.policyNumber}`, p.policyKey)
          const norm = normalizePolicyNumberForMatch(p.policyNumber)
          if (norm && norm !== p.policyNumber) pkMap.set(`${dg.callCenter}::${norm}`, p.policyKey)
        }
      }
      const resolveKey2 = (cc: string, pn: string) => {
        const direct = pkMap.get(`${cc}::${pn}`)
        if (direct) return direct
        const norm = normalizePolicyNumberForMatch(pn)
        return norm ? pkMap.get(`${cc}::${norm}`) : undefined
      }
      const excPolicies2 = snap.excludedPolicyKeys || {}
      const excLines2 = snap.excludedLineIds || {}
      const edits2 = snap.lineEdits || {}
      const applyEdit2 = (line: BpoInvoiceLine): BpoInvoiceLine => {
        const edit = edits2[line.id]
        return edit ? { ...line, ...edit } : line
      }

      const normCC = normalizeCallCenterName(mergingCallCenter).toLowerCase()
      const secondGroup = snap.bpoDetail.groups.find(
        (g) =>
          normalizeCallCenterName(g.callCenter).toLowerCase() === normCC ||
          g.callCenter.toLowerCase() === mergingCallCenter.toLowerCase(),
      )
      if (!secondGroup) {
        const available = snap.bpoDetail.groups.map((g) => g.callCenter).join(', ')
        throw new Error(`"${mergingCallCenter}" not in the second draft. Available: ${available || 'none'}`)
      }

      const slab2Sales = secondGroup.salesLines
        .filter((l) => {
          if (excLines2[l.id]) return false
          const key = resolveKey2(secondGroup.callCenter, l.policyNumber)
          return !key || !excPolicies2[key]
        })
        .map(applyEdit2)
      const slab2Chargebacks = secondGroup.chargebackLines
        .filter((l) => {
          if (excLines2[l.id]) return false
          const key = resolveKey2(secondGroup.callCenter, l.policyNumber)
          return !key || !excPolicies2[key]
        })
        .map(applyEdit2)

      const slab1Label = visibleBpoDetail?.rangeLabel ?? dateFrom
      const slab2Label = snap.bpoDetail.rangeLabel

      const allSalesLines = [...currentGroup.salesLines, ...slab2Sales]
      const allChargebackLines = [...currentGroup.chargebackLines, ...slab2Chargebacks]
      const newBusinessTotal = round2(allSalesLines.reduce((s, l) => s + l.leadValue, 0))
      const chargebacksTotal = round2(allChargebackLines.reduce((s, l) => s + l.leadValue, 0))

      setMergePreview({
        callCenter: mergingCallCenter,
        slabs: [
          { rangeLabel: slab1Label, salesLines: currentGroup.salesLines, chargebackLines: currentGroup.chargebackLines },
          { rangeLabel: slab2Label, salesLines: slab2Sales, chargebackLines: slab2Chargebacks },
        ],
        allSalesLines,
        allChargebackLines,
        newBusinessTotal,
        chargebacksTotal,
        subtotal: round2(newBusinessTotal + chargebacksTotal),
      })
      setMergingCallCenter(null)
    } catch (err: unknown) {
      setMergePickError(err instanceof Error ? err.message : 'Failed to load draft.')
    } finally {
      setMergePickLoading(false)
    }
  }

  const exportMergedPreviewPdf = () => {
    if (!mergePreview) return
    const prev = Number.parseFloat(mergePreviewPrevNeg)
    const prevNeg = Number.isNaN(prev) ? 0 : prev
    const balanceDue = round2(mergePreview.subtotal - prevNeg)
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    const money = (n: number | null | undefined) => (n == null ? '—' : `$${formatMoney(n)}`)
    const buildRows = (lines: BpoInvoiceLine[]) =>
      lines.map((line) => `<tr>
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
      </tr>`).join('')
    const salesRows = mergePreview.slabs.map((slab) => buildRows(slab.salesLines)).join('')
    const chargeRows = mergePreview.slabs.map((slab) => buildRows(slab.chargebackLines)).join('')
    const firstStart = mergePreview.slabs[0].rangeLabel.split(' – ')[0] ?? ''
    const lastEnd = mergePreview.slabs[mergePreview.slabs.length - 1].rangeLabel.split(' – ')[1] ?? ''
    const combinedRange = `${esc(firstStart)} – ${esc(lastEnd)}`
    const html = `<!doctype html><html><head><meta charset="utf-8"/>
    <title>${esc(mergePreview.callCenter)} — Combined Invoice</title>
    <style>
      :root{--bg:#020922;--panel:#071638;--text:#e5ecff;--muted:#9fb2de;--line:#1f376f;--sales:#00c2b2;--chargebacks:#ff5a1f;--summary:#2f3f76}
      body{font-family:Arial,sans-serif;margin:18px;color:var(--text);background:var(--bg);-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .hw{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:linear-gradient(180deg,#071c47 0%,#051433 100%)}
      h1{margin:0;font-size:20px;color:#fff}.sub{margin:4px 0 0;color:var(--muted);font-size:12px}
      .st{margin:16px 0 0;color:#fff;font-size:13px;font-weight:700;padding:7px 10px;border-radius:6px 6px 0 0}
      .st.s{background:var(--sales)}.st.c{background:var(--chargebacks)}
      table{width:100%;border-collapse:collapse;font-size:10px;margin-bottom:10px;table-layout:fixed}
      th,td{border:1px solid var(--line);padding:6px 7px;text-align:left}
      thead th{background:#0a204f;color:#cfe0ff;font-size:10px;text-transform:uppercase}
      tbody td{background:var(--panel)}
      .sum{width:360px;margin-left:auto;border-collapse:collapse}
      .sum td{border:1px solid var(--line);padding:8px;background:var(--panel)}
      .sum td:first-child{background:var(--summary);font-weight:600}
      @page{size:A4 landscape;margin:8mm}
    </style></head><body>
    <div class="hw"><h1>${esc(mergePreview.callCenter)}</h1><div class="sub">Combined Invoice — ${combinedRange}</div></div>
    <div class="st s">Sales</div>
    <table><thead><tr><th>Name</th><th>Lead value (50%)</th><th>Carrier</th><th>Product</th><th>Agent</th><th>Draft Date</th><th>Monthly Premium</th><th>Coverage</th><th>Com%</th><th>Type</th></tr></thead>
    <tbody>${salesRows || '<tr><td colspan="10">No sales.</td></tr>'}</tbody></table>
    <div class="st c">Chargebacks</div>
    <table><thead><tr><th>Name</th><th>Lead value (50%)</th><th>Carrier</th><th>Product</th><th>Agent</th><th>Draft Date</th><th>Monthly Premium</th><th>Coverage</th><th>Com%</th><th>Type</th></tr></thead>
    <tbody>${chargeRows || '<tr><td colspan="10">No chargebacks.</td></tr>'}</tbody></table>
    <table class="sum"><tbody>
      <tr><td>New Business Total</td><td style="text-align:right;">${money(mergePreview.newBusinessTotal)}</td></tr>
      <tr><td>Chargebacks Total</td><td style="text-align:right;">${money(mergePreview.chargebacksTotal)}</td></tr>
      <tr><td>Negative Balance (Prior)</td><td style="text-align:right;">-${money(Math.abs(prevNeg))}</td></tr>
      <tr><td>Balance Due</td><td style="text-align:right;">${money(balanceDue)}</td></tr>
    </tbody></table>
    </body></html>`
    const w = window.open('', '_blank')
    if (w) { w.document.open(); w.document.write(html); w.document.close(); setTimeout(() => { w.focus(); w.print() }, 250) }
    else window.alert('Popup blocked. Please allow popups.')
  }


  return (
    <div className="admin-page space-y-6 print:space-y-4">
      {/* Policy audit popup */}
      <Dialog open={auditLine != null} onOpenChange={(open) => { if (!open) setAuditLine(null) }}>
        <DialogContent hideClose className="flex max-h-[90vh] max-w-3xl flex-col gap-0 overflow-hidden p-0">
          {auditLine && (() => {
            const { headline, isChargeback } = auditStatusMeta(auditLine.invoicingStatus)
            const grossAmt = Math.abs(auditLine.leadValue) * 2
            const isStageSource = auditLine.id.startsWith('stage-cb-') || auditLine.id.startsWith('stage-repay-') || auditLine.id.startsWith('cp-deal-')
            const refDate = bpoDetail?.endDate ?? dateTo
            const monthsActv = auditLine.effectiveDate ? auditMonthsActive(auditLine.effectiveDate, refDate) : null
            const remaining = monthsActv !== null ? Math.max(0, 9 - monthsActv) : null
            const dealValue = auditLine.dealValue ?? null
            const ccValue = dealValue != null ? dealValue / 2 : null
            const monthlyCC = ccValue != null ? ccValue / 9 : null
            const totalLines = auditAllLines.length
            const pos = auditLineIdx >= 0 ? auditLineIdx + 1 : null

            const FR = (label: string, value: React.ReactNode) => (
              <div className="flex items-start justify-between gap-3 py-[3px] text-xs">
                <span className="shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
                <span className="text-right font-medium text-slate-800 dark:text-slate-200">{value}</span>
              </div>
            )

            const SH = (title: string) => (
              <p className="mb-1.5 text-[9px] font-extrabold uppercase tracking-[0.14em] text-slate-400 dark:text-slate-500">{title}</p>
            )

            const Divider = () => <div className="my-3 border-t border-slate-100 dark:border-slate-800" />

            const HistTable = ({ loading, empty, children }: { loading?: boolean; empty?: boolean; children?: React.ReactNode }) =>
              loading ? (
                <div className="flex items-center gap-1.5 py-1 text-xs text-slate-400"><Loader2 className="h-3 w-3 animate-spin" />Loading…</div>
              ) : empty ? (
                <p className="py-0.5 text-xs italic text-slate-400">None found.</p>
              ) : (
                <div className="overflow-hidden rounded border border-slate-200 dark:border-slate-700">{children}</div>
              )

            return (
              <>
                <DialogTitle className="sr-only">Policy Audit — {auditLine.policyNumber}</DialogTitle>
                {/* ── Single header bar: title + nav + close ── */}
                <div className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-950">
                  <ClipboardList className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">Policy Audit</span>
                    <span className="ml-2 font-mono text-xs text-slate-500 dark:text-slate-400">{auditLine.policyNumber}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {pos !== null && totalLines > 1 && (
                      <span className="mr-1 text-xs tabular-nums text-slate-400">{pos} / {totalLines}</span>
                    )}
                    <button type="button" disabled={auditLineIdx <= 0} onClick={() => goAudit(-1)} title="← Previous"
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-25 dark:border-slate-700 dark:hover:bg-slate-800">
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </button>
                    <button type="button" disabled={auditLineIdx < 0 || auditLineIdx >= totalLines - 1} onClick={() => goAudit(1)} title="→ Next"
                      className="flex h-7 w-7 items-center justify-center rounded border border-slate-200 text-slate-500 hover:bg-slate-100 disabled:opacity-25 dark:border-slate-700 dark:hover:bg-slate-800">
                      <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                    <DialogClose className="ml-1 flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                      <span className="text-base leading-none">×</span>
                    </DialogClose>
                  </div>
                </div>

                {/* ── Coloured status strip ── */}
                <div className={cn(
                  'flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2',
                  isChargeback
                    ? 'border-orange-200 bg-orange-50 dark:border-orange-900/40 dark:bg-orange-950/20'
                    : 'border-teal-200 bg-teal-50 dark:border-teal-900/40 dark:bg-teal-950/20',
                )}>
                  <span className={cn('text-xs font-bold', isChargeback ? 'text-orange-800 dark:text-orange-300' : 'text-teal-800 dark:text-teal-300')}>
                    {headline}
                  </span>
                  <div className="flex items-center gap-1.5 text-xs font-semibold tabular-nums">
                    <span className={cn('rounded px-2 py-0.5',
                      isChargeback ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300' : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300')}>
                      Gross {isChargeback ? '-' : '+'}${formatMoney(grossAmt)}
                    </span>
                    <span className={cn('rounded px-2 py-0.5',
                      isChargeback ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300' : 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300')}>
                      Lead {isChargeback ? '-' : '+'}${formatMoney(Math.abs(auditLine.leadValue))}
                    </span>
                  </div>
                </div>

                {/* ── Two-column body: left=facts, right=history ── */}
                <div className="flex min-h-0 flex-1 overflow-hidden">

                  {/* Left panel — policy facts, this entry, 9-month */}
                  <div className="flex w-[42%] shrink-0 flex-col overflow-y-auto border-r border-slate-100 p-4 dark:border-slate-800">
                    {SH('Policy Info')}
                    {FR('Insured', auditLine.insuredName)}
                    {FR('Carrier', auditLine.carrier)}
                    {FR('Agent', auditLine.agentAccount)}
                    {FR('Effective', <span className="font-mono">{auditLine.effectiveDate || '—'}</span>)}
                    {auditLine.ghlStage && FR('GHL Stage',
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] leading-tight dark:bg-slate-800">{auditLine.ghlStage}</span>
                    )}
                    {auditLine.monthlyPremium != null && FR('Premium', <span className="font-mono">${formatMoney(auditLine.monthlyPremium)}/mo</span>)}
                    {auditLine.coverageAmount != null && FR('Coverage', <span className="font-mono">${formatMoney(auditLine.coverageAmount)}</span>)}
                    {FR('Com %', auditLine.comPct || '—')}
                    {FR('Com type', auditLine.comType)}

                    <Divider />
                    {SH('This Entry')}
                    {FR('Source', <span className="text-slate-500 dark:text-slate-400 text-[11px]">{auditSourceLabel(auditLine.id).split(' (')[0]}</span>)}
                    {FR(isChargeback ? 'CB date' : 'Comm date', <span className="font-mono">{auditLine.draftDate}</span>)}
                    {FR('Gross', <span className={cn('font-mono font-semibold', isChargeback ? 'text-rose-600 dark:text-rose-400' : 'text-teal-600 dark:text-teal-400')}>{isChargeback ? '-' : '+'}${formatMoney(grossAmt)}</span>)}
                    {FR('Lead (50%)', <span className={cn('font-mono font-semibold', isChargeback ? 'text-rose-600 dark:text-rose-400' : 'text-teal-600 dark:text-teal-400')}>{isChargeback ? '-' : '+'}${formatMoney(Math.abs(auditLine.leadValue))}</span>)}

                    {isStageSource && dealValue != null && dealValue > 0 && ccValue != null && monthlyCC != null && (
                      <>
                        <Divider />
                        {SH('9-Month Rule')}
                        <div className="rounded border border-blue-200/60 bg-blue-50/40 px-3 py-2 dark:border-blue-900/30 dark:bg-blue-950/15">
                          {FR('Deal value', <span className="font-mono">${formatMoney(dealValue)}</span>)}
                          {FR('CC (50%)', <span className="font-mono">${formatMoney(ccValue)}</span>)}
                          {FR('Monthly ÷9', <span className="font-mono">${formatMoney(monthlyCC)}</span>)}
                          {FR('Ref date', <span className="font-mono">{refDate || '—'}</span>)}
                          {monthsActv !== null && FR('Months active', <span className="font-mono">{monthsActv} mo</span>)}
                          {remaining !== null && FR('Remaining',
                            <span className={cn('font-mono font-bold', remaining > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-slate-400')}>{remaining} mo</span>
                          )}
                          {remaining !== null && FR(
                            isChargeback ? 'Chargeback' : 'Repay',
                            <span className={cn('font-mono font-bold', isChargeback ? 'text-rose-600 dark:text-rose-400' : 'text-teal-600 dark:text-teal-400')}>
                              {isChargeback ? '-' : '+'}${formatMoney(monthlyCC * remaining)}
                            </span>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Right panel — histories */}
                  <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-4">
                    {SH('Invoice Cycle History')}
                    <HistTable loading={auditDetails?.loading} empty={!auditDetails?.invHistory.length}>
                      {auditDetails?.invHistory.length ? (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/60">
                              <th className="px-2 py-1.5 text-left font-semibold text-slate-500">Period</th>
                              <th className="px-2 py-1.5 text-left font-semibold text-slate-500">Status</th>
                              <th className="px-2 py-1.5 text-right font-semibold text-slate-500">Lead</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {auditDetails.invHistory.map((row, i) => {
                              const isCb = row.invoicing_status === 'New Charge Back' || row.invoicing_status === 'rechargeback'
                              return (
                                <tr key={i} className="hover:bg-slate-50/50">
                                  <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-slate-400">{row.week_of || row.effective_date}</td>
                                  <td className="px-2 py-1.5">
                                    <span className={cn('rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                                      isCb ? 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400'
                                        : 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400')}>
                                      {formatInvoicingStatusLabel(row.invoicing_status as InvoicingStatus)}
                                    </span>
                                  </td>
                                  <td className={cn('px-2 py-1.5 text-right font-mono font-semibold tabular-nums',
                                    isCb ? 'text-rose-600 dark:text-rose-400' : 'text-teal-600 dark:text-teal-400')}>
                                    {row.lead_value != null ? `${isCb ? '-' : '+'}$${formatMoney(Math.abs(row.lead_value))}` : '—'}
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      ) : null}
                    </HistTable>

                    <Divider />

                    {SH('Commission Statement History')}
                    <HistTable loading={auditDetails?.loading} empty={!auditDetails?.commHistory.length}>
                      {auditDetails?.commHistory.length ? (
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-900/60">
                              <th className="px-2 py-1.5 text-left font-semibold text-slate-500">Date</th>
                              <th className="px-2 py-1.5 text-right font-semibold text-slate-500">Advance</th>
                              <th className="px-2 py-1.5 text-right font-semibold text-slate-500">Chargeback</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {auditDetails.commHistory.map((row, i) => (
                              <tr key={i} className="hover:bg-slate-50/50">
                                <td className="px-2 py-1.5 font-mono text-slate-600 dark:text-slate-400">{row.date}</td>
                                <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums text-teal-600 dark:text-teal-400">
                                  {row.advance_amount && row.advance_amount > 0 ? `+$${formatMoney(row.advance_amount)}` : <span className="text-slate-300 dark:text-slate-700">—</span>}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                                  {row.charge_back_amount && row.charge_back_amount !== 0 ? `-$${formatMoney(Math.abs(row.charge_back_amount))}` : <span className="text-slate-300 dark:text-slate-700">—</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : null}
                    </HistTable>
                  </div>

                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

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
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 bg-slate-50/80 px-3 py-2 dark:border-slate-700 dark:bg-slate-900/40">
            <Checkbox
              id="invoicing-custom-end"
              checked={customEndDate}
              onCheckedChange={(checked) => setCustomEndDateMode(Boolean(checked))}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <Label htmlFor="invoicing-custom-end" className="cursor-pointer text-sm font-medium">
                Custom end date
              </Label>
              <span className="text-xs text-muted-foreground">
                {customEndDate
                  ? 'Choose any end date on or after the start date. Slab shortcuts are disabled.'
                  : 'End date is fixed at 14 days from the start date; use Prev / Next Slab to move the window.'}
              </span>
            </div>
          </div>
          {checkingUnpaidPreviousSlab && dateFrom ? (
            <p className="text-xs text-muted-foreground">Checking previous slab payment status…</p>
          ) : null}
          {unpaidPreviousSlabCheckError ? (
            <div
              role="alert"
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"
            >
              Could not verify previous slab payment: {unpaidPreviousSlabCheckError}
            </div>
          ) : null}
          {unpaidPreviousSlabBlocked.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
            >
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 space-y-1.5">
                  <p className="font-semibold text-amber-900 dark:text-amber-50">
                    Previous invoice cycle is not paid — new invoice generation is disabled
                  </p>
                  <p className="text-xs text-amber-900/90 dark:text-amber-100/90">
                    Mark the previous 14-day slab as paid (or settle its draft) before starting this cycle.
                  </p>
                  <ul className="list-disc space-y-0.5 pl-4 text-xs">
                    {unpaidPreviousSlabBlocked.map((entry) => (
                      <li key={entry.callCenter}>
                        <span className="font-medium">{entry.callCenter}</span>
                        {' — previous slab '}
                        <span className="font-mono">{entry.previousRangeLabel}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    const v = e.target.value
                    if (customEndDate) {
                      setDateFrom(v)
                    } else {
                      applySlabFrom(v)
                    }
                  }}
                  className="h-9 w-[180px]"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input
                  type="date"
                  value={dateTo}
                  readOnly={!customEndDate}
                  onChange={(e) => {
                    if (customEndDate) setDateTo(e.target.value)
                  }}
                  className={cn('h-9 w-[180px]', !customEndDate && 'opacity-80')}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={() => shiftSlab(-1)} disabled={customEndDate || !dateFrom}>
                Prev Slab
              </Button>
              <Button type="button" variant="outline" onClick={() => shiftSlab(1)} disabled={customEndDate || !dateFrom}>
                Next Slab
              </Button>
            </div>
            <Button
              onClick={() => void generateInvoice(invoiceCallCenterFilter)}
              disabled={
                loading ||
                checkingUnpaidPreviousSlab ||
                !dateFrom ||
                !dateTo ||
                generateInvoiceBlocked
              }
              title={
                generateInvoiceBlocked
                  ? 'Mark the previous slab invoice as paid before generating a new cycle'
                  : undefined
              }
              className="bg-orange-500 text-black hover:bg-orange-400 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : checkingUnpaidPreviousSlab ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Checking…
                </>
              ) : (
                'Generate Invoice'
              )}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Call Center</span>
            <MultiSelectFilter
              label="call center"
              allLabel="All Call Centers"
              options={availableCallCenters}
              selected={selectedCenters}
              onChange={setSelectedCenters}
            />
            {selectedCenters.length === 1 && (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigateCenter('prev')}
                  disabled={centerNavLoading}
                  className="h-8 px-2 text-xs"
                >
                  {centerNavLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronLeft className="h-3.5 w-3.5" />}
                  Prev
                </Button>
                <span className="min-w-[40px] text-center text-xs text-muted-foreground">
                  {currentCenterIndex + 1}/{availableCallCenters.length}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigateCenter('next')}
                  disabled={centerNavLoading}
                  className="h-8 px-2 text-xs"
                >
                  Next
                  {centerNavLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3.5 w-3.5" />}
                </Button>
              </div>
            )}
            <Button size="sm" variant="outline" onClick={() => void saveDraftLocally()} disabled={selectedCenters.length !== 1}>
              Move to Draft
            </Button>
            <Button size="sm" variant="outline" onClick={() => void loadDraftLocally()} disabled={selectedCenters.length !== 1}>
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

      {/* ── Pick second slab dialog ───────────────────────────────────────────── */}
      <Dialog open={mergingCallCenter !== null} onOpenChange={(open) => { if (!open) { setMergingCallCenter(null); setMergePickError(null) } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Merge with another slab</DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground">
            Merging <span className="font-medium text-foreground">{mergingCallCenter}</span> with a second saved draft.
            Pick the date range of the draft you want to merge in.
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted-foreground">From</span>
              <Input
                type="date"
                value={mergePickFrom}
                onChange={(e) => {
                  const from = e.target.value
                  setMergePickFrom(from)
                  if (from) setMergePickTo(addDays(from, INVOICE_SLAB_DAYS - 1))
                  setMergePickError(null)
                }}
                className="h-8 flex-1"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="w-8 shrink-0 text-xs text-muted-foreground">To</span>
              <Input
                type="date"
                value={mergePickTo}
                onChange={(e) => setMergePickTo(e.target.value)}
                className="h-8 flex-1"
              />
            </div>
          </div>
          {mergePickError && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300">
              {mergePickError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="outline" onClick={() => { setMergingCallCenter(null); setMergePickError(null) }}>Cancel</Button>
            <Button size="sm" onClick={() => void loadAndMergeSecondSlab()} disabled={mergePickLoading || !mergePickFrom || !mergePickTo} className="bg-orange-500 text-black hover:bg-orange-400">
              {mergePickLoading ? <><Loader2 className="mr-1 h-3 w-3 animate-spin" />Loading…</> : 'Load & Merge'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Merged invoice preview dialog ────────────────────────────────────── */}
      <Dialog open={mergePreview !== null} onOpenChange={(open) => { if (!open) { setMergePreview(null); setMergePreviewPrevNeg('0') } }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          {mergePreview && (() => {
            const prevParsed = Number.parseFloat(mergePreviewPrevNeg)
            const prevNeg = Number.isNaN(prevParsed) ? 0 : prevParsed
            const balanceDue = round2(mergePreview.subtotal - prevNeg)
            return (
              <>
                <DialogHeader>
                  <DialogTitle className="flex items-center justify-between gap-3">
                    <span>{mergePreview.callCenter} — Combined Invoice</span>
                    <Button size="sm" className="bg-orange-500 text-black hover:bg-orange-400 print:hidden" onClick={exportMergedPreviewPdf}>
                      Export PDF
                    </Button>
                  </DialogTitle>
                </DialogHeader>
                <p className="text-xs text-muted-foreground">
                  {mergePreview.slabs[0].rangeLabel.split(' – ')[0]} – {mergePreview.slabs[mergePreview.slabs.length - 1].rangeLabel.split(' – ')[1]}
                </p>

                {/* Sales */}
                <div>
                  <p className="mb-1 rounded-t bg-teal-600 px-3 py-1.5 text-xs font-bold text-white">
                    Sales — {mergePreview.allSalesLines.length} line{mergePreview.allSalesLines.length !== 1 ? 's' : ''}
                  </p>
                  <div className="overflow-x-auto rounded-b border border-slate-200 dark:border-slate-700">
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-900">
                          {['Name', 'Lead Value (50%)', 'Carrier', 'Product', 'Agent', 'Draft Date'].map((h) => (
                            <th key={h} className={invoiceTableHead}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {mergePreview.allSalesLines.length === 0 ? (
                          <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">No sales</td></tr>
                        ) : mergePreview.slabs.map((slab) =>
                          slab.salesLines.map((line, li) => (
                            <tr key={`s-${slab.rangeLabel}-${li}`} className="border-b border-slate-100 dark:border-slate-800">
                              <td className={invoiceCell}>{line.insuredName}</td>
                              <td className={cn(invoiceCell, 'text-right tabular-nums text-emerald-700 dark:text-emerald-400')}>${formatMoney(line.leadValue)}</td>
                              <td className={invoiceCell}>{line.carrier}</td>
                              <td className={invoiceCell}>{line.product ?? '—'}</td>
                              <td className={invoiceCell}>{line.agentAccount}</td>
                              <td className={invoiceCell}>{line.draftDate}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Chargebacks */}
                <div>
                  <p className="mb-1 rounded-t bg-orange-500 px-3 py-1.5 text-xs font-bold text-white">
                    Chargebacks — {mergePreview.allChargebackLines.length} line{mergePreview.allChargebackLines.length !== 1 ? 's' : ''}
                  </p>
                  <div className="overflow-x-auto rounded-b border border-slate-200 dark:border-slate-700">
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-900">
                          {['Name', 'Lead Value (50%)', 'Carrier', 'Product', 'Agent', 'Draft Date'].map((h) => (
                            <th key={h} className={invoiceTableHead}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {mergePreview.allChargebackLines.length === 0 ? (
                          <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">No chargebacks</td></tr>
                        ) : mergePreview.slabs.map((slab) =>
                          slab.chargebackLines.map((line, li) => (
                            <tr key={`cb-${slab.rangeLabel}-${li}`} className="border-b border-slate-100 dark:border-slate-800">
                              <td className={invoiceCell}>{line.insuredName}</td>
                              <td className={cn(invoiceCell, 'text-right tabular-nums text-rose-600 dark:text-rose-400')}>${formatMoney(line.leadValue)}</td>
                              <td className={invoiceCell}>{line.carrier}</td>
                              <td className={invoiceCell}>{line.product ?? '—'}</td>
                              <td className={invoiceCell}>{line.agentAccount}</td>
                              <td className={invoiceCell}>{line.draftDate}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Summary */}
                <div className="flex flex-col items-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
                  <div className="flex w-full max-w-xs flex-col gap-1.5 text-xs">
                    <div className="flex justify-between rounded bg-emerald-50 px-3 py-2 dark:bg-emerald-950/40">
                      <span className="text-slate-600">New Business Total</span>
                      <span className="font-semibold tabular-nums text-emerald-700 dark:text-emerald-300">${formatMoney(mergePreview.newBusinessTotal)}</span>
                    </div>
                    <div className="flex justify-between rounded bg-rose-50 px-3 py-2 dark:bg-rose-950/40">
                      <span className="text-slate-600">Chargebacks Total</span>
                      <span className="font-semibold tabular-nums text-rose-700 dark:text-rose-400">${formatMoney(mergePreview.chargebacksTotal)}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded border border-slate-200 px-3 py-2 dark:border-slate-700">
                      <span className="text-slate-500">Prior negative balance</span>
                      <Input type="number" value={mergePreviewPrevNeg} onChange={(e) => setMergePreviewPrevNeg(e.target.value)} className="h-7 w-[90px] text-right font-mono text-xs" placeholder="0.00" />
                    </div>
                    <div className="flex justify-between rounded bg-slate-900 px-3 py-2.5 text-white dark:bg-black">
                      <span className="font-medium">Balance Due</span>
                      <span className="text-sm font-bold tabular-nums">${formatMoney(balanceDue)}</span>
                    </div>
                  </div>
                </div>
              </>
            )
          })()}
        </DialogContent>
      </Dialog>

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
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setMergingCallCenter(group.callCenter); setMergePickFrom(''); setMergePickTo(''); setMergePickError(null) }}
                >
                  Merge Slab
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
                              <div className="flex items-center gap-1">
                                <Input
                                  value={line.policyNumber}
                                  onChange={(e) => updateLineField(line.id, 'policyNumber', e.target.value)}
                                  className="h-8 min-w-[120px]"
                                />
                                <button
                                  type="button"
                                  title="View audit details"
                                  onClick={() => openAudit(line, [...group.salesLines, ...group.chargebackLines])}
                                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-teal-50 hover:text-teal-600 dark:hover:bg-teal-950 dark:hover:text-teal-400"
                                >
                                  <ClipboardList className="h-3.5 w-3.5" />
                                </button>
                              </div>
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
                              <div className="flex items-center gap-1">
                                <Input
                                  value={line.policyNumber}
                                  onChange={(e) => updateLineField(line.id, 'policyNumber', e.target.value)}
                                  className="h-8 min-w-[120px]"
                                />
                                <button
                                  type="button"
                                  title="View audit details"
                                  onClick={() => openAudit(line, [...group.salesLines, ...group.chargebackLines])}
                                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-orange-50 hover:text-orange-600 dark:hover:bg-orange-950 dark:hover:text-orange-400"
                                >
                                  <ClipboardList className="h-3.5 w-3.5" />
                                </button>
                              </div>
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