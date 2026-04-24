'use client'

import { useState, useEffect, useRef } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabaseClient'
import { getDealTrackerEntries, getChangedFieldsFromHistory } from '@/lib/dealTracker'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DealTrackerPolicyDialog, type AgencyCarrierOption, type DealTrackerPolicyForm } from '@/components/DealTrackerPolicyDialog'
import Link from 'next/link'
import { Loader2, Search, RefreshCw, Calendar, History, TrendingUp, Plus } from 'lucide-react'
import {
  CollapsibleFilterSection,
  FilterBarHeader,
  FilterPresetChip,
  QuickDateRangeChips,
} from '@/components/filters/SmartFilters'
import { PageHeader } from '@/components/PageHeader'
import { formatStoredDateForDisplay, toYmdForDateInput } from '@/lib/calendarDate'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminDatePickerInput,
  adminDatePickerRow,
  adminFilterWell,
  adminInput,
  adminOutlineBtn,
  adminPaginationBar,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
  adminTypeTabActive,
  adminTypeTabIdle,
  adminTypeTabsWrap,
} from '@/lib/adminFieldClasses'

export default function DealTrackerPage() {
  const inlineEditInput = 'h-9 min-w-[100px] px-2 text-sm'
  const inlineEditInputWide = 'h-9 min-w-[140px] px-2 text-sm'
  const inlineEditInputNarrow = 'h-9 min-w-[82px] px-2 text-sm'

  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [ghlStageFilter, setGhlStageFilter] = useState<string>('all')
  const [agencyFilter, setAgencyFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [callCenterFilter, setCallCenterFilter] = useState<string>('all')
  const [dateFromFilter, setDateFromFilter] = useState<string>('')
  const [dateToFilter, setDateToFilter] = useState<string>('')
  const [dealValueMin, setDealValueMin] = useState<string>('')
  const [dealValueMax, setDealValueMax] = useState<string>('')
  const [policyStatusUpdatedFilter, setPolicyStatusUpdatedFilter] = useState<string>('all') // 'all' | 'updated' | 'not_updated' | 'changed'
  const [dealValueUpdatedFilter, setDealValueUpdatedFilter] = useState<string>('all') // 'all' | 'updated' | 'not_updated' | 'changed'
  const [showMode, setShowMode] = useState<'all' | 'new' | 'updated' | 'changed'>('all') // tab: All | New | Updated (has history) | Changed (value changed)
  const [agencies, setAgencies] = useState<string[]>([])
  const [carriers, setCarriers] = useState<string[]>([])
  const [agents, setAgents] = useState<string[]>([])
  const [callCenters, setCallCenters] = useState<string[]>([])
  const [statuses, setStatuses] = useState<string[]>([])
  const [ghlStages, setGhlStages] = useState<string[]>([])
  const [carrierStatuses, setCarrierStatuses] = useState<string[]>([])
  const [dealStatuses, setDealStatuses] = useState<string[]>([])
  const [agencyCarrierOptions, setAgencyCarrierOptions] = useState<AgencyCarrierOption[]>([])
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false)
  const [policyDialogMode, setPolicyDialogMode] = useState<'create' | 'edit'>('create')
  const [policyDraft, setPolicyDraft] = useState<Partial<DealTrackerPolicyForm>>({})
  const [savingPolicy, setSavingPolicy] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [savingInlineEdits, setSavingInlineEdits] = useState(false)
  const [draftById, setDraftById] = useState<Record<string, any>>({})
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const dateFromInputRef = useRef<HTMLInputElement>(null)
  const dateToInputRef = useRef<HTMLInputElement>(null)
  const importInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchEntries()
  }, [])

  useEffect(() => {
    setCurrentPage(1) // Reset to page 1 when filters change
  }, [searchTerm, carrierFilter, statusFilter, ghlStageFilter, agencyFilter, agentFilter, callCenterFilter, dateFromFilter, dateToFilter, dealValueMin, dealValueMax, policyStatusUpdatedFilter, dealValueUpdatedFilter, showMode])

  const fetchFilterOptions = async () => {
    try {
      // 1) Get all carriers and agencies from their master tables
      const [{ data: carrierRows }, { data: agencyRows }] = await Promise.all([
        supabase.from('carriers').select('name').order('name'),
        supabase.from('agencies').select('name').order('name'),
      ])

      if (carrierRows) {
        const uniqueCarriers = Array.from(
          new Set((carrierRows as any[]).map((c) => c.name).filter(Boolean))
        ).sort()
        setCarriers(uniqueCarriers as string[])
      }

      if (agencyRows) {
        const uniqueAgencies = Array.from(
          new Set((agencyRows as any[]).map((a) => a.name).filter(Boolean))
        ).sort()
        setAgencies(uniqueAgencies as string[])
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

      // 2) Use deal_tracker rows (paginated helper) to derive agents, call centers, statuses
      const dealRows = await getDealTrackerEntries({
        limit: 20000, // large batch so we see all distinct values in practice
      })

      const uniqueAgents = Array.from(
        new Set(dealRows.map((e: any) => e.sales_agent).filter(Boolean))
      ).sort()
      const uniqueCallCenters = Array.from(
        new Set(dealRows.map((e: any) => e.call_center).filter(Boolean))
      ).sort()
      const uniqueStatuses = Array.from(
        new Set(dealRows.map((e: any) => e.policy_status).filter(Boolean))
      ).sort()
      const uniqueGhlStages = Array.from(
        new Set(dealRows.map((e: any) => e.ghl_stage).filter(Boolean))
      ).sort()
      const uniqueCarrierStatuses = Array.from(
        new Set(dealRows.map((e: any) => e.carrier_status).filter(Boolean))
      ).sort()
      const uniqueDealStatuses = Array.from(
        new Set(dealRows.map((e: any) => e.status).filter(Boolean))
      ).sort()

      setAgents(uniqueAgents as string[])
      setCallCenters(uniqueCallCenters as string[])
      setStatuses(uniqueStatuses as string[])
      setGhlStages(uniqueGhlStages as string[])
      setCarrierStatuses(uniqueCarrierStatuses as string[])
      setDealStatuses(uniqueDealStatuses as string[])
    } catch (error) {
      console.error('Error fetching filter options:', error)
    }
  }

  const fetchEntries = async () => {
    setLoading(true)
    try {
      // Fetch all entries (we'll filter client-side for complex filters)
      const data = await getDealTrackerEntries({
        limit: 20000, // Fetch a large batch for filtering and filter options
      })

      const rows = data || []
      setEntries(rows)
      // Build / refresh filter options whenever we refresh entries
      // so new carriers/agencies/agents appear in the dropdowns.
      fetchFilterOptions()
    } catch (error) {
      console.error('Error fetching entries:', error)
    } finally {
      setLoading(false)
    }
  }

  const hasUpdates = (entry: any) => Array.isArray(entry?.version_history) && entry.version_history.length > 0

  // Parse date filter as local date (avoid UTC midnight issues with type="date" YYYY-MM-DD)
  const parseLocalDate = (dateStr: string): Date | null => {
    if (!dateStr || !String(dateStr).trim()) return null
    const s = String(dateStr)
    const parts = s.includes('-') ? s.split('-') : s.split(/[/]/)
    const y = parseInt(parts[0], 10)
    const m = parseInt(parts[1], 10)
    const d = parseInt(parts[2], 10)
    if (!y || !m || !d || m < 1 || m > 12) return null
    return new Date(y, m - 1, d)
  }

  // Entry matches date range if deal_creation_date, created_at, or any version_history.at falls in [fromStart, toEnd]
  const entryMatchesDateRange = (entry: any, fromStart: Date | null, toEnd: Date | null): boolean => {
    if (!fromStart && !toEnd) return true
    const inRange = (d: Date) => {
      if (!d || isNaN(d.getTime())) return false
      if (fromStart && d < fromStart) return false
      if (toEnd && d > toEnd) return false
      return true
    }
    if (entry.deal_creation_date) {
      const d = new Date(entry.deal_creation_date)
      if (inRange(d)) return true
    }
    if (entry.created_at) {
      const d = new Date(entry.created_at)
      if (inRange(d)) return true
    }
    const vh = Array.isArray(entry?.version_history) ? entry.version_history : []
    for (const v of vh) {
      if (v?.at) {
        const d = new Date(v.at)
        if (inRange(d)) return true
      }
    }
    // Date filter is set but no date on this entry fell in range
    if (fromStart || toEnd) return false
    return true
  }

  const normStr = (v: unknown) => {
    if (v == null) return null
    const s = String(v).trim()
    return s.length ? s : null
  }

  const normNum = (v: unknown) => {
    if (v == null) return null
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    return Number.isFinite(n) ? n : null
  }

  const fieldChangedAcrossHistory = (entry: any, field: string, normalize: (v: unknown) => any) => {
    const vh = Array.isArray(entry?.version_history) ? entry.version_history : []
    if (vh.length === 0) return false

    const values = [
      ...vh.map((snap: any) => normalize(snap?.[field])),
      normalize(entry?.[field]),
    ]

    for (let i = 1; i < values.length; i++) {
      if (values[i] !== values[i - 1]) return true
    }
    return false
  }

  // Base filter (all filters except Show tab)
  const baseFilteredEntries = entries.filter(entry => {
    if (policyStatusUpdatedFilter !== 'all') {
      const updated = hasUpdates(entry)
      const changed = fieldChangedAcrossHistory(entry, 'policy_status', normStr)
      if (policyStatusUpdatedFilter === 'updated' && !updated) return false
      if (policyStatusUpdatedFilter === 'not_updated' && updated) return false
      if (policyStatusUpdatedFilter === 'changed' && !changed) return false
    }
    if (dealValueUpdatedFilter !== 'all') {
      const updated = hasUpdates(entry)
      const changed = fieldChangedAcrossHistory(entry, 'deal_value', normNum)
      if (dealValueUpdatedFilter === 'updated' && !updated) return false
      if (dealValueUpdatedFilter === 'not_updated' && updated) return false
      if (dealValueUpdatedFilter === 'changed' && !changed) return false
    }
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase()
      const matchesSearch = (
        entry.name?.toLowerCase().includes(searchLower) ||
        entry.policy_number?.toLowerCase().includes(searchLower) ||
        entry.sales_agent?.toLowerCase().includes(searchLower) ||
        entry.call_center?.toLowerCase().includes(searchLower) ||
        entry.phone_number?.toLowerCase().includes(searchLower) ||
        entry.writing_number?.toLowerCase().includes(searchLower)
      )
      if (!matchesSearch) return false
    }
    if (carrierFilter !== 'all' && entry.carrier !== carrierFilter) return false
    if (agencyFilter !== 'all') {
      const agencyName = entry.agency_carriers?.agencies?.name
      if (agencyName !== agencyFilter) return false
    }
    if (statusFilter !== 'all' && entry.policy_status !== statusFilter) return false
    if (ghlStageFilter !== 'all' && entry.ghl_stage !== ghlStageFilter) return false
    if (agentFilter !== 'all' && entry.sales_agent !== agentFilter) return false
    if (callCenterFilter !== 'all' && entry.call_center !== callCenterFilter) return false
    const dateFrom = parseLocalDate(dateFromFilter)
    const dateTo = parseLocalDate(dateToFilter)
    const toEnd = dateTo ? (() => { const e = new Date(dateTo); e.setHours(23, 59, 59, 999); return e })() : null
    if (!entryMatchesDateRange(entry, dateFrom, toEnd)) return false
    if (dealValueMin) {
      const minValue = parseFloat(dealValueMin)
      if (isNaN(minValue) || !entry.deal_value || entry.deal_value < minValue) return false
    }
    if (dealValueMax) {
      const maxValue = parseFloat(dealValueMax)
      if (isNaN(maxValue) || !entry.deal_value || entry.deal_value > maxValue) return false
    }
    return true
  })

  const allTabCount = baseFilteredEntries.length
  const newTabCount = baseFilteredEntries.filter((e) => e.isNew).length
  const updatedTabCount = baseFilteredEntries.filter(hasUpdates).length
  const changedTabCount = baseFilteredEntries.filter(e => getChangedFieldsFromHistory(e).length > 0).length

  const filteredEntries =
    showMode === 'new'
      ? baseFilteredEntries.filter((e) => e.isNew)
      : showMode === 'updated'
        ? baseFilteredEntries.filter(hasUpdates)
        : showMode === 'changed'
          ? baseFilteredEntries.filter(e => getChangedFieldsFromHistory(e).length > 0)
          : baseFilteredEntries

  // Pagination
  const totalPages = Math.ceil(filteredEntries.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedEntries = filteredEntries.slice(startIndex, endIndex)

  const exportExcel = () => {
    if (!filteredEntries.length) return
    const headers = [
      'Name',
      'Policy Number',
      'Carrier',
      'Policy Status',
      'GHL Stage',
      'Carrier Status (raw)',
      'Status',
      'Notes',
      'Deal Value',
      'CC Value',
      'Charge Back',
      'Sales Agent',
      'Writing #',
      'Call Center',
      'Phone Number',
      'Deal Creation Date',
      'Effective Date',
      'Change Type', // new | updated | changed | unchanged
      'Row ID',
      'Agency Carrier ID',
    ]
    const rows = filteredEntries.map((e: any) => {
      const hasHistory = hasUpdates(e)
      const changed = getChangedFieldsFromHistory(e).length > 0
      const changeType = e.isNew
        ? 'new'
        : changed
          ? 'changed'
          : hasHistory
            ? 'updated'
            : 'unchanged'
      return [
        e.name ?? '',
        e.policy_number ?? '',
        e.carrier ?? '',
        e.policy_status ?? '',
        e.ghl_stage ?? '',
        e.carrier_status ?? '',
        e.status ?? '',
        e.notes ?? '',
        e.deal_value ?? '',
        e.cc_value ?? '',
        e.charge_back ?? '',
        e.sales_agent ?? '',
        e.writing_number ?? '',
        e.call_center ?? '',
        e.phone_number ?? '',
        e.deal_creation_date ?? '',
        e.effective_date ?? '',
        changeType,
        e.id ?? '',
        e.agency_carrier_id ?? '',
      ]
    })
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = [
      { wch: 24 }, { wch: 16 }, { wch: 18 }, { wch: 22 }, { wch: 24 },
      { wch: 22 }, { wch: 12 }, { wch: 24 }, { wch: 12 }, { wch: 12 },
      { wch: 12 }, { wch: 20 }, { wch: 14 }, { wch: 20 }, { wch: 16 },
      { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 36 }, { wch: 36 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Deal Tracker')
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `deal-tracker-${showMode}-${today}.xlsx`)
  }

  const handleImportClick = () => {
    importInputRef.current?.click()
  }

  const importFromCsv = async (file: File | null) => {
    if (!file) return
    setSavingInlineEdits(true)
    try {
      const text = await file.text()
      const parsed = Papa.parse<Record<string, string>>(text, {
        header: true,
        skipEmptyLines: true,
      })
      const rows = (parsed.data || []).filter((r) => r && (r['Row ID'] || r['Policy Number']))
      if (!rows.length) {
        alert('No valid rows found in CSV.')
        return
      }

      for (const row of rows) {
        const id = (row['Row ID'] || '').trim()
        const payload: Record<string, unknown> = {}

        const str = (v: string | undefined) => {
          const t = (v ?? '').trim()
          return t === '' ? null : t
        }
        const num = (v: string | undefined) => {
          const t = (v ?? '').trim()
          if (!t) return null
          const n = Number.parseFloat(t)
          return Number.isNaN(n) ? null : n
        }

        payload.name = str(row['Name'])
        payload.policy_number = (row['Policy Number'] ?? '').trim()
        payload.carrier = str(row['Carrier'])
        payload.policy_status = str(row['Policy Status'])
        payload.ghl_stage = str(row['GHL Stage'])
        payload.carrier_status = str(row['Carrier Status (raw)'])
        payload.status = str(row['Status'])
        payload.notes = str(row['Notes'])
        payload.deal_value = num(row['Deal Value'])
        payload.cc_value = num(row['CC Value'])
        payload.charge_back = num(row['Charge Back'])
        payload.sales_agent = str(row['Sales Agent'])
        payload.writing_number = str(row['Writing #'])
        payload.call_center = str(row['Call Center'])
        payload.phone_number = str(row['Phone Number'])
        payload.deal_creation_date = str(row['Deal Creation Date'])
        payload.effective_date = str(row['Effective Date'])
        payload.last_updated = new Date().toISOString()
        payload.updated_at = payload.last_updated

        if (id) {
          const { error } = await supabase.from('deal_tracker').update(payload).eq('id', id)
          if (error) throw new Error(error.message)
        } else {
          // Fallback: update by agency + policy number when Row ID missing
          const agencyCarrierId = (row['Agency Carrier ID'] ?? '').trim()
          if (!agencyCarrierId || !payload.policy_number) continue
          const { error } = await supabase
            .from('deal_tracker')
            .update(payload)
            .eq('agency_carrier_id', agencyCarrierId)
            .eq('policy_number', payload.policy_number as string)
          if (error) throw new Error(error.message)
        }
      }

      await fetchEntries()
      alert('Deal Tracker updated from CSV import.')
    } catch (err: any) {
      console.error('CSV import failed', err)
      alert(err?.message || 'Failed to import Deal Tracker CSV.')
    } finally {
      setSavingInlineEdits(false)
      if (importInputRef.current) {
        importInputRef.current.value = ''
      }
    }
  }

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setStatusFilter('all')
    setGhlStageFilter('all')
    setAgencyFilter('all')
    setAgentFilter('all')
    setCallCenterFilter('all')
    setDateFromFilter('')
    setDateToFilter('')
    setDealValueMin('')
    setDealValueMax('')
    setPolicyStatusUpdatedFilter('all')
    setDealValueUpdatedFilter('all')
    setShowMode('all')
  }

  const toYmd = (v: unknown) => toYmdForDateInput(v)

  const startInlineEdit = () => {
    const next: Record<string, any> = {}
    entries.forEach((e) => {
      next[e.id] = {
        ...e,
        deal_creation_date: toYmd(e.deal_creation_date),
        effective_date: toYmd(e.effective_date),
        deal_value: e.deal_value != null ? String(e.deal_value) : '',
        cc_value: e.cc_value != null ? String(e.cc_value) : '',
      }
    })
    setDraftById(next)
    setEditMode(true)
  }

  const cancelInlineEdit = () => {
    setEditMode(false)
    setDraftById({})
  }

  const updateDraft = (id: string, field: string, value: string) => {
    setDraftById((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), [field]: value },
    }))
  }

  const saveInlineEdits = async () => {
    setSavingInlineEdits(true)
    try {
      const fields = [
        'name', 'policy_number', 'carrier', 'policy_status', 'ghl_stage', 'carrier_status', 'status',
        'deal_value', 'cc_value', 'sales_agent', 'writing_number', 'call_center', 'phone_number',
        'deal_creation_date', 'effective_date',
      ]
      const changedRows = entries.filter((row) => {
        const draft = draftById[row.id]
        if (!draft) return false
        return fields.some((f) => String(draft[f] ?? '') !== String(row[f] ?? ''))
      })

      for (const row of changedRows) {
        const draft = draftById[row.id]
        const dealValue =
          String(draft.deal_value ?? '').trim() === '' ? null : Number.parseFloat(String(draft.deal_value))
        const ccValue =
          String(draft.cc_value ?? '').trim() === '' ? null : Number.parseFloat(String(draft.cc_value))
        const payload = {
          name: String(draft.name ?? '').trim() || null,
          policy_number: String(draft.policy_number ?? '').trim(),
          carrier: String(draft.carrier ?? '').trim(),
          policy_status: String(draft.policy_status ?? '').trim() || null,
          ghl_stage: String(draft.ghl_stage ?? '').trim() || null,
          carrier_status: String(draft.carrier_status ?? '').trim() || null,
          status: String(draft.status ?? '').trim() || null,
          deal_value: Number.isNaN(dealValue as number) ? null : dealValue,
          cc_value: Number.isNaN(ccValue as number) ? null : ccValue,
          sales_agent: String(draft.sales_agent ?? '').trim() || null,
          writing_number: String(draft.writing_number ?? '').trim() || null,
          call_center: String(draft.call_center ?? '').trim() || null,
          phone_number: String(draft.phone_number ?? '').trim() || null,
          deal_creation_date: String(draft.deal_creation_date ?? '').trim() || null,
          effective_date: String(draft.effective_date ?? '').trim() || null,
          updated_at: new Date().toISOString(),
          last_updated: new Date().toISOString(),
        }
        const { error } = await supabase.from('deal_tracker').update(payload).eq('id', row.id)
        if (error) throw error
      }

      await fetchEntries()
      setEditMode(false)
      setDraftById({})
    } catch (error: any) {
      alert(error?.message || 'Failed to save inline edits.')
    } finally {
      setSavingInlineEdits(false)
    }
  }

  const withCurrentOption = (options: string[], current: unknown) => {
    const v = String(current ?? '').trim()
    if (!v) return options
    return options.includes(v) ? options : [v, ...options]
  }

  const openCreatePolicyDialog = () => {
    setPolicyDialogMode('create')
    setPolicyDraft({})
    setPolicyDialogOpen(true)
  }

  const handleSavePolicy = async (form: DealTrackerPolicyForm) => {
    const selected = agencyCarrierOptions.find((o) => o.id === form.agency_carrier_id)
    if (!selected) {
      alert('Please select a valid agency + carrier.')
      return
    }

    const now = new Date().toISOString()
    const dealValue =
      form.deal_value.trim() === '' ? null : Number.parseFloat(form.deal_value)
    if (form.deal_value.trim() !== '' && Number.isNaN(dealValue)) {
      alert('Deal value must be a valid number.')
      return
    }

    const payload = {
      agency_carrier_id: form.agency_carrier_id,
      carrier: selected.carrierName,
      carrier_id: selected.carrierId,
      policy_number: form.policy_number.trim(),
      name: form.name.trim() || null,
      policy_status: form.policy_status.trim() || null,
      deal_value: dealValue,
      sales_agent: form.sales_agent.trim() || null,
      writing_number: form.writing_number.trim() || null,
      call_center: form.call_center.trim() || null,
      phone_number: form.phone_number.trim() || null,
      deal_creation_date: form.deal_creation_date || null,
      effective_date: form.effective_date || null,
      ghl_stage: form.ghl_stage.trim() || null,
      notes: form.notes.trim() || null,
      last_updated: now,
      updated_at: now,
    }

    setSavingPolicy(true)
    try {
      if (policyDialogMode === 'edit' && form.id) {
        const { error } = await supabase
          .from('deal_tracker')
          .update(payload)
          .eq('id', form.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('deal_tracker')
          .insert({ ...payload, created_at: now })
        if (error) throw error
      }
      setPolicyDialogOpen(false)
      await fetchEntries()
    } catch (error: any) {
      alert(error?.message || 'Failed to save policy.')
    } finally {
      setSavingPolicy(false)
    }
  }

  const hasActiveFilters = searchTerm || carrierFilter !== 'all' || statusFilter !== 'all' || ghlStageFilter !== 'all' ||
    agencyFilter !== 'all' || agentFilter !== 'all' || callCenterFilter !== 'all' || dateFromFilter || dateToFilter || 
    dealValueMin || dealValueMax || policyStatusUpdatedFilter !== 'all' || dealValueUpdatedFilter !== 'all' || showMode !== 'all'

  const filterActiveCount = [
    searchTerm,
    carrierFilter !== 'all',
    statusFilter !== 'all',
    ghlStageFilter !== 'all',
    agencyFilter !== 'all',
    agentFilter !== 'all',
    callCenterFilter !== 'all',
    dateFromFilter,
    dateToFilter,
    dealValueMin,
    dealValueMax,
    policyStatusUpdatedFilter !== 'all',
    dealValueUpdatedFilter !== 'all',
    showMode !== 'all',
  ].filter(Boolean).length

  const advancedFilterCount = [
    agencyFilter !== 'all',
    agentFilter !== 'all',
    callCenterFilter !== 'all',
    dealValueMin,
    dealValueMax,
    policyStatusUpdatedFilter !== 'all',
    dealValueUpdatedFilter !== 'all',
  ].filter(Boolean).length

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center py-16">
        <Loader2 className="h-9 w-9 animate-spin text-orange-400" />
      </div>
    )
  }

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Deal Tracker"
        description="Standardized view of all deals across carriers."
        icon={<TrendingUp className="h-7 w-7 text-orange-400" strokeWidth={2} />}
      />

      {/* Filters Card */}
      <Card>
        <CardHeader className={cn('space-y-3 pb-5', adminCardHeaderBar)}>
          <FilterBarHeader
            title="Find deals"
            description="Search freely, use quick date ranges for activity on a deal, then stack “Quick focus” chips or open More filters for agency, team, size, and audit trails."
            activeCount={filterActiveCount}
            onClearAll={hasActiveFilters ? clearFilters : undefined}
          />
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="relative lg:col-span-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
              <Input
                placeholder="Search name, policy #, agent, phone…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={cn(adminInput, 'pl-10')}
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                <SelectItem value="all" className={adminSelectItem}>All Carriers</SelectItem>
                {carriers.map(carrier => (
                  <SelectItem key={carrier} value={carrier} className={adminSelectItem}>
                    {carrier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                <SelectItem value="all" className={adminSelectItem}>All Statuses</SelectItem>
                {statuses.map(status => (
                  <SelectItem key={status} value={status} className={adminSelectItem}>
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={ghlStageFilter} onValueChange={setGhlStageFilter}>
              <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                <SelectValue placeholder="All GHL Stages" />
              </SelectTrigger>
              <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                <SelectItem value="all" className={adminSelectItem}>All GHL Stages</SelectItem>
                {ghlStages.map(stage => (
                  <SelectItem key={stage} value={stage} className={adminSelectItem}>
                    {stage}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={fetchEntries} variant="outline" className={adminOutlineBtn}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh data
            </Button>
          </div>

          <div className={cn(adminFilterWell, 'space-y-3 p-3')}>
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Activity in date range
            </p>
            <p className="-mt-2 text-xs text-muted-foreground">
              Includes deal creation date, first seen date, or any snapshot timestamp in version history.
            </p>
            <QuickDateRangeChips
              dateFrom={dateFromFilter}
              dateTo={dateToFilter}
              onRangeChange={(f, t) => {
                setDateFromFilter(f)
                setDateToFilter(t)
              }}
            />
            <div className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">From</label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => dateFromInputRef.current?.showPicker?.()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dateFromInputRef.current?.showPicker?.() } }}
                  className={adminDatePickerRow}
                >
                  <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                  <input
                    ref={dateFromInputRef}
                    type="date"
                    value={dateFromFilter}
                    onChange={(e) => setDateFromFilter(e.target.value)}
                    className={cn(adminDatePickerInput, 'flex-1 cursor-pointer')}
                    aria-label="Deal activity from date"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-foreground">To</label>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => dateToInputRef.current?.showPicker?.()}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dateToInputRef.current?.showPicker?.() } }}
                  className={adminDatePickerRow}
                >
                  <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
                  <input
                    ref={dateToInputRef}
                    type="date"
                    value={dateToFilter}
                    onChange={(e) => setDateToFilter(e.target.value)}
                    className={cn(adminDatePickerInput, 'flex-1 cursor-pointer')}
                    aria-label="Deal activity to date"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 w-full text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:w-auto">
              Quick focus
            </span>
            <FilterPresetChip
              active={showMode === 'new'}
              onClick={() => setShowMode(showMode === 'new' ? 'all' : 'new')}
              title="Only new deals (same as New tab)"
            >
              New only
            </FilterPresetChip>
            <FilterPresetChip
              active={policyStatusUpdatedFilter === 'updated'}
              onClick={() => setPolicyStatusUpdatedFilter((v) => (v === 'updated' ? 'all' : 'updated'))}
              title="Deals with any version history"
            >
              Has history
            </FilterPresetChip>
            <FilterPresetChip
              active={policyStatusUpdatedFilter === 'changed'}
              onClick={() => setPolicyStatusUpdatedFilter((v) => (v === 'changed' ? 'all' : 'changed'))}
              title="Policy status changed over time"
            >
              Status changed
            </FilterPresetChip>
            <FilterPresetChip
              active={dealValueUpdatedFilter === 'changed'}
              onClick={() => setDealValueUpdatedFilter((v) => (v === 'changed' ? 'all' : 'changed'))}
              title="Deal value changed over time"
            >
              Value changed
            </FilterPresetChip>
            <FilterPresetChip
              active={dealValueMin === '10000' && !dealValueMax}
              onClick={() => {
                if (dealValueMin === '10000' && !dealValueMax) {
                  setDealValueMin('')
                } else {
                  setDealValueMin('10000')
                  setDealValueMax('')
                }
              }}
              title="Deal value at least $10,000"
            >
              $10k+ deals
            </FilterPresetChip>
            <FilterPresetChip
              active={false}
              onClick={() => {
                setShowMode('all')
                setPolicyStatusUpdatedFilter('all')
                setDealValueUpdatedFilter('all')
                setDealValueMin('')
                setDealValueMax('')
              }}
              title="Clear quick focus presets only"
            >
              Reset quick focus
            </FilterPresetChip>
          </div>

          <CollapsibleFilterSection
            title="More filters — agency, team, size & audit"
            activeSubCount={advancedFilterCount}
            defaultOpen={advancedFilterCount > 0}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Select value={agencyFilter} onValueChange={setAgencyFilter}>
                <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                  <SelectValue placeholder="All Agencies" />
                </SelectTrigger>
                <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                  <SelectItem value="all" className={adminSelectItem}>All Agencies</SelectItem>
                  {agencies.map(agency => (
                    <SelectItem key={agency} value={agency} className={adminSelectItem}>
                      {agency}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={agentFilter} onValueChange={setAgentFilter}>
                <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                  <SelectValue placeholder="All Agents" />
                </SelectTrigger>
                <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                  <SelectItem value="all" className={adminSelectItem}>All Agents</SelectItem>
                  {agents.map(agent => (
                    <SelectItem key={agent} value={agent} className={adminSelectItem}>
                      {agent}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={callCenterFilter} onValueChange={setCallCenterFilter}>
                <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                  <SelectValue placeholder="All Call Centers" />
                </SelectTrigger>
                <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                  <SelectItem value="all" className={adminSelectItem}>All Call Centers</SelectItem>
                  {callCenters.map(cc => (
                    <SelectItem key={cc} value={cc} className={adminSelectItem}>
                      {cc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">Deal value min</label>
                <Input
                  type="number"
                  placeholder="Min"
                  value={dealValueMin}
                  onChange={(e) => setDealValueMin(e.target.value)}
                  className={adminInput}
                />
              </div>
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">Deal value max</label>
                <Input
                  type="number"
                  placeholder="Max"
                  value={dealValueMax}
                  onChange={(e) => setDealValueMax(e.target.value)}
                  className={adminInput}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">Policy status (audit)</label>
                <Select value={policyStatusUpdatedFilter} onValueChange={setPolicyStatusUpdatedFilter}>
                  <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent className={adminSelectContent}>
                    <SelectItem value="all" className={adminSelectItem}>All</SelectItem>
                    <SelectItem value="updated" className={adminSelectItem}>Has history</SelectItem>
                    <SelectItem value="not_updated" className={adminSelectItem}>No history</SelectItem>
                    <SelectItem value="changed" className={adminSelectItem}>Status changed in history</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="mb-2 block text-sm text-muted-foreground">Deal value (audit)</label>
                <Select value={dealValueUpdatedFilter} onValueChange={setDealValueUpdatedFilter}>
                  <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent className={adminSelectContent}>
                    <SelectItem value="all" className={adminSelectItem}>All</SelectItem>
                    <SelectItem value="updated" className={adminSelectItem}>Has history</SelectItem>
                    <SelectItem value="not_updated" className={adminSelectItem}>No history</SelectItem>
                    <SelectItem value="changed" className={adminSelectItem}>Value changed in history</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CollapsibleFilterSection>

          {/* Results Count */}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4 text-sm text-muted-foreground dark:border-slate-800/80">
            <span>
              Showing {filteredEntries.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredEntries.length)} of {filteredEntries.length} deals
            </span>
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                <SelectTrigger className={cn('h-8 w-20 text-xs', adminSelectTrigger)}>
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
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card>
        <CardHeader className={cn('pb-5', adminCardHeaderBar)}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className={adminCardTitle}>
                Deals{' '}
                <span className="text-xs font-normal text-muted-foreground">({filteredEntries.length})</span>
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={exportExcel}
                className={adminOutlineBtn}
              >
                Export Excel
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => importFromCsv(e.target.files?.[0] ?? null)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportClick}
                className={adminOutlineBtn}
              >
                Import CSV
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={openCreatePolicyDialog}
                className={adminOutlineBtn}
              >
                <Plus className="mr-1 h-4 w-4" />
                Add policy
              </Button>
              {!editMode ? (
                <Button variant="outline" size="sm" onClick={startInlineEdit} className={adminOutlineBtn}>
                  Edit table
                </Button>
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
            <div className={cn(adminTypeTabsWrap, 'items-center gap-1')}>
              <span className="px-2 py-1 text-sm text-muted-foreground">Show:</span>
              <button
                type="button"
                onClick={() => setShowMode('all')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'all' ? adminTypeTabActive : adminTypeTabIdle
                )}
              >
                All ({allTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('new')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'new' ? adminTypeTabActive : adminTypeTabIdle
                )}
              >
                New ({newTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('updated')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'updated' ? adminTypeTabActive : adminTypeTabIdle
                )}
              >
                Updated ({updatedTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('changed')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'changed' ? adminTypeTabActive : adminTypeTabIdle
                )}
              >
                Changed ({changedTabCount})
              </button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800">
                  <TableHead className={adminThPlain}>Name</TableHead>
                  <TableHead className={adminThPlain}>Policy Number</TableHead>
                  <TableHead className={adminThPlain}>Carrier</TableHead>
                  <TableHead className={adminThPlain}>Policy Status</TableHead>
                  <TableHead className={adminThPlain}>GHL Stage</TableHead>
                  <TableHead className={adminThPlain} title="Raw status from carrier file (no mapping)">
                    Carrier Status (raw)
                  </TableHead>
                  <TableHead className={adminThPlain} title="Rule-based: NOT yet paid / Charge Back / Paid from deal value">
                    Status
                  </TableHead>
                  <TableHead className={adminThPlain}>Deal Value</TableHead>
                  <TableHead className={adminThPlain}>CC Value</TableHead>
                  <TableHead className={adminThPlain}>Sales Agent</TableHead>
                  <TableHead className={adminThPlain}>Writing #</TableHead>
                  <TableHead className={adminThPlain}>Call Center</TableHead>
                  <TableHead className={adminThPlain}>Phone Number</TableHead>
                  <TableHead className={adminThPlain}>Deal Creation Date</TableHead>
                  <TableHead className={adminThPlain}>Effective Date</TableHead>
                  <TableHead className={cn('w-20', adminThPlain)}>History</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-orange-400 mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={16} className="py-8 text-center text-muted-foreground">
                      {hasActiveFilters ? 'No deals found matching your filters' : 'No deals found'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedEntries.map((entry) => {
                    const changedFields = getChangedFieldsFromHistory(entry)
                    const cellChanged = (field: string) => changedFields.includes(field)
                    return (
                    <TableRow key={entry.id} className={adminTableRowInteractive}>
                      <TableCell className={cn(adminTdStrong, 'font-medium', cellChanged('name') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? (
                          <Input value={draftById[entry.id]?.name ?? ''} onChange={(e) => updateDraft(entry.id, 'name', e.target.value)} className={inlineEditInputWide} />
                        ) : (
                          entry.name || '-'
                        )}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, 'font-mono text-sm')}>
                        {editMode ? (
                          <Input value={draftById[entry.id]?.policy_number ?? ''} onChange={(e) => updateDraft(entry.id, 'policy_number', e.target.value)} className={cn(inlineEditInput, 'font-mono')} />
                        ) : (
                          entry.policy_number
                        )}
                      </TableCell>
                      <TableCell className={adminTdMuted}>
                        {editMode ? (
                          <Input value={draftById[entry.id]?.carrier ?? ''} onChange={(e) => updateDraft(entry.id, 'carrier', e.target.value)} className={inlineEditInput} />
                        ) : (
                          entry.carrier
                        )}
                      </TableCell>
                      <TableCell className={cn(cellChanged('policy_status') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? (
                          <Select
                            value={draftById[entry.id]?.policy_status || '__empty__'}
                            onValueChange={(v) => updateDraft(entry.id, 'policy_status', v === '__empty__' ? '' : v)}
                          >
                            <SelectTrigger className={cn(inlineEditInput, 'w-[180px]')}>
                              <SelectValue placeholder="Select policy status" />
                            </SelectTrigger>
                            <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                              <SelectItem value="__empty__" className={adminSelectItem}>-</SelectItem>
                              {withCurrentOption(statuses, draftById[entry.id]?.policy_status).map((status) => (
                                <SelectItem key={status} value={status} className={adminSelectItem}>
                                  {status}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline" className="border-border text-foreground dark:border-slate-700 dark:text-slate-300">
                            {entry.policy_status || '-'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('ghl_stage') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? (
                          <Select
                            value={draftById[entry.id]?.ghl_stage || '__empty__'}
                            onValueChange={(v) => updateDraft(entry.id, 'ghl_stage', v === '__empty__' ? '' : v)}
                          >
                            <SelectTrigger className={cn(inlineEditInput, 'w-[180px]')}>
                              <SelectValue placeholder="Select GHL stage" />
                            </SelectTrigger>
                            <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                              <SelectItem value="__empty__" className={adminSelectItem}>-</SelectItem>
                              {withCurrentOption(ghlStages, draftById[entry.id]?.ghl_stage).map((stage) => (
                                <SelectItem key={stage} value={stage} className={adminSelectItem}>
                                  {stage}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          entry.ghl_stage || '-'
                        )}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('carrier_status') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? (
                          <Select
                            value={draftById[entry.id]?.carrier_status || '__empty__'}
                            onValueChange={(v) => updateDraft(entry.id, 'carrier_status', v === '__empty__' ? '' : v)}
                          >
                            <SelectTrigger className={cn(inlineEditInput, 'w-[180px]')}>
                              <SelectValue placeholder="Select carrier status" />
                            </SelectTrigger>
                            <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                              <SelectItem value="__empty__" className={adminSelectItem}>-</SelectItem>
                              {withCurrentOption(carrierStatuses, draftById[entry.id]?.carrier_status).map((rawStatus) => (
                                <SelectItem key={rawStatus} value={rawStatus} className={adminSelectItem}>
                                  {rawStatus}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          entry.carrier_status || '-'
                        )}
                      </TableCell>
                      <TableCell className={cn(cellChanged('status') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? (
                          <Select
                            value={draftById[entry.id]?.status || '__empty__'}
                            onValueChange={(v) => updateDraft(entry.id, 'status', v === '__empty__' ? '' : v)}
                          >
                            <SelectTrigger className={cn(inlineEditInputNarrow, 'w-[150px]')}>
                              <SelectValue placeholder="Select status" />
                            </SelectTrigger>
                            <SelectContent className={cn(adminSelectContent, 'max-h-72')}>
                              <SelectItem value="__empty__" className={adminSelectItem}>-</SelectItem>
                              {withCurrentOption(dealStatuses, draftById[entry.id]?.status).map((dealStatus) => (
                                <SelectItem key={dealStatus} value={dealStatus} className={adminSelectItem}>
                                  {dealStatus}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="outline" className="border-border text-foreground dark:border-slate-700 dark:text-slate-300" title="From deal value: 0 → NOT yet paid, negative → Charge Back, positive → Paid">
                            {entry.status || '-'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('deal_value') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input type="number" value={draftById[entry.id]?.deal_value ?? ''} onChange={(e) => updateDraft(entry.id, 'deal_value', e.target.value)} className={inlineEditInputNarrow} /> : entry.deal_value
                          ? `$${entry.deal_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('cc_value') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input type="number" value={draftById[entry.id]?.cc_value ?? ''} onChange={(e) => updateDraft(entry.id, 'cc_value', e.target.value)} className={inlineEditInputNarrow} /> : entry.cc_value
                          ? `$${entry.cc_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('sales_agent') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input value={draftById[entry.id]?.sales_agent ?? ''} onChange={(e) => updateDraft(entry.id, 'sales_agent', e.target.value)} className={inlineEditInput} /> : (entry.sales_agent || '-')}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('writing_number') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input value={draftById[entry.id]?.writing_number ?? ''} onChange={(e) => updateDraft(entry.id, 'writing_number', e.target.value)} className={cn(inlineEditInputNarrow, 'font-mono')} /> : (entry.writing_number || '-')}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('call_center') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input value={draftById[entry.id]?.call_center ?? ''} onChange={(e) => updateDraft(entry.id, 'call_center', e.target.value)} className={inlineEditInput} /> : (entry.call_center || '-')}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('phone_number') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input value={draftById[entry.id]?.phone_number ?? ''} onChange={(e) => updateDraft(entry.id, 'phone_number', e.target.value)} className={cn(inlineEditInput, 'font-mono')} /> : (entry.phone_number || '-')}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('deal_creation_date') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input type="date" value={draftById[entry.id]?.deal_creation_date ?? ''} onChange={(e) => updateDraft(entry.id, 'deal_creation_date', e.target.value)} className={inlineEditInputWide} /> : entry.deal_creation_date
                          ? formatStoredDateForDisplay(entry.deal_creation_date)
                          : '-'}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, cellChanged('effective_date') && 'border-l-2 border-amber-500 bg-amber-500/20')}>
                        {editMode ? <Input type="date" value={draftById[entry.id]?.effective_date ?? ''} onChange={(e) => updateDraft(entry.id, 'effective_date', e.target.value)} className={inlineEditInputWide} /> : entry.effective_date
                          ? formatStoredDateForDisplay(entry.effective_date)
                          : '-'}
                      </TableCell>
                      <TableCell className={adminTdMuted}>
                        {(() => {
                          const updatesCount = Array.isArray(entry.version_history)
                            ? entry.version_history.length
                            : 0
                          return (
                            <Link
                              href={`/records/history?table=deal_tracker&id=${encodeURIComponent(entry.id)}`}
                              className="inline-flex items-center gap-1 text-sm text-orange-600 hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300"
                              title={
                                updatesCount === 0
                                  ? 'No previous versions'
                                  : `Updated ${updatesCount} time${updatesCount === 1 ? '' : 's'}`
                              }
                            >
                              <History className="h-4 w-4" />
                              <span>History</span>
                              <span className="ml-1 inline-flex items-center justify-center rounded-full border border-orange-500/50 bg-orange-500/10 px-1.5 text-[10px] leading-none text-orange-800 dark:border-orange-500/60 dark:text-orange-300">
                                {updatesCount}
                              </span>
                            </Link>
                          )
                        })()}
                      </TableCell>
                    </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination Controls */}
          {filteredEntries.length > 0 && (
            <div className={cn('flex flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80', adminPaginationBar)}>
              <div className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </div>
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
          )}
        </CardContent>
      </Card>
      {policyDialogOpen && (
        <DealTrackerPolicyDialog
          open={policyDialogOpen}
          onOpenChange={setPolicyDialogOpen}
          saving={savingPolicy}
          mode={policyDialogMode}
          initialValue={policyDraft}
          agencyCarrierOptions={agencyCarrierOptions}
          onSave={handleSavePolicy}
        />
      )}
    </div>
  )
}
