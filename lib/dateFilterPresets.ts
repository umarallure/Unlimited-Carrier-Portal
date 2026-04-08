/**
 * Local-calendar date presets for admin filter bars (YYYY-MM-DD).
 */

export type DatePresetId = '7d' | '30d' | 'mtd' | 'qtd' | 'ytd'

export const DATE_PRESET_DEFS: { id: DatePresetId; label: string; hint?: string }[] = [
  { id: '7d', label: '7 days', hint: 'Last 7 days including today' },
  { id: '30d', label: '30 days', hint: 'Last 30 days including today' },
  { id: 'mtd', label: 'Month', hint: 'Start of this month through today' },
  { id: 'qtd', label: 'Quarter', hint: 'Start of this quarter through today' },
  { id: 'ytd', label: 'YTD', hint: 'Jan 1 through today' },
]

export function toYmdLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function startOfQuarter(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3)
  return new Date(d.getFullYear(), q * 3, 1)
}

function startOfYear(d: Date): Date {
  return new Date(d.getFullYear(), 0, 1)
}

export function applyDatePreset(id: DatePresetId, now: Date = new Date()): { from: string; to: string } {
  const today = toYmdLocal(now)
  if (id === '7d') {
    const t = new Date(now)
    t.setDate(t.getDate() - 6)
    return { from: toYmdLocal(t), to: today }
  }
  if (id === '30d') {
    const t = new Date(now)
    t.setDate(t.getDate() - 29)
    return { from: toYmdLocal(t), to: today }
  }
  if (id === 'mtd') return { from: toYmdLocal(startOfMonth(now)), to: today }
  if (id === 'qtd') return { from: toYmdLocal(startOfQuarter(now)), to: today }
  if (id === 'ytd') return { from: toYmdLocal(startOfYear(now)), to: today }
  return { from: '', to: '' }
}

/** Returns true if current [from,to] matches this preset (for highlighting). */
export function matchesPreset(
  from: string,
  to: string,
  id: DatePresetId,
  now: Date = new Date()
): boolean {
  if (!from || !to) return false
  const p = applyDatePreset(id, now)
  return p.from === from && p.to === to
}
