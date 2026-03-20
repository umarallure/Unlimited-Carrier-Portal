'use client'

import { useState, useEffect, useCallback } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getDealTrackerEntries } from '@/lib/dealTracker'
import { cn } from '@/lib/utils'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Loader2, Search, RefreshCw, X } from 'lucide-react'
import GhlKanbanBoard from '@/components/GhlKanbanBoard'
import { GHL_STAGE_CATEGORIES, GHL_STAGE_ORDER } from '@/lib/ghlStageResolver'

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

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setCategoryFilter('all')
    setStageFilter('all')
  }

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
        <h1 className="text-3xl font-bold mb-2 text-white">GHL Stage Board</h1>
        <p className="text-slate-400">
          Manage and move deals between GHL stages. Drag cards or use the Move button.
        </p>
      </div>

      {/* Filters */}
      <Card className="bg-slate-900 border-slate-800">
        <CardContent className="pt-4 pb-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
              <Input
                placeholder="Search name, policy #, agent..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger className="w-48 bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Carriers</SelectItem>
                {carriers.map(c => (
                  <SelectItem key={c} value={c} className="text-white">{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-48 bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Categories" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Categories</SelectItem>
                {GHL_STAGE_CATEGORIES.map(cat => (
                  <SelectItem key={cat.key} value={cat.key} className="text-white">{cat.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={stageFilter} onValueChange={setStageFilter}>
              <SelectTrigger className="w-56 bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Stages" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Stages</SelectItem>
                {availableStagesForCategory.map(s => (
                  <SelectItem key={s} value={s} className="text-white">{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={fetchEntries} variant="outline" className="border-slate-700 text-slate-300 hover:bg-slate-800">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
            {hasActiveFilters && (
              <Button onClick={clearFilters} variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                <X className="w-4 h-4 mr-2" />
                Clear
              </Button>
            )}
            <span className="text-sm text-slate-500 ml-auto">{filteredEntries.length} deals</span>
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
      />
    </div>
  )
}
