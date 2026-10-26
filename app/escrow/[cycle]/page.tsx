'use client'

import { use, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle, ArrowLeft, Download, Info, Landmark, Loader2 } from 'lucide-react'
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
  buildCycleRows,
  formatCycleLabel,
  type EscrowCycleRow,
  type EscrowLedgerEntry,
} from '@/lib/escrowLedgerReport'
import {
  buildCenterDetails,
  centerDetailsToCsv,
  parseCycleRouteKey,
  policyMatchKey,
  type EscrowCenterDetail,
  type EscrowPolicyLine,
  type EscrowWorkChestDeal,
} from '@/lib/escrowCycleDetail'
import { ESCROW_LEDGER_TABLE } from '@/lib/bpoEscrowAccounts'

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function EscrowCycleDetailPage({ params }: { params: Promise<{ cycle: string }> }) {
  const { cycle: cycleKey } = use(params)
  const { start, end } = parseCycleRouteKey(cycleKey)

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [cycleRow, setCycleRow] = useState<EscrowCycleRow | null>(null)
  const [details, setDetails] = useState<EscrowCenterDetail[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // 1. The escrow entries for this cycle.
      let query = supabase.from(ESCROW_LEDGER_TABLE).select('*')
      query = start && end
        ? query.eq('cycle_start_date', start).eq('cycle_end_date', end)
        : query.is('cycle_start_date', null)
      const { data: ledgerData, error: ledgerError } = await query
      if (ledgerError) throw new Error(ledgerError.message)
      const entries = (ledgerData ?? []) as EscrowLedgerEntry[]
      setCycleRow(buildCycleRows(entries)[0] ?? null)

      const batchIds = Array.from(
        new Set(entries.map((e) => e.invoicing_batch_id).filter((id): id is string => Boolean(id))),
      )

      if (batchIds.length === 0) {
        setDetails(buildCenterDetails({ policyLines: [], workChestDeals: [] }))
        return
      }

      // 2. Everything invoiced in those batches, and 3. anything held by hand.
      const [{ data: lineData }, { data: chestData }] = await Promise.all([
        supabase
          .from('invoicing_policy_lines')
          .select('batch_id, call_center, agency_carrier_id, carrier, policy_number, gross_amount, final_cc_amount, latest_invoicing_status')
          .in('batch_id', batchIds),
        supabase
          .from('invoicing_work_chest_deals')
          .select('call_center, policy_number, customer_name, carrier, commission_date, center_amount, released_batch_id')
          .in('released_batch_id', batchIds),
      ])

      const policyLines = (lineData ?? []) as EscrowPolicyLine[]
      const workChestDeals = (chestData ?? []) as EscrowWorkChestDeal[]

      // 4. Insured names, for the policies the work chest did not name.
      const namesByPolicy = new Map<string, string>()
      const wanted = policyLines.map((l) => l.policy_number).filter(Boolean)
      for (let i = 0; i < wanted.length; i += 200) {
        const { data: deals } = await supabase
          .from('deal_tracker')
          .select('policy_number, ghl_name, name')
          .in('policy_number', wanted.slice(i, i + 200))
        for (const d of (deals ?? []) as Array<{ policy_number: string; ghl_name: string | null; name: string | null }>) {
          const label = (d.ghl_name || d.name || '').trim()
          if (label) namesByPolicy.set(policyMatchKey(d.policy_number), label)
        }
      }

      const escrowByCenter = new Map<string, { openingTransfer: number; hold: number }>()
      for (const entry of entries) {
        const current = escrowByCenter.get(entry.call_center) ?? { openingTransfer: 0, hold: 0 }
        const amount = Number(entry.amount) || 0
        if (entry.entry_type === 'opening_transfer') current.openingTransfer += amount
        else if (entry.entry_type === 'hold') current.hold += amount
        escrowByCenter.set(entry.call_center, current)
      }

      setDetails(buildCenterDetails({ policyLines, workChestDeals, namesByPolicy, escrowByCenter }))
    } catch (err: unknown) {
      setDetails([])
      setError(err instanceof Error ? err.message : 'Could not load this cycle.')
    } finally {
      setLoading(false)
    }
  }, [start, end])

  useEffect(() => {
    void load()
  }, [load])

  const cycleLabel = useMemo(() => formatCycleLabel(start, end), [start, end])

  const downloadCsv = () => {
    const csv = centerDetailsToCsv(details, cycleLabel)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `escrow-deals_${start ?? 'unassigned'}_${end ?? ''}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const totalDeals = details.reduce((sum, d) => sum + d.deals.length, 0)

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title={cycleLabel}
        icon={<Landmark className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
        description="The deals behind this cycle's escrow. Deals marked Held were withheld individually; a percentage holdback is a share of everything below rather than particular policies."
        action={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className={adminOutlineBtn}>
              <Link href="/escrow">
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                All cycles
              </Link>
            </Button>
            <Button size="sm" onClick={downloadCsv} disabled={loading || totalDeals === 0}>
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

      {cycleRow && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-orange-500/30 bg-orange-500/[0.07]">
            <CardContent className="pt-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Into escrow this cycle</p>
              <p className="font-display text-3xl font-bold tabular-nums text-foreground dark:text-white">
                ${money(cycleRow.net)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Earlier deals</p>
              <p className="font-display text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                ${money(cycleRow.openingTransfer)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Holdback</p>
              <p className="font-display text-2xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                ${money(cycleRow.hold)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">Held after this cycle</p>
              <p className="font-display text-2xl font-semibold tabular-nums text-foreground dark:text-slate-100">
                ${money(cycleRow.runningTotal)}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the deals for this cycle…
        </div>
      ) : details.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <p className="text-sm text-muted-foreground">No deals recorded for this cycle.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Escrow posted here without a linked invoice batch, so there is nothing to list.
            </p>
          </CardContent>
        </Card>
      ) : (
        details.map((center) => (
          <Card key={center.callCenter}>
            <CardHeader className={cn(adminCardHeaderBar, 'flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between')}>
              <CardTitle className={adminCardTitle}>{center.callCenter}</CardTitle>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {center.deals.length} deal{center.deals.length === 1 ? '' : 's'} invoiced · $
                  {money(center.cycleTotal)}
                </span>
                {center.heldCount > 0 && (
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    {center.heldCount} held · ${money(center.heldTotal)}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="pt-5">
              {center.holdIsProportional && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground dark:border-slate-800 dark:bg-slate-950/40">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    This cycle&rsquo;s escrow is a percentage holdback, so it is a share of everything below rather
                    than particular deals. The list is what the holdback was calculated from.
                  </span>
                </div>
              )}
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className={adminThPlain}>Policy</TableHead>
                      <TableHead className={adminThPlain}>Customer</TableHead>
                      <TableHead className={adminThPlain}>Carrier</TableHead>
                      <TableHead className={adminThPlain}>Commission received</TableHead>
                      <TableHead className={adminThPlain}>Status</TableHead>
                      <TableHead className={cn(adminThPlain, 'text-right')}>Center share</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {center.deals.map((deal) => (
                      <TableRow
                        key={`${center.callCenter}:${deal.policyNumber}`}
                        className={cn(adminTableRowInteractive, deal.held && 'bg-amber-50/60 dark:bg-amber-950/20')}
                      >
                        <TableCell className={cn(adminTdStrong, 'whitespace-nowrap font-mono text-xs')}>
                          {deal.policyNumber}
                          {deal.held && (
                            <Badge className="ml-2 border-amber-400/50 bg-amber-500/15 text-[10px] text-amber-900 dark:text-amber-200" variant="outline">
                              Held
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className={adminTdStrong}>{deal.customerName || <span className="text-muted-foreground/40">—</span>}</TableCell>
                        <TableCell className={adminTdMuted}>{deal.carrier || '—'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'whitespace-nowrap tabular-nums')}>
                          {deal.commissionDate || <span className="text-muted-foreground/40">—</span>}
                        </TableCell>
                        <TableCell className={adminTdMuted}>{deal.status || '—'}</TableCell>
                        <TableCell className={cn('text-right font-medium tabular-nums', adminTdStrong)}>
                          ${money(deal.centerAmount)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t-2 border-border dark:border-slate-700">
                      <TableCell className={cn(adminTdStrong, 'font-semibold')} colSpan={5}>
                        Total invoiced this cycle
                      </TableCell>
                      <TableCell className={cn('text-right font-bold tabular-nums', adminTdStrong)}>
                        ${money(center.cycleTotal)}
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  )
}
