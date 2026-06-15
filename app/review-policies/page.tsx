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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Check, ChevronDown, ClipboardCheck, Loader2, RefreshCw, Search, X } from 'lucide-react'
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
import { extractYmdFromDbValue, formatStoredDateForDisplay } from '@/lib/calendarDate'

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
  sales_agent: string | null
  writing_number: string | null
  call_center: string | null
  policy_type: string | null
  phone_number: string | null
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
const REVIEW_NOTES_IN_CHUNK = 200

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

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

function splitMultiFilter(value: string): string[] {
  if (!value || value === 'all') return []
  return value
    .split('||')
    .map((v) => v.trim())
    .filter(Boolean)
}

function compareEffectiveDates(a: string | null, b: string | null, direction: 'asc' | 'desc'): number {
  const aYmd = extractYmdFromDbValue(a)
  const bYmd = extractYmdFromDbValue(b)
  if (!aYmd && !bYmd) return 0
  if (!aYmd) return 1
  if (!bYmd) return -1
  const cmp = aYmd.localeCompare(bYmd)
  return direction === 'asc' ? cmp : -cmp
}

function appendReviewNoteToDealTrackerNotes(
  existingNotes: string | null,
  note: string,
  reviewer: string | null
): string {
  const stamp = formatStoredDateForDisplay(new Date().toISOString())
  const reviewerLabel = reviewer?.trim() || 'Unknown reviewer'
  const entry = `[Review ${stamp}] ${reviewerLabel}: ${note}`
  const prior = existingNotes?.trim()
  return prior ? `${prior}\n\n${entry}` : entry
}

type PersistReviewResult = {
  leadNoteSynced: boolean
  leadNoteMessage?: string
}

export default function ReviewPoliciesPage() {
  const [rows, setRows] = useState<ReviewDealRow[]>([])
  const [notesByPolicyId, setNotesByPolicyId] = useState<Record<string, ReviewNoteRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState<string | null>(null)
  const [reviewDialogRow, setReviewDialogRow] = useState<ReviewDealRow | null>(null)
  const [dialogNote, setDialogNote] = useState('')
  const [dialogNextStage, setDialogNextStage] = useState('')
  const [effectiveDateSort, setEffectiveDateSort] = useState<'asc' | 'desc'>('desc')
  const [reviewerName, setReviewerName] = useState('')
  const [selectedStages, setSelectedStages] = useState<string[]>([...REVIEW_GHL_STAGES])
  const [notesJoinKey, setNotesJoinKey] = useState<'policy_id' | 'deal_tracker_id'>('policy_id')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [importing, setImporting] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)
  const fetchSeqRef = useRef(0)
  const [searchTerm, setSearchTerm] = useState('')
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [openMultiFilter, setOpenMultiFilter] = useState<string | null>(null)
  const [multiFilterSearch, setMultiFilterSearch] = useState<Record<string, string>>({})

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearchTerm(searchTerm), 300)
    return () => clearTimeout(handle)
  }, [searchTerm])

  useEffect(() => {
    if (!openMultiFilter) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('[data-multifilter-root="true"]')) {
        setOpenMultiFilter(null)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [openMultiFilter])

  const updateMultiFilter = (
    setter: (value: string | ((prev: string) => string)) => void,
    selected: string[]
  ) => {
    const next = selected.map((v) => v.trim()).filter(Boolean)
    setter(next.length > 0 ? next.join('||') : 'all')
  }

  const stageCounts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const row of rows) {
      const stage = row.ghl_stage || 'Unknown'
      out[stage] = (out[stage] || 0) + 1
    }
    return out
  }, [rows])
  const carrierOptions = useMemo(
    () =>
      Array.from(new Set(rows.map((r) => r.carrier).filter((c): c is string => Boolean(c)))).sort(
        (a, b) => a.localeCompare(b)
      ),
    [rows]
  )
  const agentOptions = useMemo(
    () =>
      Array.from(
        new Set(rows.map((r) => r.sales_agent).filter((a): a is string => Boolean(a)))
      ).sort((a, b) => a.localeCompare(b)),
    [rows]
  )

  const selectedCarriers = splitMultiFilter(carrierFilter)
  const selectedAgents = splitMultiFilter(agentFilter)

  const filteredRows = useMemo(() => {
    const term = debouncedSearchTerm.trim().toLowerCase()
    const carrierList = splitMultiFilter(carrierFilter)
    const agentList = splitMultiFilter(agentFilter)
    const carrierSet = carrierList.length ? new Set(carrierList) : null
    const agentSet = agentList.length ? new Set(agentList) : null
    return rows.filter((r) => {
      if (carrierSet && !(r.carrier && carrierSet.has(r.carrier))) return false
      if (agentSet && !(r.sales_agent && agentSet.has(r.sales_agent))) return false
      if (term) {
        const haystack = [
          r.name,
          r.policy_number,
          r.carrier,
          r.sales_agent,
          r.writing_number,
          r.phone_number,
          r.policy_type,
          r.ghl_stage,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
        if (!haystack.includes(term)) return false
      }
      return true
    })
  }, [rows, debouncedSearchTerm, carrierFilter, agentFilter])

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows]
    copy.sort((a, b) => compareEffectiveDates(a.effective_date, b.effective_date, effectiveDateSort))
    return copy
  }, [filteredRows, effectiveDateSort])

  const reviewStats = useMemo(() => {
    let reviewed = 0
    let pending = 0
    for (const row of filteredRows) {
      if ((notesByPolicyId[row.id] || []).length > 0) reviewed++
      else pending++
    }
    return { reviewed, pending }
  }, [filteredRows, notesByPolicyId])

  const activeFilterCount =
    (debouncedSearchTerm.trim() ? 1 : 0) +
    (selectedCarriers.length ? 1 : 0) +
    (selectedAgents.length ? 1 : 0)

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setAgentFilter('all')
  }

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize))
  const pageStart = sortedRows.length === 0 ? 0 : (currentPage - 1) * pageSize
  const pageEndExclusive = Math.min(pageStart + pageSize, sortedRows.length)
  const paginatedRows = sortedRows.slice(pageStart, pageEndExclusive)
  const selectedStagesKey = selectedStages.join('|')

  const fetchRows = useCallback(async () => {
    const fetchSeq = ++fetchSeqRef.current
    const isStale = () => fetchSeq !== fetchSeqRef.current

    setLoading(true)
    try {
      if (selectedStages.length === 0) {
        if (isStale()) return
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
            'id, name, policy_number, carrier, ghl_stage, policy_status, deal_creation_date, effective_date, notes, updated_at, last_updated, sales_agent, writing_number, call_center, policy_type, phone_number'
          )
          .in('ghl_stage', selectedStages)
          .order('effective_date', { ascending: false, nullsFirst: false })
          .order('id', { ascending: false })
          .range(from, to)

        if (error) throw new Error(extractErrorMessage(error, 'Failed to load policies for review.'))
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
      if (isStale()) return
      setRows(reviewRows)

      if (reviewRows.length === 0) {
        setNotesByPolicyId({})
        return
      }

      const dealIds = reviewRows.map((r) => r.id)
      const idChunks = chunkArray(dealIds, REVIEW_NOTES_IN_CHUNK)

      let fetchedNotes: ReviewNoteRow[] = []
      let joinKey: 'policy_id' | 'deal_tracker_id' = 'policy_id'
      let notesSchemaError: string | null = null

      const fetchNotesChunk = async (
        column: 'policy_id' | 'deal_tracker_id',
        ids: string[]
      ) => {
        const { data, error } = await supabase
          .from('deal_tracker_review_notes')
          .select('*')
          .in(column, ids)
          .order('created_at', { ascending: false })
        return {
          error,
          notes: ((data || []) as Record<string, unknown>[]).map(normalizeRawNote),
        }
      }

      if (idChunks.length > 0) {
        const firstAttempt = await fetchNotesChunk('policy_id', idChunks[0])
        if (firstAttempt.error) {
          const legacyAttempt = await fetchNotesChunk('deal_tracker_id', idChunks[0])
          if (legacyAttempt.error) {
            notesSchemaError = legacyAttempt.error.message
          } else {
            joinKey = 'deal_tracker_id'
            fetchedNotes.push(...legacyAttempt.notes)
          }
        } else {
          fetchedNotes.push(...firstAttempt.notes)
        }

        if (!notesSchemaError) {
          for (let i = 1; i < idChunks.length; i++) {
            const attempt = await fetchNotesChunk(joinKey, idChunks[i])
            if (attempt.error) {
              notesSchemaError = attempt.error.message
              break
            }
            fetchedNotes.push(...attempt.notes)
          }
        }
      }

      if (isStale()) return

      if (notesSchemaError) {
        console.warn('Review notes table schema mismatch:', notesSchemaError)
        setNotesByPolicyId({})
        return
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
      if (isStale()) return
      alert(extractErrorMessage(err, 'Failed to load policies for review.'))
    } finally {
      if (!isStale()) setLoading(false)
    }
  }, [selectedStages])

  useEffect(() => {
    fetchRows()
  }, [fetchRows])

  useEffect(() => {
    setCurrentPage(1)
  }, [selectedStagesKey, pageSize, debouncedSearchTerm, carrierFilter, agentFilter, effectiveDateSort])

  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [currentPage, totalPages])

  const toggleStage = (stage: string) => {
    setSelectedStages((prev) =>
      prev.includes(stage) ? prev.filter((s) => s !== stage) : [...prev, stage]
    )
  }

  const persistReview = async (
    row: ReviewDealRow,
    noteRaw: string,
    nextStageRaw: string
  ): Promise<PersistReviewResult> => {
    const note = String(noteRaw || '').trim()
    const nextStage = String(nextStageRaw || '').trim()
    if (!note && !nextStage) {
      throw new Error('Please add a note or choose a stage before saving.')
    }

    const result: PersistReviewResult = { leadNoteSynced: true }

    try {
      const now = new Date().toISOString()
      const reviewer = reviewerName.trim() || null
      let needsDealTrackerUpdate = false
      const dealTrackerUpdate: {
        ghl_stage?: string
        notes?: string
        updated_at: string
        last_updated: string
      } = {
        updated_at: now,
        last_updated: now,
      }

      if (nextStage && nextStage !== row.ghl_stage) {
        dealTrackerUpdate.ghl_stage = nextStage
        needsDealTrackerUpdate = true
      }

      if (note) {
        const notePayload =
          notesJoinKey === 'policy_id'
            ? {
                policy_id: row.id,
                previous_ghl_stage: row.ghl_stage,
                next_ghl_stage: nextStage || null,
                note,
                reviewer_name: reviewer,
                created_at: now,
              }
            : {
                deal_tracker_id: row.id,
                policy_number: row.policy_number,
                previous_ghl_stage: row.ghl_stage,
                next_ghl_stage: nextStage || null,
                note,
                reviewer_name: reviewer,
                created_at: now,
              }

        let reviewNoteId: string | null = null
        let noteError: { message: string } | null = null

        const initialInsert = await supabase
          .from('deal_tracker_review_notes')
          .insert(notePayload)
          .select('id')
          .single()

        if (initialInsert.error) {
          const minimalPayload =
            notesJoinKey === 'policy_id'
              ? {
                  policy_id: row.id,
                  note,
                  created_at: now,
                }
              : {
                  deal_tracker_id: row.id,
                  policy_number: row.policy_number,
                  note,
                  created_at: now,
                }
          const retry = await supabase
            .from('deal_tracker_review_notes')
            .insert(minimalPayload)
            .select('id')
            .single()
          noteError = retry.error
          reviewNoteId = retry.data?.id != null ? String(retry.data.id) : null
        } else {
          noteError = null
          reviewNoteId = initialInsert.data?.id != null ? String(initialInsert.data.id) : null
        }

        if (noteError) throw new Error(`Note save failed: ${noteError.message}`)
        if (!reviewNoteId) throw new Error('Note save failed: missing review note id.')

        const syncRes = await fetch('/api/review-policies/sync-lead-note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            policyNumber: row.policy_number,
            note,
            dealTrackerReviewNoteId: reviewNoteId,
          }),
        })

        const syncPayload = (await syncRes.json().catch(() => null)) as
          | { synced?: boolean; message?: string }
          | null

        if (!syncRes.ok) {
          throw new Error(
            syncPayload?.message || 'Note saved to Deal Tracker, but lead note sync failed.'
          )
        }

        if (!syncPayload?.synced) {
          result.leadNoteSynced = false
          result.leadNoteMessage =
            syncPayload?.message ||
            'Note saved to Deal Tracker, but no matching lead was found for this policy number. Attach policy in CRM to sync lead notes.'
        }

        dealTrackerUpdate.notes = appendReviewNoteToDealTrackerNotes(row.notes, note, reviewer)
        needsDealTrackerUpdate = true
      }

      if (needsDealTrackerUpdate) {
        const { error: dealTrackerError } = await supabase
          .from('deal_tracker')
          .update(dealTrackerUpdate)
          .eq('id', row.id)
        if (dealTrackerError) {
          throw new Error(`Deal tracker update failed: ${dealTrackerError.message}`)
        }
      }

      return result
    } catch (err) {
      throw err
    }
  }

  const openReviewDialog = (row: ReviewDealRow) => {
    setReviewDialogRow(row)
    setDialogNote('')
    setDialogNextStage('')
  }

  const closeReviewDialog = () => {
    setReviewDialogRow(null)
    setDialogNote('')
    setDialogNextStage('')
  }

  const saveReview = async (row: ReviewDealRow) => {
    setSavingId(row.id)
    try {
      const result = await persistReview(row, dialogNote, dialogNextStage)
      closeReviewDialog()
      await fetchRows()
      if (dialogNote.trim() && !result.leadNoteSynced && result.leadNoteMessage) {
        alert(result.leadNoteMessage)
      }
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
      'Agent',
      'Call Center',
      'Effective Date',
      'Current GHL Stage',
      'Manual Move',
      'Review Note',
      'Reviewer Name',
    ]
    const data = filteredRows.map((r) => [
      r.id,
      r.policy_number ?? '',
      r.name ?? '',
      r.carrier ?? '',
      r.sales_agent ?? '',
      r.call_center ?? '',
      r.effective_date ?? '',
      r.ghl_stage ?? '',
      '',
      '',
      reviewerName || '',
    ])
    const ws = XLSX.utils.aoa_to_sheet([headers, ...data])
    ws['!cols'] = [
      { wch: 38 }, { wch: 18 }, { wch: 24 }, { wch: 22 },
      { wch: 22 }, { wch: 18 }, { wch: 14 }, { wch: 30 },
      { wch: 30 }, { wch: 42 }, { wch: 22 },
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
      let attachPolicyWarnings = 0
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
        const result = await persistReview(row, note, nextStage)
        if (note && !result.leadNoteSynced) attachPolicyWarnings++
        if (reviewer && reviewer !== prevReviewer) setReviewerName(prevReviewer)
        saved++
      }
      await fetchRows()
      const importMessage =
        attachPolicyWarnings > 0
          ? `Imported and saved ${saved} row(s). ${attachPolicyWarnings} note(s) could not sync to CRM — attach policy for those policies.`
          : `Imported and saved ${saved} row(s).`
      alert(importMessage)
    } catch (err: unknown) {
      alert(extractErrorMessage(err, 'Failed to import file.'))
    } finally {
      setImporting(false)
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const renderMultiSelect = (
    keyName: string,
    label: string,
    value: string,
    options: string[],
    setter: (value: string | ((prev: string) => string)) => void
  ) => {
    const selected = splitMultiFilter(value)
    const isOpen = openMultiFilter === keyName
    const search = multiFilterSearch[keyName] || ''
    const visibleOptions = options.filter((opt) =>
      opt.toLowerCase().includes(search.toLowerCase())
    )
    const toggle = (option: string) => {
      const next = selected.includes(option)
        ? selected.filter((v) => v !== option)
        : [...selected, option]
      updateMultiFilter(setter, next)
    }
    const selectedLabel =
      selected.length === 0
        ? `All ${label}`
        : selected.length === 1
          ? selected[0]
          : `${selected.length} selected`

    return (
      <div className="relative space-y-1.5" data-multifilter-root="true">
        <label className="block text-xs font-medium text-muted-foreground">{label}</label>
        <button
          type="button"
          onClick={() => setOpenMultiFilter(isOpen ? null : keyName)}
          className={cn(
            adminSelectTrigger,
            'group flex h-10 w-full items-center gap-2 rounded-md border px-3 text-left text-sm transition-colors',
            isOpen ? 'border-orange-500/60 ring-2 ring-orange-500/15' : 'hover:border-border/80'
          )}
        >
          <span
            className={cn(
              'flex-1 truncate text-[13px]',
              selected.length === 0 && 'text-muted-foreground'
            )}
          >
            {selectedLabel}
          </span>
          {selected.length > 0 ? (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear selection"
              onClick={(e) => {
                e.stopPropagation()
                setter('all')
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  setter('all')
                }
              }}
              className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </span>
          ) : null}
          <ChevronDown
            className={cn(
              'h-4 w-4 shrink-0 text-muted-foreground transition-transform',
              isOpen && 'rotate-180'
            )}
          />
        </button>

        {isOpen ? (
          <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-full min-w-[260px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl shadow-black/20 dark:border-slate-700 dark:bg-slate-900">
            <div className="sticky top-0 z-10 border-b border-border/60 bg-popover/95 p-2 backdrop-blur dark:bg-slate-900/95">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={search}
                  onChange={(e) =>
                    setMultiFilterSearch((prev) => ({ ...prev, [keyName]: e.target.value }))
                  }
                  placeholder={`Search ${label.toLowerCase()}…`}
                  className={cn(adminInput, 'h-8 pl-7 text-xs sm:h-8')}
                />
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <button
                  type="button"
                  className="font-medium text-orange-400 hover:text-orange-300"
                  onClick={() => updateMultiFilter(setter, search ? visibleOptions : options)}
                >
                  {search ? 'Select shown' : 'Select all'}
                </button>
                <button
                  type="button"
                  className="font-medium text-muted-foreground hover:text-foreground"
                  onClick={() => setter('all')}
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
                      active ? 'bg-orange-500/12 text-foreground' : 'text-foreground/85 hover:bg-muted/70'
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                        active
                          ? 'border-orange-500 bg-orange-500 text-white'
                          : 'border-border bg-background text-transparent'
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
                {selected.length === 0
                  ? 'No selection'
                  : `${selected.length} of ${options.length} selected`}
              </span>
              <button
                type="button"
                className="font-medium text-foreground hover:text-orange-400"
                onClick={() => setOpenMultiFilter(null)}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    )
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
              Review Queue{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({filteredRows.length}
                {filteredRows.length !== rows.length ? ` of ${rows.length}` : ''})
              </span>
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
          <div className={cn('mt-3 space-y-3 rounded-lg p-3', adminFilterWell)}>
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Search &amp; filters
              </p>
              {activeFilterCount > 0 ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                  Clear filters ({activeFilterCount})
                </button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-muted-foreground">Search</label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
                  <Input
                    placeholder="Name, policy #, agent, phone, type…"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className={cn(adminInput, 'pl-10')}
                  />
                </div>
              </div>
              {renderMultiSelect('carrier', 'Carrier', carrierFilter, carrierOptions, setCarrierFilter)}
              {renderMultiSelect('agent', 'Agent', agentFilter, agentOptions, setAgentFilter)}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            >
              Reviewed: {reviewStats.reviewed}
            </Badge>
            <Badge
              variant="outline"
              className="border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            >
              Pending: {reviewStats.pending}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Sorted by effective date ({effectiveDateSort === 'desc' ? 'newest first' : 'oldest first'})
            </span>
          </div>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
            <span>
              Showing {sortedRows.length === 0 ? 0 : pageStart + 1}-{pageEndExclusive} of{' '}
              {sortedRows.length} policies
              {sortedRows.length !== rows.length ? ` (filtered from ${rows.length})` : ''}
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
                  <TableHead className={cn(adminThPlain, 'w-[110px]')}>Status</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[180px]')}>Name</TableHead>
                  <TableHead className={adminThPlain}>Policy #</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[140px]')}>Carrier</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[140px]')}>Agent</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[130px]')}>
                    <button
                      type="button"
                      onClick={() =>
                        setEffectiveDateSort((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                      }
                      className="inline-flex items-center gap-1 font-medium text-foreground transition-colors hover:text-orange-400"
                    >
                      Effective Date
                      <span className="text-[10px] text-muted-foreground">
                        {effectiveDateSort === 'desc' ? '↓' : '↑'}
                      </span>
                    </button>
                  </TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[200px]')}>GHL Stage</TableHead>
                  <TableHead className={cn(adminThPlain, 'min-w-[160px]')}>Last Review</TableHead>
                  <TableHead className={cn(adminThPlain, 'w-[100px] text-right')}>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center">
                      <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
                    </TableCell>
                  </TableRow>
                ) : sortedRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-8 text-center text-muted-foreground">
                      {rows.length === 0
                        ? 'No policies currently in review scope.'
                        : 'No policies match the current search and filters.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedRows.map((row) => {
                    const noteList = notesByPolicyId[row.id] || []
                    const isReviewed = noteList.length > 0
                    const latestNote = noteList[0]
                    return (
                      <TableRow
                        key={row.id}
                        className={cn(adminTableRowInteractive, 'cursor-pointer')}
                        onClick={() => openReviewDialog(row)}
                      >
                        <TableCell className={adminTdMuted}>
                          <Badge
                            variant="outline"
                            className={cn(
                              'whitespace-nowrap',
                              isReviewed
                                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            )}
                          >
                            {isReviewed ? 'Reviewed' : 'Pending'}
                          </Badge>
                        </TableCell>
                        <TableCell className={cn(adminTdStrong, 'min-w-[180px]')}>{row.name || '-'}</TableCell>
                        <TableCell className={cn(adminTdMuted, 'font-mono text-sm')}>{row.policy_number}</TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[140px] truncate" title={row.carrier || '-'}>
                            {row.carrier || '-'}
                          </span>
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[140px] truncate" title={row.sales_agent || '-'}>
                            {row.sales_agent || '-'}
                          </span>
                        </TableCell>
                        <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-xs font-medium')}>
                          {row.effective_date ? formatStoredDateForDisplay(row.effective_date) : '-'}
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          <span className="block max-w-[200px] truncate" title={row.ghl_stage || '-'}>
                            {row.ghl_stage || '-'}
                          </span>
                        </TableCell>
                        <TableCell className={adminTdMuted}>
                          {latestNote ? (
                            <div className="text-xs">
                              <p className="font-medium text-foreground">
                                {formatStoredDateForDisplay(latestNote.created_at)}
                              </p>
                              <p className="text-muted-foreground">
                                {latestNote.reviewer_name || 'Unknown reviewer'}
                              </p>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">Not reviewed yet</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className={adminOutlineBtn}
                            onClick={(e) => {
                              e.stopPropagation()
                              openReviewDialog(row)
                            }}
                          >
                            Review
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          <Dialog
            open={reviewDialogRow != null}
            onOpenChange={(open) => {
              if (!open) closeReviewDialog()
            }}
          >
            <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto sm:max-w-2xl">
              {reviewDialogRow ? (
                <>
                  <DialogHeader>
                    <DialogTitle className="flex flex-wrap items-center gap-2">
                      Review Policy
                      <Badge
                        variant="outline"
                        className={cn(
                          (notesByPolicyId[reviewDialogRow.id] || []).length > 0
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {(notesByPolicyId[reviewDialogRow.id] || []).length > 0 ? 'Reviewed' : 'Pending'}
                      </Badge>
                    </DialogTitle>
                    <DialogDescription>
                      Update stage and add a review note for this policy.
                    </DialogDescription>
                  </DialogHeader>

                  <div className="grid gap-3 rounded-lg border border-border bg-muted/20 p-4 text-sm dark:border-slate-800">
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-muted-foreground">Name</p>
                        <p className="font-medium">{reviewDialogRow.name || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Policy #</p>
                        <p className="font-mono font-medium">{reviewDialogRow.policy_number}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Carrier</p>
                        <p>{reviewDialogRow.carrier || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Agent</p>
                        <p>{reviewDialogRow.sales_agent || '-'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Effective Date</p>
                        <p>
                          {reviewDialogRow.effective_date
                            ? formatStoredDateForDisplay(reviewDialogRow.effective_date)
                            : '-'}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Call Center</p>
                        <p>{reviewDialogRow.call_center || '-'}</p>
                      </div>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Current GHL Stage</p>
                      <p className="font-medium">{reviewDialogRow.ghl_stage || '-'}</p>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Manual Stage Move</label>
                      {stageActionOptions(reviewDialogRow.ghl_stage).length > 0 ? (
                        <Select
                          value={dialogNextStage || '__none__'}
                          onValueChange={(v) => setDialogNextStage(v === '__none__' ? '' : v)}
                        >
                          <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                            <SelectValue placeholder="Keep current stage" />
                          </SelectTrigger>
                          <SelectContent className={adminSelectContent}>
                            <SelectItem value="__none__" className={adminSelectItem}>
                              Keep current stage
                            </SelectItem>
                            {stageActionOptions(reviewDialogRow.ghl_stage).map((opt) => (
                              <SelectItem key={opt} value={opt} className={adminSelectItem}>
                                {opt}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <p className="text-sm text-muted-foreground">Notes only for this stage.</p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">Review Note</label>
                      <textarea
                        value={dialogNote}
                        onChange={(e) => setDialogNote(e.target.value)}
                        placeholder="Write your review note..."
                        className={cn(
                          'min-h-[120px] w-full rounded-md border border-input bg-background p-3 text-sm text-foreground',
                          'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        )}
                      />
                    </div>

                    {(notesByPolicyId[reviewDialogRow.id] || []).length > 0 ? (
                      <div className="space-y-2">
                        <p className="text-sm font-medium">Previous Reviews</p>
                        <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border p-2 dark:border-slate-800">
                          {(notesByPolicyId[reviewDialogRow.id] || []).map((n) => (
                            <div key={n.id} className="rounded-md border border-border/70 bg-muted/30 p-2 text-xs">
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
                      </div>
                    ) : null}
                  </div>

                  <DialogFooter className="gap-2 sm:gap-0">
                    <Button
                      type="button"
                      variant="outline"
                      className={adminOutlineBtn}
                      onClick={closeReviewDialog}
                      disabled={savingId === reviewDialogRow.id}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      onClick={() => saveReview(reviewDialogRow)}
                      disabled={savingId === reviewDialogRow.id}
                      className="bg-orange-600 text-white hover:bg-orange-700"
                    >
                      {savingId === reviewDialogRow.id ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Saving...
                        </>
                      ) : (
                        'Save Review'
                      )}
                    </Button>
                  </DialogFooter>
                </>
              ) : null}
            </DialogContent>
          </Dialog>

          {sortedRows.length > 0 && (
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

