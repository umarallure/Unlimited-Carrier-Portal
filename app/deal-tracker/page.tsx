'use client'

import { useState, useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getDealTrackerEntries, getChangedFieldsFromHistory } from '@/lib/dealTracker'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import Link from 'next/link'
import { Loader2, Search, RefreshCw, X, Calendar, History } from 'lucide-react'

export default function DealTrackerPage() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
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
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  const dateFromInputRef = useRef<HTMLInputElement>(null)
  const dateToInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetchEntries()
  }, [])

  useEffect(() => {
    setCurrentPage(1) // Reset to page 1 when filters change
  }, [searchTerm, carrierFilter, statusFilter, agencyFilter, agentFilter, callCenterFilter, dateFromFilter, dateToFilter, dealValueMin, dealValueMax, policyStatusUpdatedFilter, dealValueUpdatedFilter, showMode])

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

      setAgents(uniqueAgents as string[])
      setCallCenters(uniqueCallCenters as string[])
      setStatuses(uniqueStatuses as string[])
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

  const exportCsv = () => {
    if (!filteredEntries.length) return
    const headers = [
      'Name',
      'Policy Number',
      'Carrier',
      'Policy Status',
      'GHL Stage',
      'Carrier Status (raw)',
      'Status',
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
      ]
    })
    const csv = [headers, ...rows]
      .map((row) =>
        row
          .map((val) => {
            const s = String(val ?? '')
            return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
          })
          .join(',')
      )
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const today = new Date().toISOString().slice(0, 10)
    link.href = url
    link.setAttribute('download', `deal-tracker-${showMode}-${today}.csv`)
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setStatusFilter('all')
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

  const hasActiveFilters = searchTerm || carrierFilter !== 'all' || statusFilter !== 'all' || 
    agencyFilter !== 'all' || agentFilter !== 'all' || callCenterFilter !== 'all' || dateFromFilter || dateToFilter || 
    dealValueMin || dealValueMax || policyStatusUpdatedFilter !== 'all' || dealValueUpdatedFilter !== 'all' || showMode !== 'all'

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    )
  }

  return (
    <div className="w-full max-w-none py-8 px-4 space-y-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2 text-white">Deal Tracker</h1>
        <p className="text-slate-400">
          Standardized view of all deals across carriers
        </p>
      </div>

      {/* Filters Card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white">Filters</CardTitle>
            {hasActiveFilters && (
              <Button onClick={clearFilters} variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                <X className="w-4 h-4 mr-2" />
                Clear All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {/* Row 1: Search and Basic Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
              <Input
                placeholder="Search name, policy #, agent..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Carriers</SelectItem>
                {carriers.map(carrier => (
                  <SelectItem key={carrier} value={carrier} className="text-white">
                    {carrier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Statuses</SelectItem>
                {statuses.map(status => (
                  <SelectItem key={status} value={status} className="text-white">
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={fetchEntries} variant="outline" className="border-slate-700 text-slate-300 hover:bg-slate-800">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>

          {/* Row 2: Agency, Agent, Call Center, Date Range */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-4">
            <Select value={agencyFilter} onValueChange={setAgencyFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Agencies" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Agencies</SelectItem>
                {agencies.map(agency => (
                  <SelectItem key={agency} value={agency} className="text-white">
                    {agency}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Agents" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Agents</SelectItem>
                {agents.map(agent => (
                  <SelectItem key={agent} value={agent} className="text-white">
                    {agent}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={callCenterFilter} onValueChange={setCallCenterFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Call Centers" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Call Centers</SelectItem>
                {callCenters.map(cc => (
                  <SelectItem key={cc} value={cc} className="text-white">
                    {cc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex flex-col gap-1">
              <label className="text-sm text-slate-400">From</label>
              <div
                role="button"
                tabIndex={0}
                onClick={() => dateFromInputRef.current?.showPicker?.()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dateFromInputRef.current?.showPicker?.() } }}
                className="flex items-center gap-2 min-h-9 px-3 py-2 rounded-md border border-slate-800 bg-slate-950 text-white text-sm cursor-pointer hover:border-slate-600 hover:bg-slate-900 transition-colors"
              >
                <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  ref={dateFromInputRef}
                  type="date"
                  value={dateFromFilter}
                  onChange={(e) => setDateFromFilter(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent border-none text-white text-sm outline-none cursor-pointer [color-scheme:dark]"
                  aria-label="Deal creation date from"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm text-slate-400">To</label>
              <div
                role="button"
                tabIndex={0}
                onClick={() => dateToInputRef.current?.showPicker?.()}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dateToInputRef.current?.showPicker?.() } }}
                className="flex items-center gap-2 min-h-9 px-3 py-2 rounded-md border border-slate-800 bg-slate-950 text-white text-sm cursor-pointer hover:border-slate-600 hover:bg-slate-900 transition-colors"
              >
                <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
                <input
                  ref={dateToInputRef}
                  type="date"
                  value={dateToFilter}
                  onChange={(e) => setDateToFilter(e.target.value)}
                  className="flex-1 min-w-0 bg-transparent border-none text-white text-sm outline-none cursor-pointer [color-scheme:dark]"
                  aria-label="Deal creation date to"
                />
              </div>
            </div>
          </div>

          {/* Row 3: Deal Value Range */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Deal Value Min</label>
              <Input
                type="number"
                placeholder="Min value"
                value={dealValueMin}
                onChange={(e) => setDealValueMin(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Deal Value Max</label>
              <Input
                type="number"
                placeholder="Max value"
                value={dealValueMax}
                onChange={(e) => setDealValueMax(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
          </div>

          {/* Row 4: Policy status / Deal value updated filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Policy status updated</label>
              <Select value={policyStatusUpdatedFilter} onValueChange={setPolicyStatusUpdatedFilter}>
                <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="all" className="text-white">All</SelectItem>
                  <SelectItem value="updated" className="text-white">Updated (has history)</SelectItem>
                  <SelectItem value="not_updated" className="text-white">Not updated (no history)</SelectItem>
                  <SelectItem value="changed" className="text-white">Changed (value changed)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Deal value updated</label>
              <Select value={dealValueUpdatedFilter} onValueChange={setDealValueUpdatedFilter}>
                <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                  <SelectValue placeholder="All" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="all" className="text-white">All</SelectItem>
                  <SelectItem value="updated" className="text-white">Updated (has history)</SelectItem>
                  <SelectItem value="not_updated" className="text-white">Not updated (no history)</SelectItem>
                  <SelectItem value="changed" className="text-white">Changed (value changed)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Results Count */}
          <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between text-sm text-slate-400">
            <span>
              Showing {filteredEntries.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredEntries.length)} of {filteredEntries.length} deals
            </span>
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                <SelectTrigger className="h-8 w-20 bg-slate-950 border-slate-800 text-white text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="25" className="text-white">25</SelectItem>
                  <SelectItem value="50" className="text-white">50</SelectItem>
                  <SelectItem value="100" className="text-white">100</SelectItem>
                  <SelectItem value="250" className="text-white">250</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <CardTitle className="text-white">
                Deals ({filteredEntries.length})
              </CardTitle>
              <Button
                variant="outline"
                size="sm"
                onClick={exportCsv}
                className="border-slate-600 text-slate-200 hover:bg-slate-800"
              >
                Export CSV
              </Button>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-slate-800/80 p-1">
              <span className="text-slate-400 text-sm px-2 py-1">Show:</span>
              <button
                type="button"
                onClick={() => setShowMode('all')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'all'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                )}
              >
                All ({allTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('new')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'new'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                )}
              >
                New ({newTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('updated')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'updated'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
                )}
              >
                Updated ({updatedTabCount})
              </button>
              <button
                type="button"
                onClick={() => setShowMode('changed')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  showMode === 'changed'
                    ? 'bg-orange-600 text-white'
                    : 'text-slate-300 hover:bg-slate-700 hover:text-white'
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
                <TableRow className="border-b border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-300 font-semibold">Name</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                <TableHead className="text-slate-300 font-semibold">Policy Status</TableHead>
                <TableHead className="text-slate-300 font-semibold">GHL Stage</TableHead>
                  <TableHead className="text-slate-300 font-semibold" title="Raw status from carrier file (no mapping)">
                    Carrier Status (raw)
                  </TableHead>
                  <TableHead className="text-slate-300 font-semibold" title="Rule-based: NOT yet paid / Charge Back / Paid from deal value">
                    Status
                  </TableHead>
                  <TableHead className="text-slate-300 font-semibold">Deal Value</TableHead>
                  <TableHead className="text-slate-300 font-semibold">CC Value</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Writing #</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Call Center</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Phone Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Deal Creation Date</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Effective Date</TableHead>
                  <TableHead className="text-slate-300 font-semibold w-20">History</TableHead>
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
                    <TableCell colSpan={16} className="text-center text-slate-400 py-8">
                      {hasActiveFilters ? 'No deals found matching your filters' : 'No deals found'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedEntries.map((entry) => {
                    const changedFields = getChangedFieldsFromHistory(entry)
                    const cellChanged = (field: string) => changedFields.includes(field)
                    return (
                    <TableRow key={entry.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors">
                      <TableCell className={cn('font-medium text-slate-100', cellChanged('name') && 'bg-amber-500/20 border-l-2 border-amber-500')}>{entry.name || '-'}</TableCell>
                      <TableCell className="text-slate-300 font-mono text-sm">{entry.policy_number}</TableCell>
                      <TableCell className="text-slate-300">{entry.carrier}</TableCell>
                      <TableCell className={cn(cellChanged('policy_status') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Badge variant="outline" className="border-slate-700 text-slate-300">
                          {entry.policy_status || '-'}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('ghl_stage') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.ghl_stage || '-'}
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('carrier_status') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.carrier_status || '-'}
                      </TableCell>
                      <TableCell className={cn(cellChanged('status') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        <Badge variant="outline" className="border-slate-700 text-slate-300" title="From deal value: 0 → NOT yet paid, negative → Charge Back, positive → Paid">
                          {entry.status || '-'}
                        </Badge>
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('deal_value') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.deal_value
                          ? `$${entry.deal_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('cc_value') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.cc_value
                          ? `$${entry.cc_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('sales_agent') && 'bg-amber-500/20 border-l-2 border-amber-500')}>{entry.sales_agent || '-'}</TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('writing_number') && 'bg-amber-500/20 border-l-2 border-amber-500')}>{entry.writing_number || '-'}</TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('call_center') && 'bg-amber-500/20 border-l-2 border-amber-500')}>{entry.call_center || '-'}</TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('phone_number') && 'bg-amber-500/20 border-l-2 border-amber-500')}>{entry.phone_number || '-'}</TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('deal_creation_date') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.deal_creation_date
                          ? new Date(entry.deal_creation_date).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell className={cn('text-slate-300', cellChanged('effective_date') && 'bg-amber-500/20 border-l-2 border-amber-500')}>
                        {entry.effective_date
                          ? new Date(entry.effective_date).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {(() => {
                          const updatesCount = Array.isArray(entry.version_history)
                            ? entry.version_history.length
                            : 0
                          return (
                            <Link
                              href={`/records/history?table=deal_tracker&id=${encodeURIComponent(entry.id)}`}
                              className="inline-flex items-center gap-1 text-orange-400 hover:text-orange-300 text-sm"
                              title={
                                updatesCount === 0
                                  ? 'No previous versions'
                                  : `Updated ${updatesCount} time${updatesCount === 1 ? '' : 's'}`
                              }
                            >
                              <History className="w-4 h-4" />
                              <span>History</span>
                              <span className="ml-1 inline-flex items-center justify-center rounded-full border border-orange-500/60 bg-orange-500/10 px-1.5 text-[10px] leading-none text-orange-300">
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
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
              <div className="text-sm text-slate-400">
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  First
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Last
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
