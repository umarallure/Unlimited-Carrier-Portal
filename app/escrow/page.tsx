'use client'

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Landmark,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminOutlineBtn,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import {
  buildCenterRows,
  buildCycleRows,
  buildTotals,
  cycleRowsToCsv,
  formatCycleLabel,
  type EscrowCenterRow,
  type EscrowCycleRow,
  type EscrowLedgerEntry,
} from '@/lib/escrowLedgerReport'
import { ESCROW_LEDGER_TABLE } from '@/lib/bpoEscrowAccounts'

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Zero reads as a muted dash: a column of 0.00 hides the figures that matter. */
function Amount({ value, tone }: { value: number; tone?: 'in' | 'out' }) {
  if (Math.abs(value) < 0.005) return <span className="text-muted-foreground/40">—</span>
  return (
    <span
      className={cn(
        'tabular-nums',
        tone === 'in' && 'text-emerald-600 dark:text-emerald-400',
        tone === 'out' && 'text-red-600 dark:text-red-400',
      )}
    >
      ${money(value)}
    </span>
  )
}

export default function EscrowPage() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<EscrowLedgerEntry[]>([])
  const [expanded, setExpanded] = useState<Record<string, true>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const all: EscrowLedgerEntry[] = []
      for (let from = 0; ; from += 1000) {
        const { data, error: queryError } = await supabase
          .from(ESCROW_LEDGER_TABLE)
          .select('*')
          .order('created_at', { ascending: true })
          .range(from, from + 999)
        if (queryError) throw new Error(queryError.message)
        const chunk = (data ?? []) as EscrowLedgerEntry[]
        all.push(...chunk)
        if (chunk.length < 1000) break
      }
      setEntries(all)
    } catch (err: unknown) {
      setEntries([])
      setError(
        err instanceof Error
          ? `Could not read the escrow ledger: ${err.message}`
          : 'Could not read the escrow ledger.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const cycles: EscrowCycleRow[] = useMemo(() => buildCycleRows(entries), [entries])
  const centers: EscrowCenterRow[] = useMemo(() => buildCenterRows(entries), [entries])
  const totals = useMemo(() => buildTotals(entries), [entries])

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = { ...prev }
      if (next[key]) delete next[key]
      else next[key] = true
      return next
    })

  const downloadCsv = () => {
    const csv = cycleRowsToCsv(cycles)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `escrow-by-cycle_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="Escrow"
        icon={<Landmark className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
        description="What is held back from each call center, cycle by cycle. Money moves in when an invoice is marked paid for a center that is live, and comes out through a draw or when the relationship ends."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading} className={adminOutlineBtn}>
              {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
              Refresh
            </Button>
            <Button size="sm" onClick={downloadCsv} disabled={loading || cycles.length === 0}>
              <Download className="mr-1.5 h-4 w-4" />
              Export CSV
            </Button>
          </div>
        }
      />

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ─── The headline ─── */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="border-orange-500/30 bg-orange-500/[0.07]">
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Held right now</p>
            <p className="font-display text-3xl font-bold tabular-nums text-foreground dark:text-white">
              {loading ? '—' : `$${money(totals.heldNow)}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              across {totals.centersWithBalance} center{totals.centersWithBalance === 1 ? '' : 's'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Moved in, all time</p>
            <p className="font-display text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              {loading ? '—' : `$${money(totals.everIn)}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">holdbacks and earlier deals</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Taken out</p>
            <p className="font-display text-2xl font-semibold tabular-nums text-red-600 dark:text-red-400">
              {loading ? '—' : `$${money(Math.abs(totals.everOut))}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">draws and releases</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Reversed</p>
            <p className="font-display text-2xl font-semibold tabular-nums text-foreground dark:text-slate-100">
              {loading ? '—' : `$${money(Math.abs(totals.everReversed))}`}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">from invoices marked unpaid</p>
          </CardContent>
        </Card>
      </div>

      {/* ─── By cycle ─── */}
      <Card>
        <CardHeader className={cn(adminCardHeaderBar, 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between')}>
          <CardTitle className={adminCardTitle}>By invoice cycle</CardTitle>
          <span className="text-xs text-muted-foreground">
            {totals.cycleCount} cycle{totals.cycleCount === 1 ? '' : 's'} · {totals.entryCount} ledger entr
            {totals.entryCount === 1 ? 'y' : 'ies'} · newest first
          </span>
        </CardHeader>
        <CardContent className="pt-6">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Reading the escrow ledger…
            </div>
          ) : cycles.length === 0 ? (
            <div className="py-16 text-center">
              <p className="text-sm text-muted-foreground">Nothing has been held yet.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Escrow posts when an invoice is marked paid for a center set to live on the Escrow Settings page.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={cn(adminThPlain, 'w-8')} />
                    <TableHead className={adminThPlain}>Cycle</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Earlier deals</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Holdback</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Taken out</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Reversed</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Net</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Held after</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cycles.map((cycle) => {
                    const open = Boolean(expanded[cycle.key])
                    return (
                      <Fragment key={cycle.key}>
                        <TableRow
                          className={cn(adminTableRowInteractive, 'cursor-pointer')}
                          onClick={() => toggle(cycle.key)}
                        >
                          <TableCell className="pr-0">
                            {open ? (
                              <ChevronDown className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            )}
                          </TableCell>
                          <TableCell className={cn(adminTdStrong, 'whitespace-nowrap')}>
                            {formatCycleLabel(cycle.cycleStart, cycle.cycleEnd)}
                            <Badge variant="secondary" className="ml-2 text-[10px]">
                              {cycle.centers.length} center{cycle.centers.length === 1 ? '' : 's'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right"><Amount value={cycle.openingTransfer} tone="in" /></TableCell>
                          <TableCell className="text-right"><Amount value={cycle.hold} tone="in" /></TableCell>
                          <TableCell className="text-right"><Amount value={cycle.outflow} tone="out" /></TableCell>
                          <TableCell className="text-right"><Amount value={cycle.reversed} tone="out" /></TableCell>
                          <TableCell className={cn('text-right font-semibold', adminTdStrong)}>
                            <Amount value={cycle.net} />
                          </TableCell>
                          <TableCell className={cn('text-right font-semibold tabular-nums', adminTdStrong)}>
                            ${money(cycle.runningTotal)}
                          </TableCell>
                        </TableRow>
                        {open &&
                          cycle.centers.map((center) => (
                            <TableRow key={`${cycle.key}:${center.callCenter}`} className="bg-muted/30 dark:bg-slate-950/40">
                              <TableCell />
                              <TableCell className={cn(adminTdMuted, 'pl-8 text-sm')}>{center.callCenter}</TableCell>
                              <TableCell className="text-right text-sm"><Amount value={center.openingTransfer} tone="in" /></TableCell>
                              <TableCell className="text-right text-sm"><Amount value={center.hold} tone="in" /></TableCell>
                              <TableCell className="text-right text-sm"><Amount value={center.outflow} tone="out" /></TableCell>
                              <TableCell className="text-right text-sm"><Amount value={center.reversed} tone="out" /></TableCell>
                              <TableCell className="text-right text-sm"><Amount value={center.net} /></TableCell>
                              <TableCell />
                            </TableRow>
                          ))}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ─── By center ─── */}
      {!loading && centers.length > 0 && (
        <Card>
          <CardHeader className={cn(adminCardHeaderBar, 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between')}>
            <CardTitle className={adminCardTitle}>By call center</CardTitle>
            <span className="text-xs text-muted-foreground">balance now, and how it got there</span>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={adminThPlain}>Call center</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Earlier deals</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Holdbacks</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Taken out</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Reversed</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Cycles</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Held now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {centers.map((center) => (
                    <TableRow key={center.callCenter} className={adminTableRowInteractive}>
                      <TableCell className={cn(adminTdStrong, 'whitespace-nowrap')}>{center.callCenter}</TableCell>
                      <TableCell className="text-right"><Amount value={center.openingTransfer} tone="in" /></TableCell>
                      <TableCell className="text-right"><Amount value={center.hold} tone="in" /></TableCell>
                      <TableCell className="text-right"><Amount value={center.outflow} tone="out" /></TableCell>
                      <TableCell className="text-right"><Amount value={center.reversed} tone="out" /></TableCell>
                      <TableCell className={cn(adminTdMuted, 'text-right tabular-nums')}>{center.cyclesContributed}</TableCell>
                      <TableCell className={cn('text-right text-base font-semibold tabular-nums', adminTdStrong)}>
                        ${money(center.balance)}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow className="border-t-2 border-border dark:border-slate-700">
                    <TableCell className={cn(adminTdStrong, 'font-semibold')}>Total</TableCell>
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell />
                    <TableCell className={cn('text-right text-base font-bold tabular-nums', adminTdStrong)}>
                      ${money(totals.heldNow)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
