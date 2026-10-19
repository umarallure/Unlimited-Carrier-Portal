'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { AlertTriangle, CheckCircle2, Landmark, Loader2, Save, Search, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminInput,
  adminInputSm,
  adminOutlineBtn,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import { normalizeCallCenterName } from '@/lib/invoicing'
import {
  deleteEscrowAccount,
  listEscrowAccounts,
  listEscrowBalances,
  loadGlobalSettings,
  saveEscrowAccount,
  saveGlobalSettings,
  type EscrowAccountRow,
  type EscrowBalanceRow,
  type EscrowGlobalSettingsRow,
} from '@/lib/bpoEscrowAccounts'

const noticeStyles = {
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
} as const

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : fallback
}

function money(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function EscrowSettingsPage() {
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  const [settings, setSettings] = useState<EscrowGlobalSettingsRow | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [capInput, setCapInput] = useState('10000')
  const [holdInput, setHoldInput] = useState('20')
  const [postDrawInput, setPostDrawInput] = useState('30')
  const [savingSettings, setSavingSettings] = useState(false)

  const [accounts, setAccounts] = useState<EscrowAccountRow[]>([])
  const [balances, setBalances] = useState<Map<string, EscrowBalanceRow>>(new Map())
  const [callCenters, setCallCenters] = useState<string[]>([])
  const [searchTerm, setSearchTerm] = useState('')
  const [busyCenter, setBusyCenter] = useState<string | null>(null)

  // Draft edits per center, so a row can be changed and saved on its own.
  const [edits, setEdits] = useState<Record<string, Partial<EscrowAccountRow>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [settingsRow, accountRows, balanceRows] = await Promise.all([
        loadGlobalSettings(),
        listEscrowAccounts(),
        listEscrowBalances().catch(() => [] as EscrowBalanceRow[]),
      ])
      setSettings(settingsRow)
      if (settingsRow) {
        setEnabled(settingsRow.enabled)
        setCapInput(String(num(settingsRow.cap_amount, 10000)))
        setHoldInput(String(num(settingsRow.hold_rate, 0.2) * 100))
        setPostDrawInput(String(num(settingsRow.post_draw_hold_rate, 0.3) * 100))
      }
      setAccounts(accountRows)
      setBalances(new Map(balanceRows.map((b) => [normalizeCallCenterName(b.call_center), b])))
      setEdits({})

      // The canonical center list comes from live deal data, the same source the
      // invoice screen uses. There is no call_centers table.
      const seen = new Set<string>()
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('deal_tracker')
          .select('call_center')
          .range(from, from + 999)
        if (error) break
        for (const row of (data as { call_center: string | null }[]) || []) {
          const raw = String(row.call_center ?? '').trim()
          if (raw) seen.add(normalizeCallCenterName(raw))
        }
        if (!data || data.length < 1000) break
      }
      for (const a of accountRows) seen.add(normalizeCallCenterName(a.call_center))
      setCallCenters(Array.from(seen).sort((a, b) => a.localeCompare(b)))
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not load escrow settings.' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const accountByCenter = useMemo(() => {
    const map = new Map<string, EscrowAccountRow>()
    for (const a of accounts) map.set(normalizeCallCenterName(a.call_center), a)
    return map
  }, [accounts])

  const visibleCenters = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    const list = q ? callCenters.filter((c) => c.toLowerCase().includes(q)) : callCenters
    // Configured centers first — they are the ones being managed.
    return list.slice().sort((a, b) => {
      const ca = accountByCenter.has(a) ? 0 : 1
      const cb = accountByCenter.has(b) ? 0 : 1
      return ca - cb || a.localeCompare(b)
    })
  }, [callCenters, searchTerm, accountByCenter])

  const configuredCount = accounts.length
  const exemptCount = accounts.filter((a) => a.exempt || a.status === 'ended').length
  const liveCount = accounts.filter((a) => a.mode === 'live' && !a.exempt && a.status !== 'ended').length

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    setNotice(null)
    try {
      const holdRate = num(holdInput, 20) / 100
      const postDrawRate = num(postDrawInput, 30) / 100
      if (holdRate <= 0 || holdRate > 1) throw new Error('The hold rate must be between 0 and 100 percent.')
      if (postDrawRate <= 0 || postDrawRate > 1) throw new Error('The replenishment rate must be between 0 and 100 percent.')
      await saveGlobalSettings({
        enabled,
        capAmount: num(capInput, 10000),
        holdRate,
        postDrawHoldRate: postDrawRate,
      })
      setNotice({
        kind: 'success',
        text: enabled
          ? 'Escrow is on. The invoice screen now shows the preview for every center that is not exempt — balance due is unchanged.'
          : 'Escrow is off. Invoicing behaves exactly as it did before escrow existed.',
      })
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save the settings.' })
    } finally {
      setSavingSettings(false)
    }
  }

  const editFor = (center: string): Partial<EscrowAccountRow> => edits[center] ?? {}

  const valueFor = <K extends keyof EscrowAccountRow>(center: string, field: K, fallback: EscrowAccountRow[K]) => {
    const edit = editFor(center)
    if (field in edit) return edit[field] as EscrowAccountRow[K]
    const account = accountByCenter.get(center)
    return (account ? account[field] : fallback) as EscrowAccountRow[K]
  }

  const setField = <K extends keyof EscrowAccountRow>(center: string, field: K, value: EscrowAccountRow[K]) => {
    setEdits((prev) => ({ ...prev, [center]: { ...(prev[center] || {}), [field]: value } }))
  }

  const handleSaveCenter = async (center: string) => {
    setBusyCenter(center)
    setNotice(null)
    try {
      const holdOverrideRaw = String(valueFor(center, 'hold_rate_override', null) ?? '')
      const capOverrideRaw = String(valueFor(center, 'cap_amount_override', null) ?? '')
      await saveEscrowAccount({
        callCenter: center,
        exempt: Boolean(valueFor(center, 'exempt', false)),
        capAmountOverride: capOverrideRaw.trim() === '' ? null : num(capOverrideRaw, 0),
        holdRateOverride: holdOverrideRaw.trim() === '' ? null : num(holdOverrideRaw, 0),
        openingBalance: num(valueFor(center, 'opening_balance', 0), 0),
        mode: (valueFor(center, 'mode', 'preview') as 'preview' | 'live') || 'preview',
        status: (valueFor(center, 'status', 'active') as 'active' | 'ended') || 'active',
        notes: (String(valueFor(center, 'notes', '') ?? '').trim() || null) as string | null,
      })
      setNotice({ kind: 'success', text: `Saved escrow settings for ${center}.` })
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save the account.' })
    } finally {
      setBusyCenter(null)
    }
  }

  const handleRemove = async (center: string) => {
    const account = accountByCenter.get(center)
    if (!account) return
    if (!window.confirm(`Remove the escrow account for ${center}? It will fall back to the global defaults.`)) return
    setBusyCenter(center)
    try {
      await deleteEscrowAccount(account.id)
      setNotice({ kind: 'success', text: `Removed the escrow account for ${center}.` })
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Could not remove the account.' })
    } finally {
      setBusyCenter(null)
    }
  }

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="Escrow Settings"
        icon={<Landmark className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
        description="Holds back a share of each center's payout, capped per center, so a chargeback can still be recovered after a center stops working with us. While escrow is in preview the invoice shows the split but balance due is unchanged and nothing is withheld."
        action={
          <div className="rounded-2xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-center">
            <p className="text-xs text-muted-foreground">Escrow</p>
            <p className="font-display text-2xl font-bold text-foreground dark:text-white">
              {loading ? '—' : enabled ? 'On' : 'Off'}
            </p>
          </div>
        }
      />

      {notice && (
        <div className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm', noticeStyles[notice.kind])}>
          {notice.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <p className="min-w-0 flex-1">{notice.text}</p>
          <button type="button" onClick={() => setNotice(null)} className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {!loading && !settings && (
        <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>Escrow has not been set up in the database yet. Run <code className="font-mono">bpo_escrow.sql</code> in the Supabase SQL editor, then reload this page.</p>
        </div>
      )}

      {/* ─── Global ─── */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <CardTitle className={adminCardTitle}>Global</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5 pt-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="mt-1 h-4 w-4 accent-orange-500"
            />
            <span>
              <span className="block text-sm font-medium text-foreground dark:text-slate-200">Escrow on</span>
              <span className="block text-xs text-muted-foreground">
                The master switch. Turning it off restores invoicing to exactly what it did before escrow existed,
                for every center at once, with no redeploy.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Cap per center ($)</span>
              <Input value={capInput} onChange={(e) => setCapInput(e.target.value)} className={adminInput} inputMode="decimal" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Hold rate (%)</span>
              <Input value={holdInput} onChange={(e) => setHoldInput(e.target.value)} className={adminInput} inputMode="decimal" />
            </label>
            <label className="space-y-1.5">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Replenishment rate (%)</span>
              <Input value={postDrawInput} onChange={(e) => setPostDrawInput(e.target.value)} className={adminInput} inputMode="decimal" />
            </label>
          </div>
          <p className="text-xs text-muted-foreground">
            The replenishment rate only applies while a draw is being paid back, which is not in use yet.
          </p>

          <Button onClick={handleSaveSettings} disabled={savingSettings || !settings}>
            {savingSettings ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            Save global settings
          </Button>
        </CardContent>
      </Card>

      {/* ─── Per center ─── */}
      <Card>
        <CardHeader className={cn(adminCardHeaderBar, 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between')}>
          <CardTitle className={adminCardTitle}>Per center</CardTitle>
          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
            <span>{configuredCount} configured</span>
            <span>{exemptCount} exempt</span>
            <span className={liveCount > 0 ? 'font-medium text-emerald-600 dark:text-emerald-400' : undefined}>
              {liveCount} live
            </span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Find a center"
                className={cn(adminInputSm, 'w-56 pl-8')}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-5">
          <p className="mb-4 text-xs text-muted-foreground">
            A center with no row here uses the global settings and is not exempt. Opening balance is the agreed
            starting point; every movement after that belongs in the escrow ledger, so do not keep editing it once
            posting is live. <strong>Preview</strong> shows the split but the center is still paid in full;{' '}
            <strong>Live</strong> actually withholds the holdback and posts it to the escrow ledger when the
            invoice is marked paid. What a center owes us is not set here — it is the chargeback balance carried
            forward on the invoice screen.
          </p>
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading centers…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className={adminThPlain}>Call center</TableHead>
                    <TableHead className={adminThPlain}>Exempt</TableHead>
                    <TableHead className={adminThPlain}>Opening balance</TableHead>
                    <TableHead className={adminThPlain}>Holdback</TableHead>
                    <TableHead className={adminThPlain}>Cap override</TableHead>
                    <TableHead className={adminThPlain}>Hold override</TableHead>
                    <TableHead className={adminThPlain}>Balance now</TableHead>
                    <TableHead className={cn(adminThPlain, 'text-right')}>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleCenters.map((center) => {
                    const account = accountByCenter.get(center)
                    const balance = balances.get(center)
                    const dirty = Boolean(edits[center])
                    const busy = busyCenter === center
                    return (
                      <TableRow key={center} className={adminTableRowInteractive}>
                        <TableCell className={cn(adminTdStrong, 'whitespace-nowrap')}>
                          {center}
                          {!account && <Badge variant="secondary" className="ml-2 text-[10px]">defaults</Badge>}
                        </TableCell>
                        <TableCell>
                          <input
                            type="checkbox"
                            checked={Boolean(valueFor(center, 'exempt', false))}
                            onChange={(e) => setField(center, 'exempt', e.target.checked)}
                            className="h-4 w-4 accent-orange-500"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={String(valueFor(center, 'opening_balance', 0) ?? 0)}
                            onChange={(e) => setField(center, 'opening_balance', e.target.value)}
                            className="h-8 w-28 text-right font-mono text-xs"
                            inputMode="decimal"
                          />
                        </TableCell>
                        <TableCell>
                          <select
                            value={String(valueFor(center, 'mode', 'preview') ?? 'preview')}
                            onChange={(e) => setField(center, 'mode', e.target.value as 'preview' | 'live')}
                            className={cn(
                              'h-8 rounded-md border px-2 text-xs',
                              valueFor(center, 'mode', 'preview') === 'live'
                                ? 'border-emerald-500/50 bg-emerald-500/10 font-medium text-emerald-700 dark:text-emerald-300'
                                : 'border-input bg-background text-muted-foreground dark:border-slate-800 dark:bg-slate-950',
                            )}
                          >
                            <option value="preview">Preview</option>
                            <option value="live">Live — withhold</option>
                          </select>
                        </TableCell>
                        <TableCell>
                          <Input
                            value={String(valueFor(center, 'cap_amount_override', null) ?? '')}
                            onChange={(e) => setField(center, 'cap_amount_override', e.target.value)}
                            placeholder="—"
                            className="h-8 w-24 text-right font-mono text-xs"
                            inputMode="decimal"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            value={String(valueFor(center, 'hold_rate_override', null) ?? '')}
                            onChange={(e) => setField(center, 'hold_rate_override', e.target.value)}
                            placeholder="—"
                            title="As a fraction, so 0.2 is 20%."
                            className="h-8 w-20 text-right font-mono text-xs"
                            inputMode="decimal"
                          />
                        </TableCell>
                        <TableCell className={cn(adminTdMuted, 'whitespace-nowrap tabular-nums')}>
                          {balance ? `$${money(num(balance.balance))}` : '—'}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant={dirty ? 'default' : 'outline'}
                              className={dirty ? undefined : adminOutlineBtn}
                              disabled={busy}
                              onClick={() => void handleSaveCenter(center)}
                            >
                              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save'}
                            </Button>
                            {account && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void handleRemove(center)}
                                title="Remove this account and fall back to the global defaults"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
