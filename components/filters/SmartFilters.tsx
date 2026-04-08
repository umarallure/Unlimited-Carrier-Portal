'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronRight, SlidersHorizontal, X } from 'lucide-react'
import {
  DATE_PRESET_DEFS,
  applyDatePreset,
  matchesPreset,
  type DatePresetId,
} from '@/lib/dateFilterPresets'

export function FilterPresetChip({
  children,
  active,
  onClick,
  title,
  className,
}: {
  children: React.ReactNode
  active?: boolean
  onClick: () => void
  title?: string
  className?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-semibold tracking-wide transition-all shrink-0',
        active
          ? 'border-orange-400/50 bg-gradient-to-b from-orange-500/25 to-orange-600/15 text-orange-950 shadow-[0_0_20px_-4px_rgba(251,146,60,0.45)] dark:text-orange-50'
          : 'border-border bg-muted/80 text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground dark:border-slate-600/80 dark:bg-slate-900/80 dark:text-slate-400 dark:hover:border-slate-500 dark:hover:bg-slate-800/90 dark:hover:text-white',
        className
      )}
    >
      {children}
    </button>
  )
}

export function QuickDateRangeChips({
  dateFrom,
  dateTo,
  onRangeChange,
  className,
}: {
  dateFrom: string
  dateTo: string
  onRangeChange: (from: string, to: string) => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="mr-0.5 w-full text-[11px] font-medium uppercase tracking-wide text-muted-foreground sm:w-auto">
        Quick range
      </span>
      {DATE_PRESET_DEFS.map(({ id, label, hint }) => (
        <FilterPresetChip
          key={id}
          title={hint}
          active={matchesPreset(dateFrom, dateTo, id)}
          onClick={() => {
            const r = applyDatePreset(id)
            onRangeChange(r.from, r.to)
          }}
        >
          {label}
        </FilterPresetChip>
      ))}
      <FilterPresetChip
        active={!dateFrom && !dateTo}
        onClick={() => onRangeChange('', '')}
        title="Clear date filter"
      >
        Any
      </FilterPresetChip>
    </div>
  )
}

export type ActiveChip = { key: string; label: string; onRemove: () => void }

export function ActiveFilterChips({ items, className }: { items: ActiveChip[]; className?: string }) {
  if (!items.length) return null
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Active</span>
      {items.map((it) => (
        <Badge
          key={it.key}
          variant="secondary"
          className="gap-1 border border-border bg-muted pl-2 pr-1 py-1 font-normal text-foreground hover:bg-muted/80 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
        >
          <span className="max-w-[220px] truncate">{it.label}</span>
          <button
            type="button"
            onClick={it.onRemove}
            className="rounded p-0.5 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-600 dark:hover:text-white"
            aria-label={`Remove filter ${it.label}`}
          >
            <X className="w-3 h-3" />
          </button>
        </Badge>
      ))}
    </div>
  )
}

export function CollapsibleFilterSection({
  title,
  defaultOpen = false,
  activeSubCount = 0,
  children,
}: {
  title: string
  defaultOpen?: boolean
  /** Shown as a small count badge when &gt; 0 */
  activeSubCount?: number
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-muted/30 shadow-inner ring-1 ring-black/[0.03] dark:border-slate-800/80 dark:bg-slate-950/40 dark:shadow-black/20 dark:ring-white/[0.03]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-sm text-foreground transition-colors hover:bg-muted/80 dark:text-slate-200 dark:hover:bg-slate-900/70"
      >
        <span className="flex items-center gap-2 min-w-0">
          <SlidersHorizontal className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="font-medium truncate">{title}</span>
          {activeSubCount > 0 && (
            <span className="rounded-full bg-orange-500/20 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-orange-900 dark:bg-orange-500/25 dark:text-orange-200">
              {activeSubCount}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="w-4 h-4 text-slate-500 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
        )}
      </button>
      {open && <div className="space-y-4 border-t border-border px-4 py-4 dark:border-slate-800/80">{children}</div>}
    </div>
  )
}

export function FilterBarHeader({
  title,
  description,
  activeCount,
  onClearAll,
  className,
}: {
  title: string
  description?: string
  activeCount: number
  onClearAll?: () => void
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">{title}</h2>
          {activeCount > 0 && (
            <span className="rounded-full border border-orange-500/30 bg-orange-500/15 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-orange-900 dark:text-orange-100">
              {activeCount} active
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      {activeCount > 0 && onClearAll && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onClearAll}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="w-4 h-4 mr-1.5" />
          Reset all
        </Button>
      )}
    </div>
  )
}

export { DATE_PRESET_DEFS, applyDatePreset, matchesPreset, type DatePresetId }
