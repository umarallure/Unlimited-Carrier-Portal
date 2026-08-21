'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronDown, ChevronRight, Link2, Loader2, RefreshCw, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminExpandRowBg,
  adminOutlineBtn,
  adminPaginationBar,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'

type Candidate = {
  leadId: string
  firstName: string | null
  lastName: string | null
  phone: string | null
  agent: string | null
  carrier: string | null
  monthlyPremium: number | null
  draftDate: string | null
  score: number
}

type UnmatchedRow = {
  id: string
  policyNumber: string
  name: string | null
  carrier: string | null
  dealCreationDate: string | null
  effectiveDate: string | null
  salesAgent: string | null
  dealValue: number | null
  ghlStage: string | null
  candidates: Candidate[]
}

type Suggestion = {
  leadId: string | null
  confidence: number
  matchedName: boolean
  matchedAgent: boolean
  matchedCarrier: boolean
  reasoning: string
}

const PAGE_SIZE = 20

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  return fallback
}

function formatMoney(value: number | null): string {
  if (value == null || Number.isNaN(value)) return '—'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
}

function candidateName(c: Candidate): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || '(no name on file)'
}

function confidenceTier(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 0.75) return 'high'
  if (confidence >= 0.4) return 'medium'
  return 'low'
}

function confidenceBadgeClass(confidence: number): string {
  const tier = confidenceTier(confidence)
  if (tier === 'high') return 'border-transparent bg-green-600 text-white hover:bg-green-600'
  if (tier === 'medium') return 'border-transparent bg-amber-600 text-white hover:bg-amber-600'
  return 'border-transparent bg-slate-500 text-white hover:bg-slate-500'
}

function matchedSignalsLabel(s: Suggestion): string {
  const signals = [s.matchedName && 'name', s.matchedAgent && 'agent', s.matchedCarrier && 'carrier'].filter(Boolean)
  return signals.length > 0 ? `matched: ${signals.join(', ')}` : 'no signals matched'
}

export default function UnmatchedLeadsPage() {
  const [rows, setRows] = useState<UnmatchedRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [aiState, setAiState] = useState<
    Record<string, { loading: boolean; suggestion?: Suggestion; error?: string }>
  >({})
  const [confirmState, setConfirmState] = useState<
    Record<string, { loadingLeadId?: string; error?: string }>
  >({})

  const [scanLimitReached, setScanLimitReached] = useState(false)

  const fetchPage = useCallback(async (targetPage: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/deal-tracker/review-unmatched?page=${targetPage}&pageSize=${PAGE_SIZE}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to load unmatched policies.')
      setRows(data.rows ?? [])
      setTotal(data.total ?? 0)
      setPage(data.page ?? targetPage)
      setScanLimitReached(Boolean(data.scanLimitReached))
    } catch (e) {
      setError(extractErrorMessage(e, 'Failed to load unmatched policies.'))
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchPage(1)
  }, [fetchPage])

  // Keyed by deal_tracker row id, not policy_number — duplicate policy numbers
  // (reissued policies) are a real occurrence in this data, and keying by the
  // number alone would let two distinct rows share one AI/confirm state.
  const askAI = useCallback(async (row: UnmatchedRow) => {
    setAiState((prev) => ({ ...prev, [row.id]: { loading: true } }))
    try {
      const res = await fetch('/api/deal-tracker/suggest-lead-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: row.id, policyNumber: row.policyNumber }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'AI suggestion failed.')
      setAiState((prev) => ({ ...prev, [row.id]: { loading: false, suggestion: data as Suggestion } }))
    } catch (e) {
      setAiState((prev) => ({
        ...prev,
        [row.id]: { loading: false, error: extractErrorMessage(e, 'AI suggestion failed.') },
      }))
    }
  }, [])

  const confirmMatch = useCallback(async (row: UnmatchedRow, leadId: string) => {
    setConfirmState((prev) => ({ ...prev, [row.id]: { loadingLeadId: leadId } }))
    try {
      const res = await fetch('/api/deal-tracker/confirm-lead-match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policyNumber: row.policyNumber, leadId, ghlStage: row.ghlStage }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to confirm match.')
      // Matched — this specific row is no longer "unmatched", drop just this one
      // (not every row sharing the same policy number).
      setRows((prev) => prev.filter((r) => r.id !== row.id))
      setTotal((prev) => Math.max(0, prev - 1))
      setExpanded((prev) => (prev === row.id ? null : prev))
    } catch (e) {
      setConfirmState((prev) => ({
        ...prev,
        [row.id]: { error: extractErrorMessage(e, 'Failed to confirm match.') },
      }))
    }
  }, [])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <PageHeader
        title="Unmatched Leads"
        description="Policies in Deal Tracker that couldn't be attached to a CRM lead by exact policy number or tracking ID. Review the AI-suggested candidate and confirm the correct one — nothing is attached automatically."
        icon={<Link2 className="h-6 w-6 text-muted-foreground" />}
      />

      <Card className="overflow-hidden">
        <CardHeader className={cn('flex flex-row items-center justify-between gap-3', adminCardHeaderBar)}>
          <CardTitle className={adminCardTitle}>
            Unmatched policies {total > 0 ? <span className={adminTdMuted}>({total})</span> : null}
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={adminOutlineBtn}
            onClick={() => fetchPage(page)}
            disabled={loading}
          >
            <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="px-4 py-3 text-sm text-destructive">{error}</div>
          ) : null}
          {scanLimitReached ? (
            <div className="px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
              Only the {`5,000`} most recent Deal Tracker policies are scanned for this list — older unmatched
              policies past that window won&apos;t appear here.
            </div>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className={adminThPlain}></TableHead>
                <TableHead className={adminThPlain}>Name</TableHead>
                <TableHead className={adminThPlain}>Policy #</TableHead>
                <TableHead className={adminThPlain}>Carrier</TableHead>
                <TableHead className={adminThPlain}>Deal Date</TableHead>
                <TableHead className={adminThPlain}>Agent</TableHead>
                <TableHead className={adminThPlain}>Deal Value</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                  </TableCell>
                </TableRow>
              ) : rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No unmatched policies — everything on this page has a CRM lead attached.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row) => {
                  const isOpen = expanded === row.id
                  const ai = aiState[row.id]
                  const confirming = confirmState[row.id]
                  return (
                    <Fragment key={row.id}>
                      <TableRow
                        className={cn(adminTableRowInteractive, 'cursor-pointer')}
                        onClick={() => setExpanded(isOpen ? null : row.id)}
                      >
                        <TableCell>
                          {isOpen ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className={adminTdStrong}>{row.name || '—'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'font-mono text-xs')}>{row.policyNumber}</TableCell>
                        <TableCell className={adminTdMuted}>{row.carrier || '—'}</TableCell>
                        <TableCell className={adminTdMuted}>{formatStoredDateForDisplay(row.dealCreationDate)}</TableCell>
                        <TableCell className={adminTdMuted}>{row.salesAgent || '—'}</TableCell>
                        <TableCell className={adminTdMuted}>{formatMoney(row.dealValue)}</TableCell>
                      </TableRow>
                      {isOpen ? (
                        <TableRow className={adminExpandRowBg}>
                          <TableCell colSpan={7} className="p-4">
                            <div className="space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-sm font-medium text-foreground">
                                  Candidate CRM leads without a policy attached
                                </div>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className={adminOutlineBtn}
                                  disabled={ai?.loading}
                                  onClick={() => askAI(row)}
                                >
                                  {ai?.loading ? (
                                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                                  )}
                                  Ask AI
                                </Button>
                              </div>

                              {ai?.error ? <div className="text-sm text-destructive">{ai.error}</div> : null}
                              {ai?.suggestion ? (
                                <div className="flex items-start gap-2 rounded-md border border-border bg-background/60 p-3 text-sm dark:border-slate-800">
                                  <Badge className={confidenceBadgeClass(ai.suggestion.confidence)}>
                                    {Math.round(ai.suggestion.confidence * 100)}% confidence
                                  </Badge>
                                  <div>
                                    <span className={adminTdMuted}>{ai.suggestion.reasoning}</span>
                                    <div className={cn('text-xs', adminTdMuted)}>{matchedSignalsLabel(ai.suggestion)}</div>
                                  </div>
                                </div>
                              ) : null}

                              {confirming?.error ? (
                                <div className="text-sm text-destructive">{confirming.error}</div>
                              ) : null}

                              {row.candidates.length === 0 ? (
                                <div className={cn('text-sm', adminTdMuted)}>
                                  No unattached leads with a similar name were found.
                                </div>
                              ) : (
                                <div className="overflow-x-auto rounded-md border border-border dark:border-slate-800">
                                  <Table>
                                    <TableHeader>
                                      <TableRow>
                                        <TableHead className={adminThPlain}>Name</TableHead>
                                        <TableHead className={adminThPlain}>Agent</TableHead>
                                        <TableHead className={adminThPlain}>Carrier</TableHead>
                                        <TableHead className={adminThPlain}>Phone</TableHead>
                                        <TableHead className={adminThPlain}>Premium</TableHead>
                                        <TableHead className={adminThPlain}>Draft Date</TableHead>
                                        <TableHead className={adminThPlain}></TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {row.candidates.map((c) => {
                                        const isAiPick = ai?.suggestion?.leadId === c.leadId
                                        const isConfirmingThis = confirming?.loadingLeadId === c.leadId
                                        return (
                                          <TableRow key={c.leadId} className={adminTableRowInteractive}>
                                            <TableCell className={adminTdStrong}>
                                              {candidateName(c)}
                                              {isAiPick ? (
                                                <Badge className="ml-2 border-transparent bg-blue-600 text-white hover:bg-blue-600">
                                                  AI pick
                                                </Badge>
                                              ) : null}
                                            </TableCell>
                                            <TableCell className={adminTdMuted}>{c.agent || '—'}</TableCell>
                                            <TableCell className={adminTdMuted}>{c.carrier || '—'}</TableCell>
                                            <TableCell className={adminTdMuted}>{c.phone || '—'}</TableCell>
                                            <TableCell className={adminTdMuted}>{formatMoney(c.monthlyPremium)}</TableCell>
                                            <TableCell className={adminTdMuted}>
                                              {formatStoredDateForDisplay(c.draftDate)}
                                            </TableCell>
                                            <TableCell>
                                              <Button
                                                type="button"
                                                size="sm"
                                                disabled={Boolean(confirming?.loadingLeadId)}
                                                onClick={() => confirmMatch(row, c.leadId)}
                                              >
                                                {isConfirmingThis ? (
                                                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                                                ) : null}
                                                Confirm
                                              </Button>
                                            </TableCell>
                                          </TableRow>
                                        )
                                      })}
                                    </TableBody>
                                  </Table>
                                </div>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ) : null}
                    </Fragment>
                  )
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
        <div className={cn('flex items-center justify-between gap-3 border-t px-4 py-3', adminPaginationBar)}>
          <span className={cn('text-sm', adminTdMuted)}>
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={adminOutlineBtn}
              disabled={loading || page <= 1}
              onClick={() => fetchPage(page - 1)}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={adminOutlineBtn}
              disabled={loading || page >= totalPages}
              onClick={() => fetchPage(page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
