/**
 * Escrow ledger, summarised two ways: by invoice cycle and by center.
 *
 * Pure — no Supabase, no React — so the arithmetic that decides what is held can
 * be unit tested. The page passes in the raw ledger rows; everything below is
 * derived from them.
 *
 * The ledger is append-only. Un-paying an invoice does not delete its entries, it
 * adds a `reversal` that cancels one out. So "what is held now" is the SUM of
 * every row, never a count of holds, and a cycle that was paid and then un-paid
 * nets to zero rather than disappearing.
 */

export type EscrowEntryType =
  | 'opening_transfer'
  | 'hold'
  | 'draw'
  | 'release'
  | 'applied_to_chargeback'
  | 'reversal'
  | 'adjustment'

export type EscrowLedgerEntry = {
  id: string
  call_center: string
  entry_type: EscrowEntryType | string
  /** Signed: positive moves money INTO escrow, negative takes it out. */
  amount: number | string
  balance_after: number | string
  cycle_start_date: string | null
  cycle_end_date: string | null
  invoicing_batch_id: string | null
  reverses_entry_id?: string | null
  basis?: string | null
  memo: string | null
  created_by_email: string | null
  created_at: string
}

export type EscrowCycleCenterRow = {
  callCenter: string
  /** Money moved in because earlier commissions had never been invoiced. */
  openingTransfer: number
  /** The holdback taken from this cycle's payout. */
  hold: number
  /** Taken out: draws, releases, chargebacks covered. Zero or negative. */
  outflow: number
  /** Cancelled entries, from an invoice being marked unpaid. */
  reversed: number
  /** Everything above, i.e. what this cycle changed the balance by. */
  net: number
  entryCount: number
}

export type EscrowCycleRow = {
  /** `${start}..${end}`, or 'unassigned' for entries with no cycle. */
  key: string
  cycleStart: string | null
  cycleEnd: string | null
  centers: EscrowCycleCenterRow[]
  openingTransfer: number
  hold: number
  outflow: number
  reversed: number
  net: number
  /** Total held across all centers once this cycle had been applied. */
  runningTotal: number
  entryCount: number
}

export type EscrowCenterRow = {
  callCenter: string
  balance: number
  openingTransfer: number
  hold: number
  outflow: number
  reversed: number
  entryCount: number
  lastEntryAt: string | null
  cyclesContributed: number
}

export type EscrowTotals = {
  /** The headline: what is held across every center right now. */
  heldNow: number
  /** Everything ever moved in, before anything was taken out or cancelled. */
  everIn: number
  /** Everything taken out through draws, releases and chargebacks. */
  everOut: number
  /** Cancelled by an invoice being marked unpaid. */
  everReversed: number
  centersWithBalance: number
  cycleCount: number
  entryCount: number
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

export function cycleKey(entry: EscrowLedgerEntry): string {
  if (!entry.cycle_start_date || !entry.cycle_end_date) return 'unassigned'
  return `${entry.cycle_start_date}..${entry.cycle_end_date}`
}

/** Label a cycle the way the invoice screen does: "Sep 30 – Oct 13, 2026". */
export function formatCycleLabel(start: string | null, end: string | null): string {
  if (!start || !end) return 'No cycle recorded'
  const parse = (ymd: string) => {
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null
  }
  const a = parse(start)
  const b = parse(end)
  if (!a || !b) return `${start} – ${end}`
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const left = `${MONTHS[a.m - 1]} ${a.d}`
  const right = `${MONTHS[b.m - 1]} ${b.d}`
  return a.y === b.y ? `${left} – ${right}, ${b.y}` : `${left}, ${a.y} – ${right}, ${b.y}`
}

type Buckets = { openingTransfer: number; hold: number; outflow: number; reversed: number; entryCount: number }

function emptyBuckets(): Buckets {
  return { openingTransfer: 0, hold: 0, outflow: 0, reversed: 0, entryCount: 0 }
}

/**
 * Put one entry into the right bucket.
 *
 * A reversal is kept separate rather than folded into the inflows it cancels:
 * showing a cycle as "held 8,528.55, reversed -8,528.55" says what happened,
 * where a bare net of zero would look like nothing ever did.
 */
function addToBuckets(buckets: Buckets, entry: EscrowLedgerEntry): void {
  const amount = num(entry.amount)
  buckets.entryCount += 1
  if (entry.entry_type === 'reversal') buckets.reversed += amount
  else if (entry.entry_type === 'opening_transfer') buckets.openingTransfer += amount
  else if (entry.entry_type === 'hold') buckets.hold += amount
  else if (amount >= 0) buckets.hold += amount
  else buckets.outflow += amount
}

function bucketsNet(b: Buckets): number {
  return round2(b.openingTransfer + b.hold + b.outflow + b.reversed)
}

/**
 * One row per invoice cycle, newest first, each carrying the total held across
 * all centers as at the end of that cycle.
 *
 * Entries with no cycle recorded (a manual adjustment, say) are collected under a
 * single 'unassigned' row rather than dropped, so the rows always add up to the
 * balance.
 */
export function buildCycleRows(entries: EscrowLedgerEntry[]): EscrowCycleRow[] {
  const byCycle = new Map<string, { start: string | null; end: string | null; total: Buckets; centers: Map<string, Buckets> }>()

  for (const entry of entries) {
    const key = cycleKey(entry)
    let cycle = byCycle.get(key)
    if (!cycle) {
      cycle = { start: entry.cycle_start_date, end: entry.cycle_end_date, total: emptyBuckets(), centers: new Map() }
      byCycle.set(key, cycle)
    }
    addToBuckets(cycle.total, entry)
    const center = cycle.centers.get(entry.call_center) ?? emptyBuckets()
    addToBuckets(center, entry)
    cycle.centers.set(entry.call_center, center)
  }

  const rows: EscrowCycleRow[] = Array.from(byCycle.entries()).map(([key, cycle]) => ({
    key,
    cycleStart: cycle.start,
    cycleEnd: cycle.end,
    centers: Array.from(cycle.centers.entries())
      .map(([callCenter, b]) => ({
        callCenter,
        openingTransfer: round2(b.openingTransfer),
        hold: round2(b.hold),
        outflow: round2(b.outflow),
        reversed: round2(b.reversed),
        net: bucketsNet(b),
        entryCount: b.entryCount,
      }))
      .sort((a, b) => b.net - a.net || a.callCenter.localeCompare(b.callCenter)),
    openingTransfer: round2(cycle.total.openingTransfer),
    hold: round2(cycle.total.hold),
    outflow: round2(cycle.total.outflow),
    reversed: round2(cycle.total.reversed),
    net: bucketsNet(cycle.total),
    runningTotal: 0,
    entryCount: cycle.total.entryCount,
  }))

  // Oldest first to accumulate, then flip so the newest cycle reads at the top.
  // Entries with no cycle sort last on the way up, so they never shift the
  // running total of a dated cycle.
  rows.sort((a, b) => {
    if (a.cycleEnd && b.cycleEnd) return a.cycleEnd.localeCompare(b.cycleEnd)
    if (a.cycleEnd) return -1
    if (b.cycleEnd) return 1
    return 0
  })
  let running = 0
  for (const row of rows) {
    running = round2(running + row.net)
    row.runningTotal = running
  }
  rows.reverse()
  return rows
}

/** One row per center: what it holds now and how it got there. */
export function buildCenterRows(entries: EscrowLedgerEntry[]): EscrowCenterRow[] {
  const byCenter = new Map<string, { b: Buckets; last: string | null; cycles: Set<string> }>()

  for (const entry of entries) {
    let center = byCenter.get(entry.call_center)
    if (!center) {
      center = { b: emptyBuckets(), last: null, cycles: new Set() }
      byCenter.set(entry.call_center, center)
    }
    addToBuckets(center.b, entry)
    if (!center.last || entry.created_at > center.last) center.last = entry.created_at
    const key = cycleKey(entry)
    if (key !== 'unassigned') center.cycles.add(key)
  }

  return Array.from(byCenter.entries())
    .map(([callCenter, c]) => ({
      callCenter,
      balance: bucketsNet(c.b),
      openingTransfer: round2(c.b.openingTransfer),
      hold: round2(c.b.hold),
      outflow: round2(c.b.outflow),
      reversed: round2(c.b.reversed),
      entryCount: c.b.entryCount,
      lastEntryAt: c.last,
      cyclesContributed: c.cycles.size,
    }))
    .sort((a, b) => b.balance - a.balance || a.callCenter.localeCompare(b.callCenter))
}

export function buildTotals(entries: EscrowLedgerEntry[]): EscrowTotals {
  const all = emptyBuckets()
  const cycles = new Set<string>()
  for (const entry of entries) {
    addToBuckets(all, entry)
    cycles.add(cycleKey(entry))
  }
  const centers = buildCenterRows(entries)
  return {
    heldNow: bucketsNet(all),
    everIn: round2(all.openingTransfer + all.hold),
    everOut: round2(all.outflow),
    everReversed: round2(all.reversed),
    // A center whose balance has gone back to zero is not currently holding
    // anything, so it does not count towards this.
    centersWithBalance: centers.filter((c) => Math.abs(c.balance) >= 0.01).length,
    cycleCount: cycles.size,
    entryCount: all.entryCount,
  }
}

/** CSV of the per-cycle, per-center breakdown, for Accounting. */
export const ESCROW_EXPORT_HEADERS = [
  'Cycle Start',
  'Cycle End',
  'Cycle',
  'Call Center',
  'Earlier Deals To Escrow',
  'Holdback',
  'Taken Out',
  'Reversed',
  'Net This Cycle',
  'Entries',
] as const

export function cycleRowsToCsv(rows: EscrowCycleRow[]): string {
  const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const lines = [ESCROW_EXPORT_HEADERS.join(',')]
  for (const row of rows) {
    for (const center of row.centers) {
      lines.push(
        [
          row.cycleStart ?? '',
          row.cycleEnd ?? '',
          formatCycleLabel(row.cycleStart, row.cycleEnd),
          center.callCenter,
          center.openingTransfer.toFixed(2),
          center.hold.toFixed(2),
          center.outflow.toFixed(2),
          center.reversed.toFixed(2),
          center.net.toFixed(2),
          String(center.entryCount),
        ]
          .map((v) => escape(String(v)))
          .join(','),
      )
    }
  }
  return lines.join('\r\n')
}
