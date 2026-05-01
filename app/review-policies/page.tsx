'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRef } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabaseClient'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ClipboardCheck, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
  adminCardTitle,
  adminFilterWell,
  adminInput,
  adminOutlineBtn,
  adminPaginationBar,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'

type ReviewDealRow = {
  id: string
  name: string | null
  policy_number: string
  carrier: string | null
  ghl_stage: string | null
  policy_status: string | null
  deal_creation_date: string | null
  effective_date: string | null
  notes: string | null
  updated_at: string | null
  last_updated: string | null
}

type ReviewNoteRow = {
  id: string
  policy_id?: string
  deal_tracker_id?: string
  note: string
  previous_ghl_stage: string | null
  next_ghl_stage: string | null
  reviewer_name: string | null
  created_at: string
}

function normalizeRawNote(raw: Record<string, unknown>): ReviewNoteRow {
  return {
    id: String(raw.id ?? ''),
    policy_id: raw.policy_id != null ? String(raw.policy_id) : undefined,
    deal_tracker_id: raw.deal_tracker_id != null ? String(raw.deal_tracker_id) : undefined,
    note: String(raw.note ?? ''),
    previous_ghl_stage: raw.previous_ghl_stage != null ? String(raw.previous_ghl_stage) : null,
    next_ghl_stage: raw.next_ghl_stage != null ? String(raw.next_ghl_stage) : null,
    reviewer_name: raw.reviewer_name != null ? String(raw.reviewer_name) : null,
    created_at: raw.created_at != null ? String(raw.created_at) : new Date().toISOString(),
  }
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (err && typeof err === 'object' && 'message' in err) {
    const msg = (err as { message?: unknown }).message
    if (typeof msg === 'string' && msg.trim()) return msg
  }
  return fallback
}

const REVIEW_GHL_STAGES = [
  'FDPF Pending Reason',
  'Pending Lapse Pending Reason',
  'Declined Underwriting',
  'Application Withdrawn',
  'Pending Manual Action',
] as const
const REVIEW_STAGE_PAGE_SIZE = 1000

const FDPF_REASON_OPTIONS = [
  'FDPF Unauthorized Draft',
  'FDPF Incorrect Banking Info',
  'FDPF Insufficient Funds',
] as const

const PENDING_LAPSE_REASON_OPTIONS = [
  'Pending Lapse Unauthorized Draft',
  'Pending Lapse Incorrect Banking Info',
  'Pending Lapse Insufficient Funds',
] as const

function stageActionOptions(stage: string | null): string[] {
  if (stage === 'FDPF Pending Reason') return [...FDPF_REASON_OPTIONS]
  if (stage === 'Pending Lapse Pending Reason') return [...PENDING_LAPSE_REASON_OPTIONS]
  return []
}

export default function ReviewPoliciesPage() {
  const [rows, setRows] = useState<ReviewDealRow[]>([])
  const [notesByPolicyId, setNotesByPolicyId] = useState<Record<string, ReviewNoteRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [draftNoteById, setDraftNoteById] = useState<Record<string, string>>({})
  const [nextStageById, setNextStageById] = useState<Record<string, string>>({})
  const [reviewerName, setReviewerName] = useState('')
  const [selectedStages, setSelectedStages] = useState<string[]>([...REVIEW_GHL_STAGES])
  const [notesJoinKey, setNotesJoinKey] = useState<'policy_id' | 'deal_tracker_id'>('policy_id')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [editingById, setEditingById] = useState<Record<string, boolean>>({})
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  const stageCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const row of rows) {
      const stage = row.ghl_stage || 'Unknown'
      out[stage] = (out[stage] || 0) + 1
    }
    return out
  }, [rows])
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const pageStart = rows.length === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEndExclusive = Math.min(pageStart + pageSize, rows.length)
  const paginatedRows = rows.slice(pageStart, pageEndExclusive)
  const selectedStagesKey = selectedStages.join('|')

  const fetchRows = useCallback(async () => {
    setLoading(true)
    try {
      if (selectedStages.length === 0) {
        setRows([])
        setNotesByPolicyId({})
        return
      }

      const allRows: ReviewDealRow[] = []
      let from = 0
      while (true) {
        const to = from + REVIEW_STAGE_PAGE_SIZE - 1
        const { data, error } = await supabase
          .from('deal_tracker')
          .select(
            'id, name, policy_number, carrier, ghl_stage, policy_status, deal_creation_date, effective_date, notes, updated_at, last_updated'
          )
          .in('ghl_stage', selectedStages)
          .order('updated_at', { ascending: false })
          .order('id', { ascending: false })
          .range(from, to)

        if (error) throw error
        const chunk = (data || []) as ReviewDealRow[]
        if (chunk.length === 0) break
        allRows.push(...chunk.filter((r) => Boolean(r.id)))
        if (chunk.length < REVIEW_STAGE_PAGE_SIZE) break
        from += REVIEW_STAGE_PAGE_SIZE
      }

      // Deduplicate by primary key in case page boundaries overlap on equal sort values.
      const seen = new Set<string>()
      const reviewRows = allRows.filter((r) => {
        if (seen.has(r.id)) return false
        seen.add(r.id)
        return true
      })
      setRows(reviewRows)

      if (reviewRows.length === 0) {
        setNotesByPolicyId({})
        return
      }

      const dealIds = reviewRows.map((r) => r.id)

      let fetchedNotes: ReviewNoteRow[] = []
      let joinKey: 'policy_id' | 'deal_tracker_id' = 'policy_id'
      const policyAttempt = await supabase
        .from('deal_tracker_review_notes')
        .select('*')
        .in('policy_id', dealIds)
        .order('created_at', { ascending: false })

      if (policyAttempt.error) {
        const legacyAttempt = await supabase
          .from('deal_tracker_review_notes')
          .select('*')
          .in('deal_tracker_id', dealIds)
          .order('created_at', { ascending: false })

        if (legacyAttempt.error) {
          // Keep page usable even with partial/legacy schemas; avoid noisy banner.
          console.warn('Review notes table schema mismatch:', legacyAttempt.error.message)
          setNotesByPolicyId({})
          return
        }
        fetchedNotes = ((legacyAttempt.data || []) as Record<string, unknown>[]).map(normalizeRawNote)
        joinKey = 'deal_tracker_id'
      } else {
        fetchedNotes = ((policyAttempt.data || []) as Record<string, unknown>[]).map(normalizeRawNote)
        joinKey = 'policy_id'
      }
      setNotesJoinKey(joinKey)

      const grouped: Record<string, ReviewNoteRow[]> = {}
      const seenNoteIds = new Set<string>()
      for (const n of fetchedNotes) {
        if (seenNoteIds.has(n.id)) continue
        seenNoteIds.add(n.id)
        const key = joinKey === 'policy_id' ? n.policy_id : n.deal_tracker_id
        if (!key) continue
        if (!grouped[key]) grouped[key] = []
        grouped[key].push(n)
      }
      setNotesByPolicyId(grouped)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to load policies for review.'
      alert(message)
    } finally {
      setLoading(false)
    }
  }, [selectedStages])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  useEffect(() => {
    setCurrentPage(1)
  }, [selectedStagesKey, pageSize])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const toggleStage = (stage: string) => {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
    )
  }

  const persistReview = async (row: ReviewDealRow, noteRaw: string, nextStageRaw: string) => {
    const note = String(noteRaw || '').trim()
    const nextStage = String(nextStageRaw || '').trim()
    if (!note && !nextStage) {
      throw new Error('Please add a note or choose a stage before saving.')
    }

    try {
      if (nextStage && nextStage !== row.ghl_stage) {
        const { error: stageError } = await supabase
          .from('deal_tracker')
          .update({
            ghl_stage: nextStage,
            updated_at: new Date().toISOString(),
            last_updated: new Date().toISOString(),
          })
          .eq('id', row.id)
        if (stageError) throw new Error(`Stage update failed: ${stageError.message}`)
      }

      if (note) {
        const notePayload =
          notesJoinKey === 'policy_id'
            ? {
                policy_id: row.id,
                previous_ghl_stage: row.ghl_stage,
                next_ghl_stage: nextStage || null,
                note,
                reviewer_name: reviewerName.trim() || null,
                created_at: new Date().toISOString(),
              }
            : {
                deal_tracker_id: row.id,
                policy_number: row.policy_number,
                previous_ghl_stage: row.ghl_stage,
                next_ghl_stage: nextStage || null,
                note,
                reviewer_name: reviewerName.trim() || null,
                created_at: new Date().toISOString(),
              }

        let { error: noteError } = await supabase.from('deal_tracker_review_notes').insert(notePayload)

        // Fallback for tables that only have core columns (no stage/reviewer metadata yet).
        if (noteError) {
          const minimalPayload =
            notesJoinKey === 'policy_id'
              ? {
                  policy_id: row.id,
                  note,
                  created_at: new Date().toISOString(),
                }
              : {
                  deal_tracker_id: row.id,
                  policy_number: row.policy_number,
                  note,
                  created_at: new Date().toISOString(),
                }
          const retry = await supabase.from('deal_tracker_review_notes').insert(minimalPayload)
          noteError = retry.error
        }
        if (noteError) throw new Error(`Note save failed: ${noteError.message}`)
      }
    } catch (err) {
      throw err
    }
  }

  const saveReview = async (row: ReviewDealRow) => {
    setSavingId(row.id)
    try {
      await persistReview(row, draftNoteById[row.id] || '', nextStageById[row.id] || '')

      setDraftNoteById((prev) => ({ ...prev, [row.id]: '' }))
      setNextStageById((prev) => ({ ...prev, [row.id]: '' }))
      setEditingById((prev) => ({ ...prev, [row.id]: false }))
      await fetchRows()
    } catch (err: unknown) {
      const message = extractErrorMessage(err, 'Failed to save review.')
      alert(message)
    } finally {
      setSavingId(null)
    }
  }

  const exportExcel = () => {
    const headers = [
      'Row ID',
      'Policy Number',
      'Name',
      'Carrier',
      'Current GHL Stage',
      'Manual Move',
      'Review Note',
      'Reviewer Name',
    ]
    const data = rows.map((r) => [
      r.id,
      r.policy_number ?? '',
      r.name ?? '',
      r.carrier ?? '',
      r.ghl_stage ?? '',
      '',
      '',
      reviewerName || '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
    ws['!cols'] = [
      { wch: 38 }, { wch: 18 }, { wch: 24 }, { wch: 22 },
      { wch: 30 }, { wch: 30 }, { wch: 42 }, { wch: 22 },
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Review Policies')
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `review-policies-${today}.xlsx`)
  }

  const handleImportClick = () => importInputRef.current?.click()

  const importFromFile = async (file: File | null) => {
    if (!file) return
    setImporting(true)
    try {
      const ext = file.name.toLowerCase()
      let rowsIn: Record<string, unknown>[] = []
      if (ext.endsWith('.csv')) {
        const text = await file.text()
        const parsed = Papa.parse<Record<string, unknown>>(text, { header: true, skipEmptyLines: true })
        rowsIn = parsed.data || []
      } else {
        const buf = await file.arrayBuffer()
        const wb = XLSX.read(buf, { type: 'array' })
        const ws = wb.Sheets[wb.SheetNames[0]]
        rowsIn = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '' })
      }

      const rowMap = new Map(rows.map((r) => [r.id, r]))
      let saved = 0
      for (const raw of rowsIn) {
        const id = String(raw['Row ID'] ?? '').trim()
        if (!id) continue
        const nextStage = String(raw['Manual Move'] ?? '').trim()
        const note = String(raw['Review Note'] ?? '').trim()
        const reviewer = String(raw['Reviewer Name'] ?? reviewerName).trim()
        const row = rowMap.get(id)
        if (!row) continue

        const prevReviewer = reviewerName
        if (reviewer && reviewer !== reviewerName) setReviewerName(reviewer)
        await persistReview(row, note, nextStage)
        if (reviewer && reviewer !== prevReviewer) setReviewerName(prevReviewer)
        saved++
      }
      await fetchRows()
      alert(`Imported and saved ${saved} row(s).`)
    } catch (err: unknown) {
      alert(extractErrorMessage(err, 'Failed to import file.'))
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Review Policies"
        description="Review Declined / Withdrawn / failed-payment cases, keep full note history, and move only allowed reason stages."
        icon={<ClipboardCheck className="h-7 w-7 text-orange-400" strokeWidth={2} />}
      />

      <Card>
        <CardHeader className={cn('pb-5', adminCardHeaderBar)}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className={adminCardTitle}>
              Review Queue <span className="text-xs font-normal text-muted-foreground">({rows.length})</span>
            </CardTitle>
            <div className="flex items-center gap-2">
              <Input
                placeholder="Reviewer name (optional)"
                value={reviewerName}
                onChange={(e) => setReviewerName(e.target.value)}
                className={cn(adminInput, 'w-56')}
              />
              <Button onClick={fetchRows} variant="outline" className={adminOutlineBtn}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <input
                ref={importInputRef}
                type="file"
                accept=".xlsx,.xls,.csv,text/csv"
                className="hidden"
                onChange={(e) => importFromFile(e.target.files?.[0] ?? null)}
              />
              <Button onClick={exportExcel} variant="outline" className={adminOutlineBtn}>
                Export Excel
              </Button>
              <Button onClick={handleImportClick} variant="outline" className={adminOutlineBtn} disabled={importing}>
                {importing ? 'Importing...' : 'Import'}
              </Button>
            </div>
          </div>
          <div className={cn('mt-3 space-y-3 rounded-lg p-3', adminFilterWell)}>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Stage filter</p>
            <div className="flex flex-wrap gap-1.5">
              {REVIEW_GHL_STAGES.map((stage) => {
                const active = selectedStages.includes(stage)
                const count = stageCounts[stage] || 0
                return (
                  <button
                    key={stage}
                    type="button"
                    onClick={() => toggleStage(stage)}
                    className={cn(
                      'rounded-md border px-2 py-1 text-xs transition-colors',
                      active
                        ? 'border-orange-500/40 bg-orange-500/15 text-foreground shadow-sm'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/70 hover:text-foreground'
                    )}
                  >
                    {stage} <span className="ml-1 text-[10px] opacity-80">({count})</span>
                  </button>
                )
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                onClick={() => setSelectedStages([...REVIEW_GHL_STAGES])}
              >
                All
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                onClick={() => setSelectedStages([])}
              >
                Clear
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Showing {rows.length === 0 ? 0 : pageStart + 1}-{pageEndExclusive} of {rows.length} policies
            </span>
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
                <SelectTrigger className={cn('h-8 w-20 text-xs', adminSelectTrigger)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={adminSelectContent}>
                  <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
                  <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
                  <SelectItem value="100" className={adminSelectItem}>100</SelectItem>
                  <SelectItem value="250" className={adminSelectItem}>250</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="overflow-x-auto rounded-md border border-border dark:border-slate-800">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border bg-muted/30 hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800 dark:bg-slate-900/40">
                  <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Name</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Carrier</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[220px]')}>Current GHL Stage</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[190px]')}>Manual Move</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[260px]')}>Review Note</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[280px]')}>Review Notes (All)</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[150px]')}>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center">
                      <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                      No policies currently in review scope.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedRows.map((row) => {
                    const isEditing = !!editingById[row.id]
                    const actionOptions = stageActionOptions(row.ghl_stage)
                    const noteList = notesByPolicyId[row.id] || []
                    return (
                      <TableRow key={row.id} className={adminTableRowInteractive}>
                        <TableCell className={cn(adminTdStrong, 'min-w-[180px]')}>{row.name || '-'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'font-mono text-sm')}>{row.policy_number}</TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[150px] truncate" title={row.carrier || '-'}>
                            {row.carrier || '-'}
                          </span>
                        </TableCell>
                        <TableCell className={adminTdMuted}>{row.ghl_stage || '-'}</TableCell>
                        <TableCell className={adminTdMuted}>
                          {actionOptions.length > 0 ? (
                            <Select
                              value={nextStageById[row.id] || '__none__'}
                              onValueChange={(v) =>
                                setNextStageById((prev) => ({ ...prev, [row.id]: v === '__none__' ? '' : v }))
                              }
                              disabled={!isEditing}
                            >
                              <SelectTrigger className={cn('h-9 w-[220px]', adminSelectTrigger)}>
                                <SelectValue placeholder="Keep current stage" />
                              </SelectTrigger>
                              <SelectContent className={adminSelectContent}>
                                <SelectItem value="__none__" className={adminSelectItem}>
                                  Keep current stage
                                </SelectItem>
                                {actionOptions.map((opt) => (
                                  <SelectItem key={opt} value={opt} className={adminSelectItem}>
                                    {opt}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          ) : (
                            <span className="text-xs text-muted-foreground">Notes only</span>
                          )}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <div className="space-y-2">
                            <textarea
                              value={draftNoteById[row.id] || ''}
                              onChange={(e) =>
                                setDraftNoteById((prev) => ({
                                  ...prev,
                                  [row.id]: e.target.value,
                                }))
                              }
                              disabled={!isEditing}
                              placeholder="Write review note..."
                              className={cn(
                                'min-h-[62px] w-full min-w-[240px] rounded-md border border-input bg-background p-2 text-sm text-foreground',
                                'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                                !isEditing && 'cursor-not-allowed opacity-70'
                              )}
                            />
                          </div>
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          {noteList.length > 0 ? (
                            <div className="max-h-40 min-w-[260px] space-y-2 overflow-y-auto pr-1 text-xs">
                              {noteList.map((n) => (
                                <div key={n.id} className="rounded-md border border-border p-2">
                                  <p className="font-medium text-foreground">{n.note}</p>
                                  <p className="mt-1 text-muted-foreground">
                                    {n.reviewer_name ? `${n.reviewer_name} • ` : ''}
                                    {formatStoredDateForDisplay(n.created_at)}
                                  </p>
                                  {(n.previous_ghl_stage || n.next_ghl_stage) && (
                                    <p className="mt-1 text-muted-foreground">
                                      {n.previous_ghl_stage || '-'} → {n.next_ghl_stage || '-'}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">No review yet</span>
                          )}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <div className="flex items-center gap-2">
                            {!isEditing ? (
                              <Button
                                size="sm"
                                variant="outline"
                                className={adminOutlineBtn}
                                onClick={() => setEditingById((prev) => ({ ...prev, [row.id]: true }))}
                              >
                                Edit
                              </Button>
                            ) : (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className={adminOutlineBtn}
                                  onClick={() => {
                                    setEditingById((prev) => ({ ...prev, [row.id]: false }))
                                    setDraftNoteById((prev) => ({ ...prev, [row.id]: '' }))
                                    setNextStageById((prev) => ({ ...prev, [row.id]: '' }))
                                  }}
                                >
                                  Cancel
                                </Button>
                                <Button
                                  size="sm"
                                  onClick={() => saveReview(row)}
                                  disabled={savingId === row.id}
                                  className="bg-blue-600 text-white hover:bg-blue-700"
                                >
                                  {savingId === row.id ? 'Saving...' : 'Save'}
                                </Button>
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {rows.length > 0 && (
            <div className={cn('flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80', adminPaginationBar)}>
              <div className="text-sm text-muted-foreground">
                Page {currentPage} of {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className={adminOutlineBtn}
                >
                  First
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className={adminOutlineBtn}
                >
                  Prev
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className={adminOutlineBtn}
                >
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className={adminOutlineBtn}
                >
                  Last
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

