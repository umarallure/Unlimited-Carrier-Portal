'use client'

import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

type MultiSelectFilterProps = {
  /** Used for the search placeholder text. */
  label?: string
  options: string[]
  selected: string[]
  onChange: (next: string[]) => void
  /** Text shown on the trigger when nothing is selected. */
  allLabel?: string
  className?: string
  triggerClassName?: string
}

/**
 * Searchable, checkbox multi-select dropdown (mirrors the deal-tracker filter).
 * Selection is owned by the parent via `selected` / `onChange`.
 */
export function MultiSelectFilter({
  label,
  options,
  selected,
  onChange,
  allLabel = 'All',
  className,
  triggerClassName,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (rootRef.current && target && !rootRef.current.contains(target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  const visibleOptions = options.filter((opt) => opt.toLowerCase().includes(search.toLowerCase()))

  const toggle = (option: string) => {
    onChange(selected.includes(option) ? selected.filter((v) => v !== option) : [...selected, option])
  }

  const selectedLabel =
    selected.length === 0 ? allLabel : selected.length === 1 ? selected[0] : `${selected.length} selected`

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'group flex h-9 min-w-[260px] items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors',
          'bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100',
          open
            ? 'border-orange-500/60 ring-2 ring-orange-500/15'
            : 'border-slate-300 hover:border-slate-400 dark:border-slate-700 dark:hover:border-slate-600',
          triggerClassName,
        )}
      >
        <span className={cn('flex-1 truncate text-[13px]', selected.length === 0 && 'text-muted-foreground')}>
          {selectedLabel}
        </span>
        {selected.length > 0 ? (
          <span
            role="button"
            tabIndex={0}
            aria-label="Clear selection"
            onClick={(e) => {
              e.stopPropagation()
              onChange([])
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                onChange([])
              }
            }}
            className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </span>
        ) : null}
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </button>

      {open ? (
        <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[260px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/20 dark:border-slate-700 dark:bg-slate-900">
          <div className="sticky top-0 z-10 border-b border-border/60 bg-popover/95 p-2 backdrop-blur dark:bg-slate-900/95">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={label ? `Search ${label.toLowerCase()}…` : 'Search…'}
                className="h-8 pl-7 text-xs"
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <button
                type="button"
                className="font-medium text-orange-500 hover:text-orange-400"
                onClick={() => onChange(Array.from(new Set([...selected, ...(search ? visibleOptions : options)])))}
              >
                {search ? 'Select shown' : 'Select all'}
              </button>
              <button
                type="button"
                className="font-medium text-muted-foreground hover:text-foreground"
                onClick={() => onChange([])}
              >
                Clear
              </button>
            </div>
          </div>

          <div className="max-h-64 overflow-auto p-1">
            {visibleOptions.map((opt) => {
              const active = selected.includes(opt)
              return (
                <button
                  key={opt}
                  type="button"
                  onClick={() => toggle(opt)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors',
                    active ? 'bg-orange-500/12 text-foreground' : 'text-foreground/85 hover:bg-muted/70',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                      active
                        ? 'border-orange-500 bg-orange-500 text-white'
                        : 'border-border bg-background text-transparent',
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="flex-1 truncate">{opt}</span>
                </button>
              )
            })}
            {visibleOptions.length === 0 ? (
              <div className="px-2 py-8 text-center text-xs text-muted-foreground">No matches</div>
            ) : null}
          </div>

          <div className="flex items-center justify-between border-t border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground dark:bg-slate-950/40">
            <span>
              {selected.length === 0 ? 'No selection' : `${selected.length} of ${options.length} selected`}
            </span>
            <button
              type="button"
              className="font-medium text-foreground hover:text-orange-500"
              onClick={() => setOpen(false)}
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
