'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ShieldOff,
  Plus,
  Search,
  Loader2,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  X,
  Lock,
  Unlock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminInput,
  adminOutlineBtn,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'
import {
  addExceptions,
  deleteException,
  listExceptions,
  parsePolicyNumberList,
  setExceptionActive,
  type PolicyException,
} from '@/lib/policyExceptions'

type Notice = { kind: 'success' | 'error'; text: string }

const noticeStyles: Record<Notice['kind'], string> = {
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  error: 'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300',
}

export default function PolicyExceptionsPage() {
  const [rows, setRows] = useState<PolicyException[]>([])
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  const [policyInput, setPolicyInput] = useState('')
  const [carrierInput, setCarrierInput] = useState('')
  const [reasonInput, setReasonInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await listExceptions())
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to load exceptions' })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Live preview of what will actually be added, so a bad paste is visible first.
  const parsedPolicies = useMemo(() => parsePolicyNumberList(policyInput), [policyInput])

  const handleAdd = async () => {
    if (parsedPolicies.length === 0) return
    setSaving(true)
    setNotice(null)
    try {
      const result = await addExceptions({
        policyNumbers: parsedPolicies,
        carrier: carrierInput,
        reason: reasonInput,
      })
      const invalidNote = result.invalid.length ? ` ${result.invalid.length} entry(ies) were unusable and skipped.` : ''
      setNotice({
        kind: 'success',
        text: `${result.added} polic${result.added === 1 ? 'y' : 'ies'} frozen — uploads will no longer change them.${invalidNote}`,
      })
      setPolicyInput('')
      setReasonInput('')
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to add exceptions' })
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (row: PolicyException) => {
    setBusyId(row.id)
    try {
      await setExceptionActive(row.id, !row.active)
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to update' })
    } finally {
      setBusyId(null)
    }
  }

  const handleDelete = async (row: PolicyException) => {
    if (!confirm(`Remove ${row.policy_number} from the exception list? Uploads will be able to change it again.`)) {
      return
    }
    setBusyId(row.id)
    try {
      await deleteException(row.id)
      await load()
    } catch (err: unknown) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Failed to delete' })
    } finally {
      setBusyId(null)
    }
  }

  const filtered = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) return rows
    return rows.filter(
      (r) =>
        r.policy_number.toLowerCase().includes(term) ||
        (r.carrier ?? '').toLowerCase().includes(term) ||
        (r.reason ?? '').toLowerCase().includes(term)
    )
  }, [rows, searchTerm])

  const activeCount = rows.filter((r) => r.active).length

  return (
    <div className="admin-page space-y-8">
      <PageHeader
        title="Policy Exceptions"
        description="Policies on this list are never changed by a file upload. Deal Tracker, commission tracker and the CRM lead are all left alone for them. Deliberate edits you make by hand still apply."
        icon={<ShieldOff className="h-6 w-6 text-orange-500 dark:text-orange-400" />}
        action={
          <div className="rounded-2xl border border-orange-500/30 bg-orange-500/10 px-4 py-3 text-center">
            <p className="text-xs text-muted-foreground">Frozen</p>
            <p className="font-display text-2xl font-bold tabular-nums text-foreground dark:text-white">
              {loading ? '—' : activeCount}
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

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
            <Plus className="h-4 w-4 text-orange-500 dark:text-orange-400" />
            Freeze policies
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-5">
          <div className="space-y-2">
            <label className="text-sm font-medium text-foreground dark:text-slate-200">Policy numbers</label>
            <textarea
              value={policyInput}
              onChange={(e) => setPolicyInput(e.target.value)}
              placeholder={'Paste one per line, or separated by commas / spaces:\n0114004010\n114364910\n0112985280'}
              className={cn(
                'min-h-[130px] w-full rounded-md border border-input bg-background p-3 font-mono text-sm text-foreground',
                'placeholder:font-sans placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                'dark:border-slate-800 dark:bg-slate-950 dark:text-white'
              )}
            />
            <p className="text-xs text-muted-foreground">
              {parsedPolicies.length > 0
                ? `${parsedPolicies.length} policy number${parsedPolicies.length === 1 ? '' : 's'} recognised. Leading zeros are ignored when matching, so 114004010 and 0114004010 are the same policy.`
                : 'Leading zeros are ignored when matching, so 114004010 and 0114004010 are treated as the same policy.'}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground dark:text-slate-200">
                Carrier <span className="text-muted-foreground">(optional, for reference)</span>
              </label>
              <Input
                value={carrierInput}
                onChange={(e) => setCarrierInput(e.target.value)}
                placeholder="e.g. AMAM"
                className={adminInput}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground dark:text-slate-200">Reason</label>
              <Input
                value={reasonInput}
                onChange={(e) => setReasonInput(e.target.value)}
                placeholder="Why is this frozen? e.g. Manually corrected — carrier file is wrong"
                className={adminInput}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={handleAdd} disabled={saving || parsedPolicies.length === 0}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Lock className="mr-2 h-4 w-4" />}
              {saving
                ? 'Saving…'
                : `Freeze ${parsedPolicies.length || ''} polic${parsedPolicies.length === 1 ? 'y' : 'ies'}`.trim()}
            </Button>
            {!reasonInput.trim() && parsedPolicies.length > 0 && (
              <span className="text-xs text-amber-600 dark:text-amber-400">
                A reason is strongly recommended — it is the only record of why this policy stopped updating.
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------------------------------------------- */}
      <Card>
        <CardHeader className={adminCardHeaderBar}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className={cn(adminCardTitle, 'flex items-center gap-2')}>
              <ShieldOff className="h-4 w-4 text-orange-500 dark:text-orange-400" />
              Exception list
              <span className="text-sm font-normal text-muted-foreground">
                {loading ? '' : `${rows.length} total · ${activeCount} enforced`}
              </span>
            </CardTitle>
            <div className="relative w-full sm:w-80">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                placeholder="Policy, carrier, or reason"
                className={cn(adminInput, 'pl-9')}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="pt-5">
          <div className="overflow-x-auto rounded-lg border border-border dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className={adminThPlain}>Status</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={adminThPlain}>Carrier</TableHead>
                  <TableHead className={adminThPlain}>Reason</TableHead>
                  <TableHead className={adminThPlain}>Added by</TableHead>
                  <TableHead className={adminThPlain}>Added</TableHead>
                  <TableHead className={cn(adminThPlain, 'text-right')}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center">
                      <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      {rows.length === 0
                        ? 'No policies are frozen. Uploads currently change every policy they touch.'
                        : 'No entries match your search.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((row) => (
                    <TableRow key={row.id} className={adminTableRowInteractive}>
                      <TableCell>
                        {row.active ? (
                          <Badge
                            variant="outline"
                            className="border-orange-500/40 bg-orange-500/10 text-orange-600 dark:text-orange-300"
                          >
                            Frozen
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-slate-500/40 bg-slate-500/10 text-slate-600 dark:text-slate-300"
                          >
                            Inactive
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className={cn(adminTdStrong, 'font-mono text-xs')}>{row.policy_number}</TableCell>
                      <TableCell className={adminTdMuted}>{row.carrier || '—'}</TableCell>
                      <TableCell className={adminTdMuted}>{row.reason || '—'}</TableCell>
                      <TableCell className={adminTdMuted}>{row.created_by_email || '—'}</TableCell>
                      <TableCell className={cn(adminTdMuted, 'whitespace-nowrap')}>
                        {formatStoredDateForDisplay(row.created_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={adminOutlineBtn}
                            disabled={busyId === row.id}
                            onClick={() => handleToggle(row)}
                            title={row.active ? 'Stop enforcing (keeps the record)' : 'Enforce again'}
                          >
                            {row.active ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={cn(adminOutlineBtn, 'text-red-600 hover:text-red-700 dark:text-red-400')}
                            disabled={busyId === row.id}
                            onClick={() => handleDelete(row)}
                            title="Remove from the list"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
