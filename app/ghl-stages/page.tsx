'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getDealTrackerEntries } from '@/lib/dealTracker'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Loader2, Search, RefreshCw, X, LayoutGrid } from 'lucide-react'
import { FilterBarHeader, FilterPresetChip } from '@/components/filters/SmartFilters'
import { PageHeader } from '@/components/PageHeader'
import GhlKanbanBoard from '@/components/GhlKanbanBoard'
import { GHL_STAGE_CATEGORIES, GHL_STAGE_ORDER } from '@/lib/ghlStageResolver'
import {
  adminCardHeaderBar,
  adminInput,
  adminOutlineBtn,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminMutedRow,
} from '@/lib/adminFieldClasses'

export default function GhlStagesPage() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [carriers, setCarriers] = useState<string[]>([])
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [stageFilter, setStageFilter] = useState<string>('all')

  useEffect(() => {
    fetchEntries()
  }, [])

  const fetchEntries = async () => {
    setLoading(true)
    try {
      const data = await getDealTrackerEntries({ limit: 20000 })
      const rows = data || []
      setEntries(rows)

      const { data: carrierRows } = await supabase.from('carriers').select('name').order('name')
      if (carrierRows) {
        const unique = Array.from(new Set((carrierRows as any[]).map(c => c.name).filter(Boolean))).sort()
        setCarriers(unique as string[])
      }
    } catch (error) {
      console.error('Error fetching entries:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredEntries = entries.filter(entry => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase()
      const match =
        entry.name?.toLowerCase().includes(s) ||
        entry.policy_number?.toLowerCase().includes(s) ||
        entry.sales_agent?.toLowerCase().includes(s) ||
        entry.carrier?.toLowerCase().includes(s)
      if (!match) return false
    }
    if (carrierFilter !== 'all' && entry.carrier !== carrierFilter) return false
    return true
  })

  const handleStageChange = useCallback(async (dealId: string, newStage: string, _previousStage: string | null) => {
    try {
      const res = await fetch('/api/deal-tracker/update-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealId, newStage }),
      })
      if (!res.ok) {
        const err = await res.json()
        console.error('Failed to update stage:', err)
        return
      }
      setEntries(prev =>
        prev.map(e => e.id === dealId ? { ...e, ghl_stage: newStage } : e)
      )
    } catch (err) {
      console.error('Error updating stage:', err)
    }
  }, [])

  const visibleCategory = GHL_STAGE_CATEGORIES.find(c => c.key === categoryFilter) ?? null
  const availableStagesForCategory = visibleCategory ? visibleCategory.stages : (GHL_STAGE_ORDER as unknown as string[])
  const hasStageScopeFilter = categoryFilter !== 'all' || stageFilter !== 'all'
  const visibleStages =
    stageFilter !== 'all' ? [stageFilter] : (categoryFilter !== 'all' ? availableStagesForCategory : null)
  const showUnmapped = !hasStageScopeFilter

  useEffect(() => {
    // If user changes the category, reset the specific stage filter.
    setStageFilter('all')
  }, [categoryFilter])

  const hasActiveFilters = searchTerm || carrierFilter !== 'all' || hasStageScopeFilter

  const filterActiveCount = [
    searchTerm,
    carrierFilter !== 'all',
    categoryFilter !== 'all',
    stageFilter !== 'all',
  ].filter(Boolean).length

  const topCarriers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of entries) {
      const c = e.carrier
      if (!c) continue
      counts.set(c, (counts.get(c) || 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name)
  }, [entries])

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setCategoryFilter('all')
    setStageFilter('all')
  }

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
        title="GHL Stage Board"
        description="Manage and move deals between GHL stages. Drag cards or use the Move button."
        icon={<LayoutGrid className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
      />

      {/* Filters */}
      <Card>
        <CardHeader className={`space-y-4 pb-5 ${adminCardHeaderBar}`}>
          <FilterBarHeader
            title="Scope the board"
            description="Tap a carrier or lock a GHL lane to narrow stages. The board below shows one major section at a time — switch sections in the board header."
            activeCount={filterActiveCount}
            onClearAll={hasActiveFilters ? clearFilters : undefined}
          />
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[11px] font-medium uppercase tracking-wide ${adminMutedRow} mr-1 w-full sm:w-auto`}>
              Top carriers
            </span>
            <FilterPresetChip
              active={carrierFilter === 'all'}
              onClick={() => setCarrierFilter('all')}
              title="Show all carriers"
            >
              All
            </FilterPresetChip>
            {topCarriers.map((name) => (
              <FilterPresetChip
                key={name}
                active={carrierFilter === name}
                onClick={() => setCarrierFilter(carrierFilter === name ? 'all' : name)}
                title={`Filter to ${name}`}
              >
                {name.length > 18 ? `${name.slice(0, 16)}…` : name}
              </FilterPresetChip>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`text-[11px] font-medium uppercase tracking-wide ${adminMutedRow} mr-1 w-full sm:w-auto`}>
              GHL lane
            </span>
            {GHL_STAGE_CATEGORIES.map((cat) => (
              <FilterPresetChip
                key={cat.key}
                active={categoryFilter === cat.key}
                onClick={() => setCategoryFilter(categoryFilter === cat.key ? 'all' : cat.key)}
                title={cat.label}
              >
                {cat.label}
              </FilterPresetChip>
            ))}
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
              <Input
                placeholder="Search name, policy #, agent, carrier…"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className={`pl-10 ${adminInput}`}
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger className={`w-48 ${adminSelectTrigger}`}>
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>All Carriers</SelectItem>
                {carriers.map(c => (
                  <SelectItem key={c} value={c} className={adminSelectItem}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className={`w-48 ${adminSelectTrigger}`}>
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>All Categories</SelectItem>
                {GHL_STAGE_CATEGORIES.map(cat => (
                  <SelectItem key={cat.key} value={cat.key} className={adminSelectItem}>{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={stageFilter} onValueChange={setStageFilter}>
              <SelectTrigger className={`w-56 ${adminSelectTrigger}`}>
                <SelectValue placeholder="All Stages" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                <SelectItem value="all" className={adminSelectItem}>All Stages</SelectItem>
                {availableStagesForCategory.map(s => (
                  <SelectItem key={s} value={s} className={adminSelectItem}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button onClick={fetchEntries} variant="outline" className={adminOutlineBtn}>
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            {hasActiveFilters && (
              <Button onClick={clearFilters} variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                <X className="w-4 h-4 mr-2" />
                Clear
              </Button>
            )}
            <span className={`ml-auto text-sm tabular-nums ${adminMutedRow}`}>{filteredEntries.length} deals</span>
          </div>
        </CardContent>
      </Card>

      {/* Kanban Board */}
      <GhlKanbanBoard
        entries={filteredEntries.map((e: any) => ({
          id: e.id,
          name: e.name,
          policy_number: e.policy_number,
          carrier: e.carrier,
          carrier_status: e.carrier_status,
          ghl_stage: e.ghl_stage,
          deal_value: e.deal_value,
          effective_date: e.effective_date,
          sales_agent: e.sales_agent,
        }))}
        onStageChange={handleStageChange}
        visibleStages={visibleStages}
        showUnmapped={showUnmapped}
        lockedCategoryKey={categoryFilter !== 'all' ? categoryFilter : null}
      />
    </div>
  )
}
