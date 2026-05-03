'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { History, ArrowLeft, Loader2 } from 'lucide-react'

const EXCLUDE_KEYS = [
    'id',
    'agency_carrier_id',
    'carrier_id',
    'file_id',
    'row_number',
    'source_file',
    'source_format',
    'agency_carriers',
    'version_history',
    'raw_data',
    'file_type',
    'carrier_code',
    'table',
    // Technical tracking / metadata fields users don't need to see per version
    'daily_deal_flow_fetched',
    'daily_deal_flow_fetched_at',
    'source_policy_table',
    'source_policy_id',
    'source_commission_table',
    'source_commission_id',
    'created_at',
    'updated_at',
    // Attribution columns — surfaced separately in the per-card header, not in the field grid
    'last_changed_by_file_id',
    'last_changed_by_file_name',
    'last_changed_by_user_id',
    'last_changed_by_user_email',
]

// Keys that matter most to business users and should be emphasized in diffs.
const IMPORTANT_KEYS = [
  'policy_status',
  'carrier_status',
  'status',
  'deal_value',
  'cc_value',
  'charge_back',
  'advance_amount',
  'charge_back_amount',
  'commission_rate',
  'effective_date',
  'deal_creation_date',
  'sales_agent',
  'writing_number',
  'call_center',
  'phone_number',
]

// Which fields to actually display in the grids (and in what order).
// This guarantees CURRENT and PREVIOUS cards show the same set of business-relevant fields.
const DISPLAY_KEYS = [
    'name',
    'carrier',
    'policy_number',
    // Deal tracker date/value fields
    'deal_creation_date',
    'effective_date',
    'policy_status',
    'carrier_status',
    'status',
    'deal_value',
    'cc_value',
    'charge_back',
    // Commission tracker value fields
    'date',
    'commission_rate',
    'advance_amount',
    'charge_back_amount',
    'call_center',
    'phone_number',
    'sales_agent',
    'writing_number',
    'policy_type',
    'ghl_stage',
    'ghl_name',
]

// Friendly labels for key fields
const LABELS: Record<string, string> = {
  policy_status: 'Policy Status',
  carrier_status: 'Carrier Status',
  status: 'Status',
  deal_value: 'Deal Value',
  cc_value: 'CC Value',
  charge_back: 'Charge Back',
  effective_date: 'Effective Date',
  deal_creation_date: 'Deal Creation Date',
  sales_agent: 'Sales Agent',
  writing_number: 'Writing #',
  call_center: 'Call Center',
  phone_number: 'Phone Number',
  name: 'Name',
  policy_number: 'Policy Number',
  carrier: 'Carrier',
  date: 'Date',
  advance_amount: 'Advance',
  charge_back_amount: 'Charge Back',
  commission_rate: 'Commission Rate',
  policy_type: 'Policy Type',
  ghl_stage: 'GHL Stage',
  ghl_name: 'GHL Name',
}

function prettyKey(key: string) {
  return LABELS[key] ?? key.replace(/_/g, ' ')
}

function toFlat(obj: any): Record<string, string> {
    if (!obj || typeof obj !== 'object') return {}
    return Object.fromEntries(
        Object.entries(obj)
            .filter(([k, v]) => !EXCLUDE_KEYS.includes(k) && v != null && typeof v !== 'object')
            .map(([k, v]) => [k, String(v)])
    )
}

function attributionFrom(source: any): { fileName: string | null; userEmail: string | null } | null {
    if (!source || typeof source !== 'object') return null
    const fileName = source.last_changed_by_file_name ? String(source.last_changed_by_file_name) : null
    const userEmail = source.last_changed_by_user_email ? String(source.last_changed_by_user_email) : null
    if (!fileName && !userEmail) return null
    return { fileName, userEmail }
}

function AttributionLine({ source, label }: { source: any; label: string }) {
    const attr = attributionFrom(source)
    if (!attr) return null
    return (
        <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{label}: </span>
            {attr.fileName ? <span className="font-mono">{attr.fileName}</span> : <span className="italic">manual change</span>}
            {attr.userEmail && (
                <>
                    <span> · by </span>
                    <span className="font-medium">{attr.userEmail}</span>
                </>
            )}
        </p>
    )
}

function diff(oldMap: Record<string, string>, newMap: Record<string, string>) {
    const added: [string, string][] = []
    const removed: [string, string][] = []
    const changed: [string, string, string][] = []
    const allKeys = new Set([...Object.keys(oldMap), ...Object.keys(newMap)])
    allKeys.forEach(key => {
        const o = oldMap[key]
        const n = newMap[key]
        if (o === undefined && n !== undefined) added.push([key, n])
        else if (o !== undefined && n === undefined) removed.push([key, o])
        else if (o !== undefined && n !== undefined && o !== n) changed.push([key, o, n])
    })
    return { added, removed, changed }
}

export default function RecordHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
    const params = use(searchParams)
    const tableName = params?.table ?? ''
    const recordId = params?.id ?? ''
    const [record, setRecord] = useState<any>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [expandedCurrent, setExpandedCurrent] = useState(false)
    const [expandedTimeline, setExpandedTimeline] = useState<Record<number, boolean>>({})

    useEffect(() => {
        if (!tableName || !recordId) {
            setError('Missing record. Use the History link from the Records table.')
            setLoading(false)
            return
        }
        let cancelled = false
        ;(async () => {
            const { data, error: fetchError } = await supabase
                .from(tableName)
                .select('*')
                .eq('id', recordId)
                .single()
            if (cancelled) return
            if (fetchError) {
                setError(fetchError.message || 'Failed to load record')
                setRecord(null)
            } else {
                setRecord({
                    ...data,
                    version_history: Array.isArray(data?.version_history) ? data.version_history : [],
                })
                setError(null)
            }
            setLoading(false)
        })()
        return () => { cancelled = true }
    }, [tableName, recordId])

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
                <Loader2 className="w-10 h-10 animate-spin text-orange-400" />
                <p className="text-muted-foreground">Loading version history…</p>
            </div>
        )
    }

    if (error || !record) {
        return (
            <div className="space-y-4">
                <Link href="/records">
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Records
                    </Button>
                </Link>
                <div className="rounded-xl border border-border bg-card p-6 text-center">
                    <p className="text-muted-foreground">{error ?? 'Record not found.'}</p>
                </div>
            </div>
        )
    }

    const currentFlat = toFlat(record)
    const historyReversed = (record.version_history || []).slice().reverse()
    const prevFlats = historyReversed.map((e: any) => toFlat(e?.snapshot))

    // Use a consistent field order for CURRENT and all PREVIOUS cards, restricted to DISPLAY_KEYS
    const fieldOrder = DISPLAY_KEYS.filter((key) => {
        if (currentFlat[key] !== undefined) return true
        return prevFlats.some((m: Record<string, string>) => m && m[key] !== undefined)
    })

    // Precompute diff for current vs most recent previous snapshot
    const currentDiff = prevFlats.length > 0 ? diff(prevFlats[0], currentFlat) : { added: [], removed: [], changed: [] }
    const currentChangedKeys = new Set<string>()
    ;[...currentDiff.changed, ...currentDiff.added, ...currentDiff.removed].forEach(([key]) => {
        currentChangedKeys.add(key)
    })

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
                <Link href="/records">
                    <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Back to Records
                    </Button>
                </Link>
                <div className="flex flex-wrap items-center gap-3">
                    <History className="h-6 w-6 shrink-0 text-orange-500 dark:text-orange-400" />
                    <div>
                        <h1 className="text-2xl font-bold text-foreground">
                            Version history — <span className="font-mono text-orange-600 dark:text-orange-300">{record.policy_number}</span>
                        </h1>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                            This record has been updated {(record.version_history || []).length} time{(record.version_history || []).length === 1 ? '' : 's'}.
                        </p>
                    </div>
                </div>
            </div>

            <Tabs defaultValue="summary" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="summary">
                        Summary
                    </TabsTrigger>
                    <TabsTrigger value="timeline">
                        Timeline
                    </TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="space-y-4">
                    {/* Single "What changed" summary at top — one place to see all differences */}
                    {prevFlats.length > 0 && (() => {
                        const d = currentDiff
                        const changedRows = d.changed.map(([key, oldVal, newVal]) => ({ key, before: oldVal, after: newVal }))
                        const addedRows = d.added.map(([key, val]) => ({ key, before: '—', after: val }))
                        const removedRows = d.removed.map(([key, val]) => ({ key, before: val, after: '—' }))
                        const allRows = [...changedRows, ...addedRows, ...removedRows].filter(({ key }) => DISPLAY_KEYS.includes(key) || IMPORTANT_KEYS.includes(key))
                        if (allRows.length === 0) return null
                        return (
                            <div className="overflow-hidden rounded-xl border border-border bg-card">
                                <div className="border-b border-border bg-muted/50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                                    <h2 className="text-sm font-semibold text-foreground">What changed in this update</h2>
                                    <p className="mt-0.5 text-xs text-muted-foreground">Before → After (current version)</p>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-border dark:border-slate-600">
                                                <th className="px-4 py-2.5 text-left font-medium text-muted-foreground">Field</th>
                                                <th className="w-[40%] px-4 py-2.5 text-left font-medium text-muted-foreground">Before</th>
                                                <th className="w-[40%] px-4 py-2.5 text-left font-medium text-muted-foreground">After</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {allRows.map(({ key, before, after }) => (
                                                <tr key={key} className="border-b border-border hover:bg-muted/50 dark:border-slate-700/80 dark:hover:bg-slate-700/30">
                                                    <td className="shrink-0 px-4 py-2 font-medium text-foreground dark:text-slate-300">{prettyKey(key)}</td>
                                                    <td className="max-w-[200px] truncate px-4 py-2 text-muted-foreground" title={String(before)}>{before}</td>
                                                    <td className="max-w-[200px] truncate px-4 py-2 font-medium text-emerald-700 dark:text-emerald-300" title={String(after)}>{after}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )
                    })()}
                </TabsContent>

                <TabsContent value="timeline">
                    {/* Timeline: current then previous snapshots */}
                    <div className="relative pl-6 md:pl-8">
                        <div className="absolute bottom-0 left-[11px] top-0 w-0.5 rounded-full bg-border dark:bg-slate-700" aria-hidden />

                        <div className="space-y-6 pb-8">
                            {/* Current version */}
                            <div className="relative flex gap-4">
                        <div className="absolute -left-6 top-6 h-4 w-4 shrink-0 rounded-full border-2 border-background bg-orange-500 dark:border-slate-900 md:-left-8" aria-hidden />
                        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-orange-500/40 bg-card shadow-lg dark:bg-slate-800/60">
                            <div className="border-b border-border bg-muted/50 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/80">
                                <span className="text-xs font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">Current version</span>
                                {record.updated_at && (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                        As of {new Date(record.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                                    </span>
                                )}
                                <AttributionLine source={record} label="Triggered by" />
                            </div>
                            <div className="space-y-3 p-4">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs text-muted-foreground">
                                  Showing {expandedCurrent ? 'all fields' : 'only important fields that changed'} in this version.
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 border-border px-2 text-xs text-foreground hover:bg-muted dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                  onClick={() => setExpandedCurrent(v => !v)}
                                >
                                  {expandedCurrent ? 'Hide details' : 'Show full snapshot'}
                                </Button>
                              </div>
                              <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                                {fieldOrder.map((key) => {
                                  const val = currentFlat[key]
                                  if (val === undefined) return null
                                  const isHeadline = IMPORTANT_KEYS.includes(key)
                                  if (!expandedCurrent && (!isHeadline || !currentChangedKeys.has(key))) return null
                                  return (
                                    <span key={key} className="flex gap-2">
                                      <dt
                                        className={
                                          'shrink-0 ' +
                                          (currentChangedKeys.has(key)
                                            ? 'font-semibold text-emerald-700 dark:text-emerald-300'
                                            : 'text-muted-foreground')
                                        }
                                      >
                                        {prettyKey(key)}:
                                      </dt>
                                      <dd
                                        className={
                                          'min-w-0 truncate ' +
                                          (currentChangedKeys.has(key)
                                            ? 'font-semibold text-emerald-700 dark:text-emerald-300'
                                            : 'text-foreground dark:text-slate-200')
                                        }
                                      >
                                        {String(val)}
                                      </dd>
                                    </span>
                                  )
                                })}
                              </dl>
                            </div>
                        </div>
                    </div>

                            {/* Previous versions (snapshots before each update) */}
                            {historyReversed.map((entry: any, idx: number) => {
                        const thisFlat = prevFlats[idx] || {}
                        const nextFlat = idx === 0 ? currentFlat : prevFlats[idx - 1]
                        const d = diff(thisFlat, nextFlat)
                        const changedKeys = new Set<string>()
                        ;[...d.changed, ...d.added, ...d.removed].forEach(([key]) => changedKeys.add(key))
                        // The file/user that REPLACED this snapshot lives on the next-newer entry
                        // (or the current row when idx === 0).
                        const triggerSource = idx === 0 ? record : historyReversed[idx - 1]?.snapshot
                        return (
                            <div key={idx} className="relative flex gap-4">
                                <div className="absolute -left-6 top-6 h-4 w-4 shrink-0 rounded-full border-2 border-background bg-muted-foreground/40 dark:border-slate-900 dark:bg-slate-600 md:-left-8" aria-hidden />
                                <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-border bg-muted/30 shadow dark:border-slate-700 dark:bg-slate-800/40">
                                    <div className="border-b border-border bg-muted/40 px-4 py-3 dark:border-slate-700 dark:bg-slate-800/60">
                                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                            Before this update
                                        </span>
                                        <span className="ml-2 text-xs text-muted-foreground">
                                            {entry.at ? new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–'}
                                            {idx === 0 && ' (replaced by current version above)'}
                                        </span>
                                        <AttributionLine source={triggerSource} label="Replaced by" />
                                    </div>
                                    <div className="p-4 space-y-3">
                                      {idx === 0 && (
                                        <p className="mb-1 text-xs text-muted-foreground">
                                          Snapshot of this record before the latest update. See &quot;What changed in this update&quot; above for the exact before → after values.
                                        </p>
                                      )}
                                      <div className="flex items-center justify-between gap-3">
                                        <p className="text-xs text-muted-foreground">
                                          Showing {expandedTimeline[idx] ? 'all fields' : 'only important fields that changed'} in this snapshot.
                                        </p>
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="h-7 border-border px-2 text-xs text-foreground hover:bg-muted dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                                          onClick={() =>
                                            setExpandedTimeline(prev => ({ ...prev, [idx]: !prev[idx] }))
                                          }
                                        >
                                          {expandedTimeline[idx] ? 'Hide details' : 'Show full snapshot'}
                                        </Button>
                                      </div>
                                      {Object.keys(thisFlat).length > 0 ? (
                                        <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-x-4 gap-y-2 text-sm">
                                          {fieldOrder.map((key) => {
                                            const val = thisFlat[key]
                                            if (val === undefined) return null
                                            const isHeadline = IMPORTANT_KEYS.includes(key)
                                            if (!expandedTimeline[idx] && (!isHeadline || !changedKeys.has(key))) return null
                                            return (
                                              <span key={key} className="flex gap-2">
                                                <dt
                                                  className={
                                                    'shrink-0 ' +
                                                    (changedKeys.has(key)
                                                      ? 'font-semibold text-amber-700 dark:text-amber-300'
                                                      : 'text-muted-foreground')
                                                  }
                                                >
                                                  {prettyKey(key)}:
                                                </dt>
                                                <dd
                                                  className={
                                                    'min-w-0 truncate ' +
                                                    (changedKeys.has(key)
                                                      ? 'font-semibold text-amber-700 dark:text-amber-300'
                                                      : 'text-muted-foreground dark:text-slate-300')
                                                  }
                                                >
                                                  {String(val)}
                                                </dd>
                                              </span>
                                            )
                                          })}
                                        </dl>
                                      ) : (
                                        <p className="text-sm text-muted-foreground">No snapshot data.</p>
                                      )}
                                    </div>
                                </div>
                            </div>
                        )
                            })}

                            {(!record.version_history || record.version_history.length === 0) && (
                                <div className="relative flex gap-4">
                                    <div className="absolute -left-6 top-4 h-4 w-4 shrink-0 rounded-full border-2 border-background bg-muted-foreground/50 dark:border-slate-900 dark:bg-slate-700 md:-left-8" aria-hidden />
                                    <p className="pl-2 text-sm text-muted-foreground">No previous versions (record has not been updated since creation).</p>
                                </div>
                            )}
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    )
}
