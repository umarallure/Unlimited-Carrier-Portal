'use client'

import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import * as XLSX from 'xlsx'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Calendar, Loader2, Search, Trash2 } from 'lucide-react'
import { Plus } from 'lucide-react'
import { MultiSelectFilter } from '@/components/filters/MultiSelectFilter'
import { type AgencyCarrierOption } from '@/components/DealTrackerPolicyDialog'
import { CommissionTransactionDialog, type CommissionTransactionForm } from '@/components/CommissionTransactionDialog'
import {
  ActiveFilterChips,
  FilterBarHeader,
} from '@/components/filters/SmartFilters'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminDateInput,
  adminExpandRowBg,
  adminInputSm,
  adminNestedTableShell,
  adminOutlineBtn,
  adminPaginationShell,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'

type CommissionRow = {
  id?: string
  agency_carrier_id: string
  carrier_id: string | null
  carrier: string
  policy_number: string
  name: string | null
  sales_agent: string | null
  date: string
  commission_rate: number | null
  advance_amount: number | null
  charge_back_amount: number | null
  version_history?: any[]
  source_table?: string | null
}

type CarrierRecord = {
  id: string
  name: string
  code: string | null
}

function policyGroupKey(row: { agency_carrier_id: string; policy_number: string }) {
  return `${row.agency_carrier_id}::${row.policy_number}`
}

function normalizePolicyNumber(value: string | null | undefined): string {
  return String(value ?? '').trim()
}

function normalizeCommissionDate(value: string | null | undefined): string {
  const str = String(value ?? '').trim()
  if (!str) return ''
  const raw = str.split('to')[0].trim()
  const ymd = raw.match(/^(\d{4}-\d{2}-\d{2})/)
  if (ymd) return ymd[1]
  const us = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|[\sT].*)?$/)
  if (us) {
    const mm = String(parseInt(us[1], 10)).padStart(2, '0')
    const dd = String(parseInt(us[2], 10)).padStart(2, '0')
    return `${us[3]}-${mm}-${dd}`
  }
  return raw
}

function netCommissionAmount(row: Pick<CommissionRow, 'advance_amount' | 'charge_back_amount'>): number {
  const adv =
    typeof row.advance_amount === 'number'
      ? row.advance_amount
      : Number.parseFloat(String(row.advance_amount ?? '0').replace(/,/g, ''))
  if (!Number.isNaN(adv) && adv !== 0) return Math.round(adv * 100) / 100
  const cb =
    typeof row.charge_back_amount === 'number'
      ? row.charge_back_amount
      : Number.parseFloat(String(row.charge_back_amount ?? '0').replace(/,/g, ''))
  if (!Number.isNaN(cb) && cb !== 0) return Math.round(cb * 100) / 100
  return 0
}

function commissionTransactionKey(row: CommissionRow): string {
  return `${row.agency_carrier_id}::${normalizePolicyNumber(row.policy_number)}::${normalizeCommissionDate(row.date)}::${netCommissionAmount(row).toFixed(2)}`
}

export default function CommissionReportPage() {
  const inlineEditInput = 'h-9 min-w-[110px] px-2 text-sm'
  const inlineEditInputWide = 'h-9 min-w-[150px] px-2 text-sm'
  const inlineEditInputNarrow = 'h-9 min-w-[90px] px-2 text-sm'

  const [rows, setRows] = useState<CommissionRow[]>([])
  const [allRows, setAllRows] = useState<CommissionRow[]>([])
  const [rawRows, setRawRows] = useState<CommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [carrierCode, setCarrierCode] = useState<string[]>([])
  const [agentFilter, setAgentFilter] = useState<string[]>([])
  const [agencyFilter, setAgencyFilter] = useState<string[]>([])
  const [agencyByAcId, setAgencyByAcId] = useState<Map<string, string>>(new Map())
  const [agencyOptions, setAgencyOptions] = useState<string[]>([])
  const [sourceFilter, setSourceFilter] = useState<string>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [filterDate, setFilterDate] = useState('')
  const [carrierCodeById, setCarrierCodeById] = useState<Map<string, string | null>>(new Map())
  const [carrierCodeByName, setCarrierCodeByName] = useState<Map<string, string | null>>(new Map())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [agencyCarrierOptions, setAgencyCarrierOptions] = useState<AgencyCarrierOption[]>([])
  const [commissionDialogOpen, setCommissionDialogOpen] = useState(false)
  const [commissionDialogMode, setCommissionDialogMode] = useState<'create' | 'edit'>('create')
  const [commissionDraft, setCommissionDraft] = useState<Partial<CommissionTransactionForm>>({})
  const [savingCommission, setSavingCommission] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [savingInlineEdits, setSavingInlineEdits] = useState(false)
  const [draftByTransactionId, setDraftByTransactionId] = useState<Record<string, any>>({})
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState(false)
  const [selectedTxIds, setSelectedTxIds] = useState<Set<string>>(new Set())
  const [deletingTx, setDeletingTx] = useState(false)

  const fetchAllCommissionRows = async () => {
    setLoading(true)
    try {
        const PAGE_SIZE = 1000
        let all: CommissionRow[] = []
        let from = 0

        while (true) {
          const to = from + PAGE_SIZE - 1
          const { data, error } = await supabase
            .from('commission_tracker')
            .select('*')
            .order('date', { ascending: false })
            .range(from, to)

          if (error) {
            console.error('Error loading commission report:', error)
            all = []
            break
          }

          const chunk = (data || []) as CommissionRow[]
          all = all.concat(chunk)

          if (chunk.length < PAGE_SIZE) {
            break
          }

          from = to + 1
        }

        // Keep a raw copy of all transaction rows for export (no dedupe).
        setRawRows(all)

        const dedupedTransactions = new Map<string, CommissionRow>()
        for (const row of all) {
          const net = netCommissionAmount(row)
          if (net === 0) continue
          const key = commissionTransactionKey(row)
          const existing = dedupedTransactions.get(key)
          if (!existing) {
            dedupedTransactions.set(key, row)
            continue
          }
          const rowId = String(row.id ?? '')
          const existingId = String(existing.id ?? '')
          if (rowId > existingId) {
            dedupedTransactions.set(key, row)
          }
        }

        const cleanedAll = Array.from(dedupedTransactions.values())

        // Keep all normalized commission_tracker rows so we can:
        // - Aggregate per policy for the main table (sum advance/chargeback),
        // - And still show every individual transaction when a row is expanded.
        setAllRows(cleanedAll)

        // Collapse to one display row per (agency_carrier, policy)
        // and pick the "best" header row (prefer non-empty name/agent, then latest date).
        const byKey = new Map<string, CommissionRow>()
        const parseDate = (d: string): number => {
          const dt = new Date(String(d).split('to')[0].trim().replace(/\./g, '-').replace(/\//g, '-'))
          return isNaN(dt.getTime()) ? 0 : dt.getTime()
        }
        const qualityScore = (r: CommissionRow): number => {
          let score = 0
          if (r.name && String(r.name).trim() && String(r.name).trim() !== '-') score += 2
          if (r.sales_agent && String(r.sales_agent).trim() && String(r.sales_agent).trim() !== '-') score += 1
          if (r.commission_rate != null) score += 1
          return score
        }
        for (const row of cleanedAll) {
          const key = policyGroupKey(row)
          const existing = byKey.get(key)
          if (!existing) {
            byKey.set(key, row)
            continue
          }
          const rowScore = qualityScore(row)
          const existingScore = qualityScore(existing)
          if (
            rowScore > existingScore ||
            (rowScore === existingScore && parseDate(row.date) > parseDate(existing.date))
          ) {
            byKey.set(key, row)
          }
        }

        setRows(Array.from(byKey.values()))

        // Fetch carrier codes once for mapping name/id -> code
        const { data: carriers, error: carriersError } = await supabase
          .from('carriers')
          .select('id, name, code')

        if (!carriersError && carriers) {
          const typedCarriers = carriers as CarrierRecord[]
          const byId = new Map<string, string | null>()
          const byName = new Map<string, string | null>()
          typedCarriers.forEach((c) => {
            byId.set(c.id, c.code)
            byName.set(c.name, c.code)
          })
          setCarrierCodeById(byId)
          setCarrierCodeByName(byName)
        }
      const { data: agencyCarrierRows } = await supabase
        .from('agency_carriers')
        .select(`
          id,
          carrier_id,
          agencies ( name ),
          carriers ( id, name )
        `)
        .order('created_at', { ascending: true })

      const options: AgencyCarrierOption[] = (agencyCarrierRows || []).map((row: any) => ({
        id: row.id,
        agencyName: row.agencies?.name || 'Unknown agency',
        carrierName: row.carriers?.name || 'Unknown carrier',
        carrierId: row.carriers?.id || row.carrier_id || null,
      }))
      setAgencyCarrierOptions(options)

      const acAgencyMap = new Map<string, string>()
      const agencyNameSet = new Set<string>()
      for (const row of (agencyCarrierRows || [])) {
        const name = (row as any).agencies?.name
        if (name) {
          acAgencyMap.set(row.id, name)
          agencyNameSet.add(name)
        }
      }
      setAgencyByAcId(acAgencyMap)
      setAgencyOptions(Array.from(agencyNameSet).sort())
    } catch (err) {
      console.error('Error loading commission report:', err)
      setRows([])
      setAllRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchAllCommissionRows()
  }, [])

  const sourcesByPolicyKey = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of allRows) {
      const k = policyGroupKey(r)
      if (!m.has(k)) m.set(k, new Set())
      const st = r.source_table
      if (st) m.get(k)!.add(st)
    }
    return m
  }, [allRows])

  const uniqueSources = useMemo(() => {
    const s = new Set<string>()
    for (const r of allRows) {
      if (r.source_table) s.add(r.source_table)
    }
    return Array.from(s).sort()
  }, [allRows])

  const carrierCodeOptions = useMemo(() => {
    const names = new Set<string>()
    for (const r of allRows) {
      const name = r.carrier?.trim()
      if (name) names.add(name)
    }
    return Array.from(names).sort()
  }, [allRows])

  const agentOptions = useMemo(() => {
    const agents = new Set<string>()
    for (const r of allRows) {
      const a = r.sales_agent?.trim()
      if (a) agents.add(a)
    }
    return Array.from(agents).sort()
  }, [allRows])

  const normalizeDate = (value: any): Date | null => {
    if (!value) return null
    // NOTE: We now display the raw YYYY-MM-DD string in the UI to avoid
    // timezone shifting, but still use Date objects internally only for
    // comparisons and sorting.
    const str = String(value).trim()
    if (!str) return null
    const rangePart = str.split('to')[0].trim()
    const ymd = rangePart.match(/^(\d{4})-(\d{2})-(\d{2})/)
    if (ymd) {
      return new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]))
    }
    const us = rangePart.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|[\sT].*)?$/)
    if (us) {
      return new Date(Number(us[3]), Number(us[1]) - 1, Number(us[2]))
    }
    const parsed = new Date(rangePart.includes('T') ? rangePart : `${rangePart}T12:00:00`)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const filtered = rows.filter(row => {
    const name = row.name ?? ''
    const policy = row.policy_number ?? ''
    const salesAgent = row.sales_agent ?? ''

    if (filterDate && row.date !== filterDate) return false

    if (carrierCode.length > 0 && !carrierCode.includes(row.carrier?.trim() ?? '')) return false
    if (agentFilter.length > 0 && !agentFilter.includes(row.sales_agent?.trim() ?? '')) return false
    if (agencyFilter.length > 0) {
      const rowAgency = agencyByAcId.get(row.agency_carrier_id)
      if (!rowAgency || !agencyFilter.includes(rowAgency)) return false
    }

    if (sourceFilter !== 'all') {
      const set = sourcesByPolicyKey.get(policyGroupKey(row))
      if (!set || !set.has(sourceFilter)) return false
    }

    if (!searchTerm) return true
    const q = searchTerm.trim()
    if (q.includes(',')) {
      const policies = q.split(',').map(s => s.trim()).filter(Boolean)
      if (policies.length > 0) return policies.includes(row.policy_number)
    }
    const lc = q.toLowerCase()
    return (
      String(name).toLowerCase().includes(lc) ||
      String(policy).toLowerCase().includes(lc) ||
      String(salesAgent).toLowerCase().includes(lc)
    )
  })

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1)
    setExpandedKey(null)
  }, [carrierCode, agentFilter, agencyFilter, sourceFilter, searchTerm, filterDate])

  const filteredStats = useMemo(() => {
    const policyKeys = new Set(filtered.map((r) => policyGroupKey(r)))
    let totalAdvance = 0
    let totalChargeback = 0
    for (const r of allRows) {
      if (!policyKeys.has(policyGroupKey(r))) continue
      totalAdvance += r.advance_amount ?? 0
      totalChargeback += r.charge_back_amount ?? 0
    }
    return { totalAdvance, totalChargeback, net: totalAdvance + totalChargeback }
  }, [filtered, allRows])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginated = filtered.slice(startIndex, endIndex)

  const exportExcel = () => {
    if (!filtered.length) return
    const policyKeys = new Set(filtered.map((r) => policyGroupKey(r)))
    const transactionHeaders = [
      'ID',
      'Agency Carrier ID',
      'Policy Number',
      'Name',
      'Carrier',
      'Sales Agent',
      'Date',
      'Commission Rate',
      'Advance Amount',
      'Charge Back Amount',
      'Source Table',
    ]
    const transactionRows = rawRows
      .filter((r) => policyKeys.has(policyGroupKey(r)))
      .sort((a, b) => {
        const ad = normalizeDate(a.date)?.getTime() ?? 0
        const bd = normalizeDate(b.date)?.getTime() ?? 0
        return bd - ad
      })
      .map((r) => [
        r.id ?? '',
        r.agency_carrier_id ?? '',
        r.policy_number ?? '',
        r.name ?? '',
        r.carrier ?? '',
        r.sales_agent ?? '',
        r.date ?? '',
        r.commission_rate ?? '',
        r.advance_amount ?? '',
        r.charge_back_amount ?? '',
        r.source_table ?? '',
      ])
    const transactionsWs = XLSX.utils.aoa_to_sheet([transactionHeaders, ...transactionRows])
    transactionsWs['!cols'] = [
      { wch: 36 }, { wch: 36 }, { wch: 16 }, { wch: 24 }, { wch: 20 },
      { wch: 20 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 20 },
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, transactionsWs, 'All Transactions')
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `commission-tracker-${today}.xlsx`)
  }

  const filterActiveCount = useMemo(() => {
    let n = 0
    if (searchTerm.trim()) n++
    if (carrierCode.length > 0) n++
    if (agentFilter.length > 0) n++
    if (agencyFilter.length > 0) n++
    if (sourceFilter !== 'all') n++
    if (filterDate) n++
    return n
  }, [searchTerm, carrierCode, agentFilter, sourceFilter, filterDate])

  const activeChips = useMemo(() => {
    const items: { key: string; label: string; onRemove: () => void }[] = []
    if (searchTerm.trim())
      items.push({
        key: 'q',
        label: `Search: ${searchTerm.trim()}`,
        onRemove: () => setSearchTerm(''),
      })
    if (carrierCode.length > 0)
      items.push({
        key: 'car',
        label: `Carrier: ${carrierCode.join(', ')}`,
        onRemove: () => setCarrierCode([]),
      })
    if (agentFilter.length > 0)
      items.push({
        key: 'agent',
        label: `Agent: ${agentFilter.join(', ')}`,
        onRemove: () => setAgentFilter([]),
      })
    if (agencyFilter.length > 0)
      items.push({
        key: 'agency',
        label: `Agency: ${agencyFilter.join(', ')}`,
        onRemove: () => setAgencyFilter([]),
      })
    if (sourceFilter !== 'all')
      items.push({
        key: 'src',
        label: `Source: ${sourceFilter}`,
        onRemove: () => setSourceFilter('all'),
      })
    if (filterDate)
      items.push({
        key: 'd',
        label: `Date: ${filterDate}`,
        onRemove: () => setFilterDate(''),
      })
    return items
  }, [searchTerm, carrierCode, agentFilter, agencyFilter, sourceFilter, filterDate])

  const clearAllFilters = () => {
    setSearchTerm('')
    setCarrierCode([])
    setAgentFilter([])
    setAgencyFilter([])
    setSourceFilter('all')
    setFilterDate('')
  }

  const openCreateCommissionDialog = () => {
    setCommissionDialogMode('create')
    setCommissionDraft({})
    setCommissionDialogOpen(true)
  }

  const startInlineEdit = () => {
    const next: Record<string, any> = {}
    const policyKeys = new Set(filtered.map((row) => policyGroupKey(row)))
    allRows.forEach((tx) => {
      if (!tx.id) return
      if (!policyKeys.has(policyGroupKey(tx))) return
      next[String(tx.id)] = {
        name: tx.name ?? '',
        date: tx.date ?? '',
        policy_number: tx.policy_number ?? '',
        carrier: tx.carrier ?? '',
        sales_agent: tx.sales_agent ?? '',
        commission_rate: tx.commission_rate != null ? String(tx.commission_rate) : '',
        advance_amount: tx.advance_amount != null ? String(tx.advance_amount) : '',
        charge_back_amount: tx.charge_back_amount != null ? String(tx.charge_back_amount) : '',
      }
    })
    setDraftByTransactionId(next)
    setEditMode(true)
  }

  const cancelInlineEdit = () => {
    setEditMode(false)
    setDraftByTransactionId({})
  }

  const updateDraft = (txId: string, field: string, value: string) => {
    setDraftByTransactionId((prev) => ({
      ...prev,
      [txId]: { ...(prev[txId] || {}), [field]: value },
    }))
  }

  const saveInlineEdits = async () => {
    setSavingInlineEdits(true)
    try {
      for (const [txId, draft] of Object.entries(draftByTransactionId)) {
        if (!txId || !draft) continue
        const payload = {
          name: String(draft.name ?? '').trim() || null,
          date: String(draft.date ?? '').trim() || null,
          policy_number: String(draft.policy_number ?? '').trim(),
          carrier: String(draft.carrier ?? '').trim(),
          sales_agent: String(draft.sales_agent ?? '').trim() || null,
          commission_rate:
            String(draft.commission_rate ?? '').trim() === '' ? null : Number.parseFloat(String(draft.commission_rate)),
          advance_amount:
            String(draft.advance_amount ?? '').trim() === '' ? null : Number.parseFloat(String(draft.advance_amount)),
          charge_back_amount:
            String(draft.charge_back_amount ?? '').trim() === '' ? null : Number.parseFloat(String(draft.charge_back_amount)),
          updated_at: new Date().toISOString(),
        }
        const { error } = await supabase.from('commission_tracker').update(payload).eq('id', txId)
        if (error) throw error
      }
      await fetchAllCommissionRows()
      setEditMode(false)
      setDraftByTransactionId({})
    } catch (error: any) {
      alert(error?.message || 'Failed to save commission edits.')
    } finally {
      setSavingInlineEdits(false)
    }
  }

  const deleteSelected = async () => {
    if (selectedKeys.size === 0) return
    const count = selectedKeys.size
    const confirmed = confirm(`Delete ${count} commission entr${count === 1 ? 'y' : 'ies'}? This cannot be undone.`)
    if (!confirmed) return

    setDeleting(true)
    try {
      const idsToDelete: string[] = []
      for (const key of selectedKeys) {
        const [agencyCarrierId, policyNumber] = key.split('::')
        const txRows = allRows.filter(
          (r) => r.agency_carrier_id === agencyCarrierId && r.policy_number === policyNumber
        )
        for (const tx of txRows) {
          if (tx.id) idsToDelete.push(tx.id)
        }
      }
      if (idsToDelete.length === 0) return

      const { error } = await supabase
        .from('commission_tracker')
        .delete()
        .in('id', idsToDelete)

      if (error) throw error

      setSelectedKeys(new Set())
      await fetchAllCommissionRows()
    } catch (error: any) {
      alert(error?.message || 'Failed to delete commission entries.')
    } finally {
      setDeleting(false)
    }
  }

  const deleteSelectedTransactions = async () => {
    const ids = Array.from(selectedTxIds).filter(Boolean)
    if (ids.length === 0) return
    const confirmed = confirm(`Delete ${ids.length} individual commission transaction${ids.length === 1 ? '' : 's'}? This cannot be undone.`)
    if (!confirmed) return

    setDeletingTx(true)
    try {
      const { error } = await supabase
        .from('commission_tracker')
        .delete()
        .in('id', ids)
      if (error) throw error
      setSelectedTxIds(new Set())
      await fetchAllCommissionRows()
    } catch (error: any) {
      alert(error?.message || 'Failed to delete commission transactions.')
    } finally {
      setDeletingTx(false)
    }
  }

  const handleSaveCommission = async (form: CommissionTransactionForm) => {
    const selected = agencyCarrierOptions.find((o) => o.id === form.agency_carrier_id)
    if (!selected) {
      alert('Please select a valid agency + carrier.')
      return
    }

    const parseNum = (v: string) => {
      const t = v.trim()
      if (t === '') return null
      const n = Number.parseFloat(t)
      return Number.isNaN(n) ? null : n
    }

    const now = new Date().toISOString()
    const payload = {
      agency_carrier_id: form.agency_carrier_id,
      carrier_id: selected.carrierId,
      carrier: selected.carrierName,
      policy_number: form.policy_number.trim(),
      name: form.name.trim() || null,
      sales_agent: form.sales_agent.trim() || null,
      date: form.date,
      commission_rate: parseNum(form.commission_rate),
      advance_amount: parseNum(form.advance_amount),
      charge_back_amount: parseNum(form.charge_back_amount),
      source_table: 'manual',
      source_row_id: null,
      source_file_id: null,
      updated_at: now,
    }

    setSavingCommission(true)
    try {
      if (commissionDialogMode === 'edit' && form.id) {
        const { error } = await supabase
          .from('commission_tracker')
          .update(payload)
          .eq('id', form.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('commission_tracker')
          .insert({ ...payload, created_at: now })
        if (error) throw error
      }
      setCommissionDialogOpen(false)
      await fetchAllCommissionRows()
    } catch (error: any) {
      alert(error?.message || 'Failed to save commission.')
    } finally {
      setSavingCommission(false)
    }
  }

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Commission Report"
        description="Read-only view of normalized commission rows from all carriers, formatted like your Excel report."
        icon={<span className="text-xl font-bold text-orange-400">$</span>}
      />

      <Card>
        <CardHeader className={`space-y-3 pb-5 ${adminCardHeaderBar}`}>
          <FilterBarHeader
            title="Find commissions"
            description="Search any policy, narrow by carrier and data source, or jump to a common date range. Filters apply to one row per policy (transactions stay grouped)."
            activeCount={filterActiveCount}
            onClearAll={filterActiveCount ? clearAllFilters : undefined}
          />
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1 max-w-md">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
              <Input
                placeholder="Name, policy #, sales agent…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={cn(adminInputSm, 'pl-8')}
              />
            </div>

            <MultiSelectFilter
              label="Carrier"
              options={carrierCodeOptions}
              selected={carrierCode}
              onChange={setCarrierCode}
              allLabel="All carriers"
              triggerClassName="w-[min(100%,220px)]"
            />

            <MultiSelectFilter
              label="Agent"
              options={agentOptions}
              selected={agentFilter}
              onChange={setAgentFilter}
              allLabel="All agents"
              triggerClassName="w-[min(100%,200px)]"
            />

            <MultiSelectFilter
              label="Agency"
              options={agencyOptions}
              selected={agencyFilter}
              onChange={setAgencyFilter}
              allLabel="All agencies"
              triggerClassName="w-[min(100%,200px)]"
            />

            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className={cn(adminSelectTrigger, 'h-9 w-[min(100%,220px)] text-sm')}>
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                <SelectItem value="all" className={adminSelectItem}>
                  All sources
                </SelectItem>
                {uniqueSources.map((s) => (
                  <SelectItem key={s} value={s} className={cn(adminSelectItem, 'font-mono text-xs')}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Date</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                <Input
                  type="date"
                  value={filterDate}
                  onChange={(e) => setFilterDate(e.target.value)}
                  className={adminDateInput}
                  title="Filter by exact commission date"
                />
              </div>
            </div>
          </div>

          <ActiveFilterChips items={activeChips} />
        </CardContent>
      </Card>

      {/* Quick stats */}
      {!loading && (
        <div className="grid grid-cols-3 gap-4">
          {[
            {
              label: 'Total Advance',
              value: filteredStats.totalAdvance,
              positive: true,
              color: 'text-teal-600 dark:text-teal-400',
              bg: 'bg-teal-50 dark:bg-teal-950/20 border-teal-200 dark:border-teal-900/40',
            },
            {
              label: 'Total Chargeback',
              value: filteredStats.totalChargeback,
              positive: false,
              color: 'text-rose-600 dark:text-rose-400',
              bg: 'bg-rose-50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40',
            },
            {
              label: 'Net',
              value: filteredStats.net,
              positive: filteredStats.net >= 0,
              color: filteredStats.net >= 0 ? 'text-teal-600 dark:text-teal-400' : 'text-rose-600 dark:text-rose-400',
              bg: filteredStats.net >= 0
                ? 'bg-teal-50 dark:bg-teal-950/20 border-teal-200 dark:border-teal-900/40'
                : 'bg-rose-50 dark:bg-rose-950/20 border-rose-200 dark:border-rose-900/40',
            },
          ].map(({ label, value, color, bg }) => {
            const abs = Math.abs(value)
            const formatted = abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            const sign = value > 0 ? '+' : value < 0 ? '-' : ''
            return (
              <div key={label} className={`rounded-lg border px-5 py-4 ${bg}`}>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</p>
                <p className={`text-2xl font-bold tabular-nums ${color}`}>{sign}${formatted}</p>
              </div>
            )
          })}
        </div>
      )}

      <Card>
        <CardHeader className={cn('flex flex-row items-center justify-between pb-5', adminCardHeaderBar)}>
          <div className="flex items-center gap-3">
            <CardTitle className={adminCardTitle}>
              Commission report{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({filtered.length} row{filtered.length === 1 ? '' : 's'})
              </span>
            </CardTitle>
            <Button variant="outline" size="sm" onClick={exportExcel} className={adminOutlineBtn}>
              Export Excel
            </Button>
            <Button variant="outline" size="sm" onClick={openCreateCommissionDialog} className={adminOutlineBtn}>
              <Plus className="mr-1 h-4 w-4" />
              Add commission
            </Button>
            {!editMode ? (
              <>
                <Button variant="outline" size="sm" onClick={startInlineEdit} className={adminOutlineBtn}>
                  Edit table
                </Button>
                {selectedKeys.size > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={deleteSelected}
                    disabled={deleting}
                    className="border-red-300 text-red-600 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/30"
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    {deleting ? 'Deleting...' : `Delete (${selectedKeys.size})`}
                  </Button>
                )}
              </>
            ) : (
              <>
                <Button variant="outline" size="sm" onClick={cancelInlineEdit} className={adminOutlineBtn}>
                  Cancel edit
                </Button>
                <Button
                  size="sm"
                  onClick={saveInlineEdits}
                  disabled={savingInlineEdits}
                  className="bg-blue-600 text-white hover:bg-blue-700"
                >
                  {savingInlineEdits ? 'Saving...' : 'Save changes'}
                </Button>
              </>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800">
                  <TableHead className={cn(adminThPlain, 'w-10')}>
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer"
                      checked={selectedKeys.size > 0 && selectedKeys.size === paginated.length}
                      ref={(el) => {
                        if (el) el.indeterminate = selectedKeys.size > 0 && selectedKeys.size < paginated.length
                      }}
                      onChange={() => {
                        if (selectedKeys.size === paginated.length) {
                          setSelectedKeys(new Set())
                        } else {
                          setSelectedKeys(new Set(paginated.map((r) => policyGroupKey(r))))
                        }
                      }}
                    />
                  </TableHead>
                  <TableHead className={adminThPlain}>Name</TableHead>
                  <TableHead className={adminThPlain}>Date</TableHead>
                  <TableHead className={adminThPlain}>Policy Number</TableHead>
                  <TableHead className={adminThPlain}>Carrier</TableHead>
                  <TableHead className={adminThPlain}>Sales Agent</TableHead>
                  <TableHead className={`${adminThPlain} text-right`}>Commission Rate</TableHead>
                  <TableHead className={`${adminThPlain} text-right`}>Advance</TableHead>
                  <TableHead className={`${adminThPlain} text-right`}>Charge Back</TableHead>
                  <TableHead className={`${adminThPlain} text-center`}>Transactions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-orange-400 mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">
                      No commission rows found for the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((row, idx) => {
                    const name = row.name || '-'
                    const policyNumber = row.policy_number || '-'
                    const carrierCodeDisplay =
                      (row.carrier_id && carrierCodeById.get(row.carrier_id)) ??
                      carrierCodeByName.get(row.carrier) ??
                      row.carrier
                    const salesAgent = row.sales_agent || '-'
                    const commissionRate = row.commission_rate

                    const key = policyGroupKey(row)
                    const detailRows = allRows.filter(r =>
                      r.agency_carrier_id === row.agency_carrier_id &&
                      r.policy_number === row.policy_number
                    )

                    const advanceTotal = detailRows.reduce((sum, r) => sum + (r.advance_amount ?? 0), 0)
                    const chargeBackTotal = detailRows.reduce((sum, r) => sum + (r.charge_back_amount ?? 0), 0)
                    const transactionCount = detailRows.length || 1

                    const formatMoney = (v: any) => {
                      if (v == null || v === '') return ''
                      const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
                      if (isNaN(num)) return String(v)
                      return num.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    }

                    return (
                      <Fragment key={row.id || `${policyNumber}-${idx}`}>
                        <TableRow className={adminTableRowInteractive}>
                          <TableCell className={cn(adminTdMuted, 'w-10')}>
                            <input
                              type="checkbox"
                              className="h-4 w-4 cursor-pointer"
                              checked={selectedKeys.has(key)}
                              onChange={() => {
                                const next = new Set(selectedKeys)
                                if (next.has(key)) next.delete(key)
                                else next.add(key)
                                setSelectedKeys(next)
                              }}
                            />
                          </TableCell>
                          <TableCell className={adminTdStrong}>{name}</TableCell>
                          <TableCell className={adminTdMuted}>
                            {row.date || '-'}
                          </TableCell>
                          <TableCell className={`${adminTdMuted} font-mono text-sm`}>
                            {policyNumber}
                          </TableCell>
                          <TableCell className={adminTdMuted}>{carrierCodeDisplay}</TableCell>
                          <TableCell className={adminTdMuted}>{salesAgent}</TableCell>
                          <TableCell className={`${adminTdMuted} text-right`}>
                            {commissionRate != null ? String(commissionRate) : ''}
                          </TableCell>
                          <TableCell className={`${adminTdMuted} text-right`}>
                            {advanceTotal !== 0 ? formatMoney(advanceTotal) : ''}
                          </TableCell>
                          <TableCell className={`${adminTdMuted} text-right`}>
                            {chargeBackTotal !== 0 ? formatMoney(chargeBackTotal) : ''}
                          </TableCell>
                          <TableCell className={`${adminTdMuted} whitespace-nowrap text-center text-sm`}>
                            {transactionCount > 1 || editMode ? (
                              <button
                                type="button"
                                onClick={() => setExpandedKey(prev => (prev === key ? null : key))}
                                className="inline-flex items-center rounded-md px-2 py-1.5 text-orange-600 transition-colors hover:bg-muted hover:text-orange-500 dark:text-orange-400 dark:hover:bg-slate-800 dark:hover:text-orange-300"
                                title="View individual commission transactions for this policy"
                              >
                                <span className="mr-1 font-mono">{transactionCount}</span>
                                <span>{expandedKey === key ? 'Hide' : (editMode ? 'Edit tx' : 'Details')}</span>
                              </button>
                            ) : (
                              <span className="text-muted-foreground">1</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {expandedKey === key && (
                          <TableRow className={adminExpandRowBg}>
                            <TableCell colSpan={10} className="p-0">
                              <div className="border-t border-border px-4 py-3 dark:border-slate-800">
                                <div className="mb-2 flex items-center gap-2">
                                  <span className="text-xs font-semibold text-foreground dark:text-slate-300">
                                    Individual commission transactions for policy {policyNumber}
                                  </span>
                                  {selectedTxIds.size > 0 && (
                                    <button
                                      type="button"
                                      disabled={deletingTx}
                                      onClick={deleteSelectedTransactions}
                                      className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                      {deletingTx ? 'Deleting...' : `Delete (${selectedTxIds.size})`}
                                    </button>
                                  )}
                                </div>
                                <div className={adminNestedTableShell}>
                                  <Table>
                                    <TableHeader>
                                      <TableRow className="border-b border-border dark:border-slate-800">
                                        <TableHead className={cn(adminThPlain, 'w-8 text-xs')}>
                                          {detailRows.some(r => r.id) && (
                                            <input
                                              type="checkbox"
                                              className="h-3.5 w-3.5 cursor-pointer"
                                              checked={
                                                selectedTxIds.size > 0 &&
                                                selectedTxIds.size === detailRows.filter(r => r.id).length
                                              }
                                              ref={(el) => {
                                                if (el) {
                                                  const withIds = detailRows.filter(r => r.id)
                                                  el.indeterminate = selectedTxIds.size > 0 && selectedTxIds.size < withIds.length
                                                }
                                              }}
                                              onChange={() => {
                                                const withIds = detailRows.filter(r => r.id).map(r => String(r.id))
                                                if (withIds.every(id => selectedTxIds.has(id))) {
                                                  setSelectedTxIds(new Set())
                                                } else {
                                                  setSelectedTxIds(new Set(withIds))
                                                }
                                              }}
                                            />
                                          )}
                                        </TableHead>
                                        <TableHead className={`${adminThPlain} text-xs`}>Date</TableHead>
                                        <TableHead className={`${adminThPlain} text-xs`}>Name</TableHead>
                                        <TableHead className={`${adminThPlain} text-xs`}>Sales Agent</TableHead>
                                        <TableHead className={`${adminThPlain} text-right text-xs`}>Commission Rate</TableHead>
                                        <TableHead className={`${adminThPlain} text-right text-xs`}>Advance</TableHead>
                                        <TableHead className={`${adminThPlain} text-right text-xs`}>Charge Back</TableHead>
                                        <TableHead className={`${adminThPlain} text-xs`}>Source</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {detailRows
                                        .slice()
                                        .sort((a, b) => {
                                          const da = normalizeDate(a.date)?.getTime() ?? 0
                                          const db = normalizeDate(b.date)?.getTime() ?? 0
                                          return da - db
                                        })
                                        .map((tx, i) => {
                                          const txId = String(tx.id ?? '')
                                          const txDraft = txId ? draftByTransactionId[txId] : null
                                          return (
                                            <TableRow key={tx.id || `${key}-tx-${i}`} className="border-b border-border/80 dark:border-slate-900/60">
                                              <TableCell className={cn(adminTdMuted, 'w-8 text-xs')}>
                                                {tx.id ? (
                                                  <input
                                                    type="checkbox"
                                                    className="h-3.5 w-3.5 cursor-pointer"
                                                    checked={selectedTxIds.has(txId)}
                                                    onChange={() => {
                                                      const next = new Set(selectedTxIds)
                                                      if (next.has(txId)) next.delete(txId)
                                                      else next.add(txId)
                                                      setSelectedTxIds(next)
                                                    }}
                                                  />
                                                ) : null}
                                              </TableCell>
                                              <TableCell className={`${adminTdMuted} text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.date ?? tx.date ?? ''}
                                                    onChange={(e) => updateDraft(txId, 'date', e.target.value)}
                                                    className={inlineEditInput}
                                                  />
                                                ) : (tx.date || '-')}
                                              </TableCell>
                                              <TableCell className={`${adminTdStrong} text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.name ?? tx.name ?? ''}
                                                    onChange={(e) => updateDraft(txId, 'name', e.target.value)}
                                                    className={inlineEditInputWide}
                                                  />
                                                ) : (tx.name || '-')}
                                              </TableCell>
                                              <TableCell className={`${adminTdMuted} text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.sales_agent ?? tx.sales_agent ?? ''}
                                                    onChange={(e) => updateDraft(txId, 'sales_agent', e.target.value)}
                                                    className={inlineEditInput}
                                                  />
                                                ) : (tx.sales_agent || '-')}
                                              </TableCell>
                                              <TableCell className={`${adminTdMuted} text-right text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.commission_rate ?? (tx.commission_rate != null ? String(tx.commission_rate) : '')}
                                                    onChange={(e) => updateDraft(txId, 'commission_rate', e.target.value)}
                                                    className={inlineEditInputNarrow}
                                                  />
                                                ) : (tx.commission_rate != null ? String(tx.commission_rate) : '')}
                                              </TableCell>
                                              <TableCell className={`${adminTdMuted} text-right text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.advance_amount ?? (tx.advance_amount != null ? String(tx.advance_amount) : '')}
                                                    onChange={(e) => updateDraft(txId, 'advance_amount', e.target.value)}
                                                    className={inlineEditInputNarrow}
                                                  />
                                                ) : (tx.advance_amount != null ? formatMoney(tx.advance_amount) : '')}
                                              </TableCell>
                                              <TableCell className={`${adminTdMuted} text-right text-xs`}>
                                                {editMode && txId ? (
                                                  <Input
                                                    value={txDraft?.charge_back_amount ?? (tx.charge_back_amount != null ? String(tx.charge_back_amount) : '')}
                                                    onChange={(e) => updateDraft(txId, 'charge_back_amount', e.target.value)}
                                                    className={inlineEditInputNarrow}
                                                  />
                                                ) : (tx.charge_back_amount != null ? formatMoney(tx.charge_back_amount) : '')}
                                              </TableCell>
                                              <TableCell className="text-xs text-muted-foreground dark:text-slate-400">
                                                {tx.source_table || ''}
                                              </TableCell>
                                            </TableRow>
                                          )
                                        })}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {filtered.length > 0 && (
        <div className={adminPaginationShell}>
          <div className="text-sm text-muted-foreground">
            Showing {filtered.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filtered.length)} of {filtered.length} rows
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                <SelectTrigger className={cn(adminSelectTrigger, 'h-8 w-24 text-xs')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={adminSelectContent}>
                  <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
                  <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
                  <SelectItem value="100" className={adminSelectItem}>100</SelectItem>
                  <SelectItem value="250" className={adminSelectItem}>250</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className={adminOutlineBtn}
                >
                  First
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className={adminOutlineBtn}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className={adminOutlineBtn}
                >
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className={adminOutlineBtn}
                >
                  Last
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
      {commissionDialogOpen && (
        <CommissionTransactionDialog
          open={commissionDialogOpen}
          onOpenChange={setCommissionDialogOpen}
          saving={savingCommission}
          mode={commissionDialogMode}
          initialValue={commissionDraft}
          agencyCarrierOptions={agencyCarrierOptions}
          onSave={handleSaveCommission}
        />
      )}
    </div>
  )
}

