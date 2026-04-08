'use client'

import { useState, useRef, useCallback, useMemo, useEffect } from 'react'
import { GHL_STAGE_ORDER, GHL_STAGE_CATEGORIES, getStageColor } from '@/lib/ghlStageResolver'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { adminSelectContent, adminSelectItem, adminSelectTrigger } from '@/lib/adminFieldClasses'
import { User, FileText, Building2, Loader2, ArrowRight } from 'lucide-react'

const UNMAPPED_SECTION = '__unmapped__'

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
  /**
   * When the filter card is locked to one GHL lane, the board stays on that section
   * and section tabs are read-only.
   */
  lockedCategoryKey?: string | null
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

export default function GhlKanbanBoard({
  entries,
  onStageChange,
  visibleStages,
  showUnmapped = true,
  lockedCategoryKey = null,
}: GhlKanbanBoardProps) {
  const [activeSectionKey, setActiveSectionKey] = useState<string>(GHL_STAGE_CATEGORIES[0]?.key ?? 'pending')
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

  const sectionKeysToShow = useMemo(
    () =>
      GHL_STAGE_CATEGORIES.filter((cat) => cat.stages.some((s) => visibleStageSet.has(s))).map((c) => c.key),
    [visibleStageSet]
  )

  const displaySection =
    lockedCategoryKey && sectionKeysToShow.includes(lockedCategoryKey)
      ? lockedCategoryKey
      : activeSectionKey

  useEffect(() => {
    if (lockedCategoryKey && sectionKeysToShow.includes(lockedCategoryKey)) return
    if (activeSectionKey === UNMAPPED_SECTION) return
    if (sectionKeysToShow.length > 0 && !sectionKeysToShow.includes(activeSectionKey)) {
      setActiveSectionKey(sectionKeysToShow[0])
    }
  }, [activeSectionKey, lockedCategoryKey, sectionKeysToShow])

  useEffect(() => {
    if (activeSectionKey === UNMAPPED_SECTION && (!showUnmapped || unmapped.length === 0)) {
      setActiveSectionKey(sectionKeysToShow[0] ?? GHL_STAGE_CATEGORIES[0]?.key ?? 'pending')
    }
  }, [activeSectionKey, showUnmapped, unmapped.length, sectionKeysToShow])

  const selectSection = (key: string) => {
    if (lockedCategoryKey) return
    setActiveSectionKey(key)
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
      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
        <span className="rounded-full bg-muted px-3 py-1 text-foreground/90 dark:bg-slate-800/60 dark:text-slate-300">
          {dedupedEntries} total
        </span>
        <span className="rounded-full bg-muted px-3 py-1 text-foreground/90 dark:bg-slate-800/60 dark:text-slate-300">
          {mappedCount} mapped
        </span>
        {showUnmapped && unmapped.length > 0 && (
          <span className="bg-amber-900/30 text-amber-400 px-3 py-1 rounded-full">{unmapped.length} unmapped</span>
        )}
        {isMoving && (
          <span className="flex items-center gap-1.5 rounded-full bg-blue-100 px-3 py-1 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400">
            <Loader2 className="h-3 w-3 animate-spin" />
            Moving...
          </span>
        )}
      </div>

      {/* Board — one GHL section at a time */}
      <div className="rounded-xl border border-border bg-card/60 p-4 ring-1 ring-black/[0.03] dark:border-slate-800/80 dark:bg-slate-900/40 dark:ring-white/[0.03]">
        <div className="mb-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Board section</p>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
            {lockedCategoryKey
              ? 'This lane is fixed by the “GHL lane” filter above. Clear that filter to switch sections here.'
              : 'Pick one lane at a time. Stage columns stretch across the width; lists scroll inside each column.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sectionKeysToShow.map((key) => {
            const cat = GHL_STAGE_CATEGORIES.find((c) => c.key === key)!
            const catStages = cat.stages.filter((s) => visibleStageSet.has(s))
            const catDeals = catStages.reduce((sum, stage) => sum + (stageMap.get(stage)?.length ?? 0), 0)
            const isActive = displaySection === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => selectSection(key)}
                disabled={!!lockedCategoryKey}
                className={cn(
                  'flex min-w-0 max-w-full items-center gap-2 rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-all sm:max-w-none',
                  isActive
                    ? 'border-orange-500/45 bg-orange-500/12 text-foreground shadow-lg shadow-black/10 dark:text-white dark:shadow-black/25'
                    : 'border-border bg-muted/70 text-muted-foreground hover:border-orange-500/20 hover:bg-muted hover:text-foreground dark:border-slate-700/90 dark:bg-slate-950/60 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:bg-slate-900 dark:hover:text-slate-200',
                  lockedCategoryKey && 'cursor-not-allowed opacity-95'
                )}
              >
                <span className="min-w-0 truncate" style={{ color: isActive ? cat.color : undefined }}>
                  {cat.label}
                </span>
                <span
                  className={cn(
                    'ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] tabular-nums',
                    !isActive && 'bg-muted text-muted-foreground dark:bg-slate-700/75 dark:text-slate-300'
                  )}
                  style={{
                    backgroundColor: isActive ? `${cat.color}33` : undefined,
                    color: isActive ? cat.color : undefined,
                  }}
                >
                  {catDeals}
                </span>
              </button>
            )
          })}
          {showUnmapped && unmappedCount > 0 && (
            <button
              type="button"
              onClick={() => selectSection(UNMAPPED_SECTION)}
              disabled={!!lockedCategoryKey}
              className={cn(
                'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-all',
                displaySection === UNMAPPED_SECTION
                  ? 'border-amber-500/45 bg-amber-500/12 text-amber-900 shadow-lg shadow-black/10 dark:text-amber-100 dark:shadow-black/25'
                  : 'border-border bg-muted/70 text-muted-foreground hover:border-amber-500/25 hover:text-foreground dark:border-slate-700/90 dark:bg-slate-950/60 dark:text-slate-400 dark:hover:border-slate-600 dark:hover:text-slate-200',
                lockedCategoryKey && 'cursor-not-allowed opacity-50'
              )}
            >
              Unmapped
              <span className="ml-auto rounded-full bg-amber-500/25 px-2 py-0.5 text-[11px] tabular-nums text-amber-900 dark:text-amber-200">
                {unmappedCount}
              </span>
            </button>
          )}
        </div>
      </div>

      <div className="w-full min-w-0 pt-1">
        {displaySection === UNMAPPED_SECTION && showUnmapped && unmappedCount > 0 ? (
          <div className="flex flex-col overflow-hidden rounded-xl border border-amber-500/25 bg-amber-50/40 dark:border-amber-500/20 dark:bg-slate-900/50">
            <div className="flex items-center justify-between border-b border-border px-4 py-3 dark:border-slate-800/80">
              <span className="text-sm font-semibold text-amber-800 dark:text-amber-400">Unmapped deals</span>
              <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-bold text-amber-900 dark:text-amber-300">
                {unmappedCount}
              </span>
            </div>
            <div className="max-h-[min(32rem,calc(100vh-22rem))] overflow-y-auto p-3">
              <div className="mx-auto grid max-w-5xl gap-2">
                {unmapped.map((deal, idx) => (
                  <div
                    key={`unmapped-${deal.id}-${idx}`}
                    className="group rounded-lg border border-border bg-card p-3 transition-all hover:border-amber-500/35 dark:border-slate-800/60 dark:bg-slate-950/80 dark:hover:border-amber-800/40"
                  >
                    <div className="truncate text-[13px] font-medium text-foreground dark:text-slate-100">
                      {deal.name || 'Unknown'}
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{deal.policy_number}</div>
                    <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{deal.carrier}</div>
                    {deal.ghl_stage && (
                      <div className="mt-1.5 inline-block max-w-full truncate rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500/80">
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
                        className="flex items-center gap-1 text-[10px] text-muted-foreground transition-colors hover:text-blue-600 dark:hover:text-blue-400"
                      >
                        Assign Stage <ArrowRight className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          (() => {
            const cat = GHL_STAGE_CATEGORIES.find((c) => c.key === displaySection)
            if (!cat) {
              return (
                <div className="rounded-xl border border-border bg-muted/40 py-12 text-center text-sm text-muted-foreground dark:border-slate-800 dark:bg-slate-900/40">
                  No section to show — adjust filters above.
                </div>
              )
            }
            const catStages = cat.stages.filter((s) => visibleStageSet.has(s))
            if (catStages.length === 0) {
              return (
                <div className="rounded-xl border border-border bg-muted/40 py-12 text-center text-sm text-muted-foreground dark:border-slate-800 dark:bg-slate-900/40">
                  No stages visible for this section with current filters.
                </div>
              )
            }
            return (
              <div
                className="grid w-full gap-3"
                style={{
                  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 17rem), 1fr))',
                }}
              >
                {catStages.map((stage) => {
                  const deals = stageMap.get(stage) ?? []
                  const isDragTarget = dragOverStage === stage
                  const color = getStageColor(stage)
                  return (
                    <div
                      key={stage}
                      className={cn(
                        'flex min-w-0 flex-col rounded-xl border border-border bg-muted/40 transition-all dark:border-slate-800 dark:bg-slate-900/60',
                        isDragTarget &&
                          'border-blue-400 bg-blue-500/5 shadow-lg shadow-blue-500/10 dark:bg-slate-900/50'
                      )}
                      onDragOver={(e) => handleDragOver(e, stage)}
                      onDragLeave={handleDragLeave}
                      onDrop={(e) => handleDrop(e, stage)}
                    >
                      <div className="flex items-center justify-between border-b border-border px-3 py-2.5 dark:border-slate-800/60">
                        <div className="flex min-w-0 items-center gap-2">
                          <div className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                          <span className="truncate text-xs font-semibold text-foreground dark:text-slate-300" title={stage}>
                            {stage}
                          </span>
                        </div>
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold"
                          style={{ backgroundColor: color + '20', color }}
                        >
                          {deals.length}
                        </span>
                      </div>
                      <div
                        className={cn(
                          'min-h-[80px] flex-1 space-y-1.5 overflow-y-auto p-1.5',
                          'max-h-[min(32rem,calc(100vh-22rem))]'
                        )}
                      >
                        {deals.length === 0 ? (
                          <div className="flex h-14 items-center justify-center text-xs text-muted-foreground">Drop deals here</div>
                        ) : (
                          deals.map((deal, idx) => (
                            <div
                              key={`${deal.id}-${idx}`}
                              draggable
                              onDragStart={(e) => handleDragStart(e, deal)}
                              onDragEnd={handleDragEnd}
                              className={cn(
                                'group cursor-grab rounded-lg border border-border bg-card p-3 transition-all active:cursor-grabbing dark:border-slate-800/60 dark:bg-slate-950/80',
                                'hover:border-border hover:shadow-md dark:hover:border-slate-600 dark:hover:bg-slate-900/80',
                                movingDealId === deal.id && 'scale-95 opacity-40'
                              )}
                            >
                              <div className="truncate text-[13px] font-medium leading-tight text-foreground dark:text-slate-100">{deal.name || 'Unknown'}</div>
                              <div className="mt-1.5 flex items-center gap-1.5">
                                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="truncate font-mono text-[11px] text-muted-foreground">{deal.policy_number}</span>
                              </div>
                              <div className="mt-1 flex items-center gap-1.5">
                                <Building2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="truncate text-[11px] text-muted-foreground">{deal.carrier}</span>
                              </div>
                              {deal.carrier_status && (
                                <div className="mt-1 truncate text-[10px] italic text-muted-foreground" title={deal.carrier_status}>
                                  {deal.carrier_status}
                                </div>
                              )}
                              <div className="mt-2 flex items-center justify-between">
                                {deal.deal_value != null && deal.deal_value > 0 ? (
                                  <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
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
                                  className="flex items-center gap-1 text-[10px] text-muted-foreground opacity-0 transition-colors hover:text-blue-600 group-hover:opacity-100 dark:hover:text-blue-400"
                                >
                                  Move <ArrowRight className="h-3 w-3" />
                                </button>
                              </div>
                              {deal.sales_agent && (
                                <div className="mt-1 flex items-center gap-1">
                                  <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <span className="truncate text-[10px] text-muted-foreground">{deal.sales_agent}</span>
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
            )
          })()
        )}
      </div>

      {/* Move dialog */}
      {moveDialogDeal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { setMoveDialogDeal(null); setSelectedNewStage('') }}>
          <div className="w-full max-w-md rounded-xl border border-border bg-background p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="mb-1 text-lg font-semibold text-foreground">Move Deal</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{moveDialogDeal.name || 'Unknown'}</span>
              {' '}
              <span className="font-mono text-xs text-muted-foreground">({moveDialogDeal.policy_number})</span>
            </p>

            <div className="mb-3">
              <label className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">Current Stage</label>
              <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground dark:border-slate-800 dark:bg-slate-950 dark:text-slate-300">
                {moveDialogDeal.ghl_stage || 'None'}
              </div>
            </div>

            <div className="mb-6">
              <label className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">Move to</label>
              <Select value={selectedNewStage} onValueChange={setSelectedNewStage}>
                <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                  <SelectValue placeholder="Select stage..." />
                </SelectTrigger>
                <SelectContent className={cn(adminSelectContent, 'max-h-80')}>
                  {GHL_STAGE_CATEGORIES.map(cat => (
                    <div key={cat.key}>
                      <div className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider" style={{ color: cat.color }}>
                        {cat.label}
                      </div>
                      {cat.stages.map(stage => (
                        <SelectItem
                          key={stage}
                          value={stage}
                          className={adminSelectItem}
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
                className="text-muted-foreground hover:text-foreground"
                onClick={() => { setMoveDialogDeal(null); setSelectedNewStage('') }}
                disabled={isMoving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-blue-600 text-white hover:bg-blue-500"
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
