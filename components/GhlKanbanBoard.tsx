'use client'

import { useState, useRef, useCallback, useMemo } from 'react'
import { GHL_STAGE_ORDER, GHL_STAGE_CATEGORIES, getStageColor } from '@/lib/ghlStageResolver'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, User, FileText, Building2, Loader2, ArrowRight } from 'lucide-react'

interface KanbanDeal {
  id: string
  name: string | null
  policy_number: string
  carrier: string
  carrier_status: string | null
  ghl_stage: string | null
  deal_value: number | null
  effective_date: string | null
  sales_agent: string | null
}

interface GhlKanbanBoardProps {
  entries: KanbanDeal[]
  onStageChange: (dealId: string, newStage: string, previousStage: string | null) => Promise<void>
  /**
   * If provided, the board will only render these stages.
   * Any deals outside this set will not be shown (and unmapped column can be hidden via showUnmapped).
   */
  visibleStages?: string[] | null
  /** Whether to show the "Unmapped" column (default: true). */
  showUnmapped?: boolean
}

const STAGE_ALIASES: Record<string, string> = {
  'charge back cancellation': 'Chargeback Cancellation',
  'charge back failed payment': 'Chargeback Failed Payment',
  'chargeback cancellation': 'Chargeback Cancellation',
  'chargeback failed payment': 'Chargeback Failed Payment',
  'active placed - paid as advanced': 'Active Placed - Paid as Advanced',
  'active place as advanced': 'Active Placed - Paid as Advanced',
  'active placed - paid as earned': 'Active Placed - Paid as Earned',
  'active place as earned': 'Active Placed - Paid as Earned',
  'cb failed pmt': 'Chargeback Failed Payment',
  'cb cancellation': 'Chargeback Cancellation',
}

function normalizeStage(stage: string | null): string | null {
  if (!stage) return null
  const lower = stage.trim().toLowerCase()
  if (STAGE_ALIASES[lower]) return STAGE_ALIASES[lower]
  const exactMatch = GHL_STAGE_ORDER.find(s => s === stage)
  if (exactMatch) return exactMatch
  const caseMatch = GHL_STAGE_ORDER.find(s => s.toLowerCase() === lower)
  if (caseMatch) return caseMatch
  return stage
}

export default function GhlKanbanBoard({ entries, onStageChange, visibleStages, showUnmapped = true }: GhlKanbanBoardProps) {
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())
  const [movingDealId, setMovingDealId] = useState<string | null>(null)
  const [dragOverStage, setDragOverStage] = useState<string | null>(null)
  const [moveDialogDeal, setMoveDialogDeal] = useState<KanbanDeal | null>(null)
  const [selectedNewStage, setSelectedNewStage] = useState<string>('')
  const [isMoving, setIsMoving] = useState(false)
  const draggedDealRef = useRef<KanbanDeal | null>(null)

  const visibleStageSet = useMemo(() => {
    const normalized = (visibleStages ?? []).filter(Boolean).map(s => (typeof s === 'string' ? s.trim() : s)).filter(Boolean)
    if (normalized.length === 0) return new Set<string>(GHL_STAGE_ORDER as unknown as string[])
    return new Set<string>(normalized)
  }, [visibleStages])

  const { stageMap, unmapped, dedupedEntries, mappedCount } = useMemo(() => {
    const map = new Map<string, KanbanDeal[]>()
    const unm: KanbanDeal[] = []
    const seen = new Set<string>()

    for (const stage of GHL_STAGE_ORDER) {
      if (visibleStageSet.has(stage)) map.set(stage, [])
    }

    for (const entry of entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)

      const normalized = normalizeStage(entry.ghl_stage)
      if (normalized && map.has(normalized)) {
        map.get(normalized)!.push(entry)
        continue
      }
      if (showUnmapped) unm.push(entry)
    }

    const mapped = Array.from(map.values()).reduce((sum, list) => sum + list.length, 0)
    return { stageMap: map, unmapped: unm, dedupedEntries: seen.size, mappedCount: mapped }
  }, [entries, visibleStageSet, showUnmapped])

  const toggleCategory = (key: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const handleDragStart = useCallback((e: React.DragEvent, deal: KanbanDeal) => {
    draggedDealRef.current = deal
    setMovingDealId(deal.id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', deal.id)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, stage: string) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOverStage(stage)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverStage(null)
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent, targetStage: string) => {
    e.preventDefault()
    setDragOverStage(null)
    const deal = draggedDealRef.current
    draggedDealRef.current = null
    setMovingDealId(null)
    if (!deal || normalizeStage(deal.ghl_stage) === targetStage) return
    setIsMoving(true)
    try {
      await onStageChange(deal.id, targetStage, deal.ghl_stage)
    } finally {
      setIsMoving(false)
    }
  }, [onStageChange])

  const handleDragEnd = useCallback(() => {
    draggedDealRef.current = null
    setMovingDealId(null)
    setDragOverStage(null)
  }, [])

  const handleMoveConfirm = async () => {
    if (!moveDialogDeal || !selectedNewStage) return
    setIsMoving(true)
    try {
      await onStageChange(moveDialogDeal.id, selectedNewStage, moveDialogDeal.ghl_stage)
      setMoveDialogDeal(null)
      setSelectedNewStage('')
    } finally {
      setIsMoving(false)
    }
  }

  const unmappedCount = showUnmapped ? unmapped.length : 0

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center gap-4 text-sm text-slate-400 flex-wrap">
        <span className="bg-slate-800/60 px-3 py-1 rounded-full">{dedupedEntries} total</span>
        <span className="bg-slate-800/60 px-3 py-1 rounded-full">{mappedCount} mapped</span>
        {showUnmapped && unmapped.length > 0 && (
          <span className="bg-amber-900/30 text-amber-400 px-3 py-1 rounded-full">{unmapped.length} unmapped</span>
        )}
        {isMoving && (
          <span className="flex items-center gap-1.5 text-blue-400 bg-blue-900/30 px-3 py-1 rounded-full">
            <Loader2 className="w-3 h-3 animate-spin" />
            Moving...
          </span>
        )}
      </div>

      {/* Board */}
      <div className="overflow-x-auto pb-4 -mx-4 px-4">
        <div className="flex gap-4 min-w-max">
          {GHL_STAGE_CATEGORIES.map(cat => {
            const isCollapsed = collapsedCategories.has(cat.key)
            const catStages = cat.stages.filter(s => visibleStageSet.has(s))
            const catDeals = catStages.reduce((sum, stage) => sum + (stageMap.get(stage)?.length ?? 0), 0)

            // If this category has no visible stages under the current filter, skip it completely.
            if (catStages.length === 0) return null

            return (
              <div key={cat.key} className="flex flex-col shrink-0">
                {/* Category header */}
                <button
                  type="button"
                  onClick={() => toggleCategory(cat.key)}
                  className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold mb-2 transition-colors hover:brightness-110"
                  style={{ backgroundColor: cat.color + '18', border: `1px solid ${cat.color}40` }}
                >
                  {isCollapsed ? <ChevronRight className="w-4 h-4" style={{ color: cat.color }} /> : <ChevronDown className="w-4 h-4" style={{ color: cat.color }} />}
                  <span style={{ color: cat.color }}>{cat.label}</span>
                  <span
                    className="ml-auto text-xs font-bold rounded-full px-2 py-0.5"
                    style={{ backgroundColor: cat.color + '25', color: cat.color }}
                  >
                    {catDeals}
                  </span>
                </button>

                {/* Columns */}
                {!isCollapsed && (
                  <div className="flex gap-2">
                    {catStages.map(stage => {
                      const deals = stageMap.get(stage) ?? []
                      const isDragTarget = dragOverStage === stage
                      const color = getStageColor(stage)

                      return (
                        <div
                          key={stage}
                          className={cn(
                            'flex flex-col w-64 rounded-xl border transition-all',
                            isDragTarget
                              ? 'border-blue-400 bg-blue-500/5 shadow-lg shadow-blue-500/10'
                              : 'border-slate-800 bg-slate-900/60'
                          )}
                          onDragOver={(e) => handleDragOver(e, stage)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, stage)}
                        >
                          {/* Column header */}
                          <div className="px-3 py-2.5 border-b border-slate-800/60 flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                              <span className="text-xs font-semibold text-slate-300 truncate" title={stage}>
                                {stage}
                              </span>
                            </div>
                            <span
                              className="text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0"
                              style={{ backgroundColor: color + '20', color }}
                            >
                              {deals.length}
                            </span>
                          </div>

                          {/* Cards */}
                          <div className="flex-1 overflow-y-auto max-h-[calc(100vh-300px)] p-1.5 space-y-1.5 min-h-[60px]">
                            {deals.length === 0 ? (
                              <div className="flex items-center justify-center h-14 text-slate-700 text-xs">
                                Drop deals here
                              </div>
                            ) : (
                              deals.map((deal, idx) => (
                                <div
                                  key={`${deal.id}-${idx}`}
                                  draggable
                                  onDragStart={(e) => handleDragStart(e, deal)}
                                  onDragEnd={handleDragEnd}
                                  className={cn(
                                    'group rounded-lg p-3 cursor-grab active:cursor-grabbing transition-all',
                                    'bg-slate-950/80 border border-slate-800/60',
                                    'hover:border-slate-600 hover:bg-slate-900/80 hover:shadow-md',
                                    movingDealId === deal.id && 'opacity-40 scale-95'
                                  )}
                                >
                                  <div className="text-[13px] font-medium text-slate-100 leading-tight truncate">
                                    {deal.name || 'Unknown'}
                                  </div>

                                  <div className="mt-1.5 flex items-center gap-1.5">
                                    <FileText className="w-3 h-3 text-slate-600 shrink-0" />
                                    <span className="text-[11px] text-slate-500 font-mono truncate">{deal.policy_number}</span>
                                  </div>

                                  <div className="mt-1 flex items-center gap-1.5">
                                    <Building2 className="w-3 h-3 text-slate-600 shrink-0" />
                                    <span className="text-[11px] text-slate-500 truncate">{deal.carrier}</span>
                                  </div>

                                  {deal.carrier_status && (
                                    <div className="mt-1 text-[10px] text-slate-600 truncate italic" title={deal.carrier_status}>
                                      {deal.carrier_status}
                                    </div>
                                  )}

                                  <div className="mt-2 flex items-center justify-between">
                                    {deal.deal_value != null && deal.deal_value > 0 ? (
                                      <span className="text-[11px] font-semibold text-emerald-400">
                                        ${deal.deal_value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                      </span>
                                    ) : (
                                      <span />
                                    )}
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setMoveDialogDeal(deal)
                                        setSelectedNewStage('')
                                      }}
                                      className="flex items-center gap-1 text-[10px] text-slate-600 hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100"
                                    >
                                      Move <ArrowRight className="w-3 h-3" />
                                    </button>
                                  </div>

                                  {deal.sales_agent && (
                                    <div className="mt-1 flex items-center gap-1">
                                      <User className="w-3 h-3 text-slate-700 shrink-0" />
                                      <span className="text-[10px] text-slate-600 truncate">{deal.sales_agent}</span>
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {isCollapsed && (
                  <div
                    className="w-12 rounded-lg border border-slate-800 flex items-center justify-center py-4 cursor-pointer hover:border-slate-600 transition-colors"
                    style={{ backgroundColor: cat.color + '08' }}
                    onClick={() => toggleCategory(cat.key)}
                  >
                    <span className="text-xs font-bold" style={{ color: cat.color, writingMode: 'vertical-lr' }}>
                      {cat.label} ({catDeals})
                    </span>
                  </div>
                )}
              </div>
            )
          })}

          {/* Unmapped */}
          {showUnmapped && unmappedCount > 0 && (
            <div className="flex flex-col shrink-0">
              <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold mb-2 bg-amber-500/10 border border-amber-500/30">
                <span className="text-amber-400">Unmapped</span>
                <span className="ml-auto text-xs font-bold rounded-full px-2 py-0.5 bg-amber-500/20 text-amber-400">
                  {unmappedCount}
                </span>
              </div>
              <div className="flex flex-col w-64 rounded-xl border border-slate-800 bg-slate-900/60">
                <div className="flex-1 overflow-y-auto max-h-[calc(100vh-300px)] p-1.5 space-y-1.5">
                  {unmapped.map((deal, idx) => (
                    <div
                      key={`unmapped-${deal.id}-${idx}`}
                      className="group rounded-lg p-3 bg-slate-950/80 border border-slate-800/60 hover:border-amber-800/40 transition-all"
                    >
                      <div className="text-[13px] font-medium text-slate-100 truncate">
                        {deal.name || 'Unknown'}
                      </div>
                      <div className="mt-1 text-[11px] text-slate-500 font-mono truncate">{deal.policy_number}</div>
                      <div className="mt-0.5 text-[11px] text-slate-500 truncate">{deal.carrier}</div>
                      {deal.ghl_stage && (
                        <div className="mt-1.5 text-[10px] text-amber-500/80 bg-amber-500/10 rounded px-1.5 py-0.5 inline-block truncate max-w-full">
                          {deal.ghl_stage}
                        </div>
                      )}
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setMoveDialogDeal(deal)
                            setSelectedNewStage('')
                          }}
                          className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
                        >
                          Assign Stage <ArrowRight className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Move dialog */}
      {moveDialogDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { setMoveDialogDeal(null); setSelectedNewStage('') }}>
          <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-white mb-1">Move Deal</h3>
            <p className="text-sm text-slate-400 mb-4">
              <span className="text-slate-200 font-medium">{moveDialogDeal.name || 'Unknown'}</span>
              {' '}
              <span className="text-slate-500 font-mono text-xs">({moveDialogDeal.policy_number})</span>
            </p>

            <div className="mb-3">
              <label className="text-xs text-slate-500 block mb-1 uppercase tracking-wider">Current Stage</label>
              <div className="px-3 py-2 bg-slate-950 rounded-lg text-sm text-slate-300 border border-slate-800">
                {moveDialogDeal.ghl_stage || 'None'}
              </div>
            </div>

            <div className="mb-6">
              <label className="text-xs text-slate-500 block mb-1 uppercase tracking-wider">Move to</label>
              <Select value={selectedNewStage} onValueChange={setSelectedNewStage}>
                <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                  <SelectValue placeholder="Select stage..." />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700 max-h-80">
                  {GHL_STAGE_CATEGORIES.map(cat => (
                    <div key={cat.key}>
                      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: cat.color }}>
                        {cat.label}
                      </div>
                      {cat.stages.map(stage => (
                        <SelectItem
                          key={stage}
                          value={stage}
                          className="text-white"
                          disabled={stage === moveDialogDeal.ghl_stage}
                        >
                          {stage}
                        </SelectItem>
                      ))}
                    </div>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-end gap-3">
              <Button
                variant="ghost"
                size="sm"
                className="text-slate-400 hover:text-white"
                onClick={() => { setMoveDialogDeal(null); setSelectedNewStage('') }}
                disabled={isMoving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 hover:bg-blue-500 text-white"
                onClick={handleMoveConfirm}
                disabled={!selectedNewStage || isMoving}
              >
                {isMoving ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                    Moving...
                  </>
                ) : (
                  'Move Deal'
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
