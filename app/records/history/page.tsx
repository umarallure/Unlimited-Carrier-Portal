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
                <p className="text-slate-400">Loading version history…</p>
            </div>
        )
    }

    if (error || !record) {
        return (
            <div className="space-y-4">
                <Link href="/records">
                    <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to Records
                    </Button>
                </Link>
                <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 text-center">
                    <p className="text-slate-300">{error ?? 'Record not found.'}</p>
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
                    <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to Records
                    </Button>
                </Link>
                <div className="flex flex-wrap items-center gap-3">
                    <History className="w-6 h-6 text-orange-400 shrink-0" />
                    <div>
                        <h1 className="text-2xl font-bold text-white">
                            Version history — <span className="font-mono text-orange-300">{record.policy_number}</span>
                        </h1>
                        <p className="text-slate-400 text-sm mt-0.5">
                            This record has been updated {(record.version_history || []).length} time{(record.version_history || []).length === 1 ? '' : 's'}.
                        </p>
                    </div>
                </div>
            </div>

            <Tabs defaultValue="summary" className="space-y-4">
                <TabsList className="bg-slate-900 border border-slate-700">
                    <TabsTrigger value="summary" className="data-[state=active]:bg-slate-800 data-[state=active]:text-white">
                        Summary
                    </TabsTrigger>
                    <TabsTrigger value="timeline" className="data-[state=active]:bg-slate-800 data-[state=active]:text-white">
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
                            <div className="rounded-xl border border-slate-600 bg-slate-800/60 overflow-hidden">
                                <div className="px-4 py-3 border-b border-slate-600 bg-slate-800">
                                    <h2 className="text-sm font-semibold text-white">What changed in this update</h2>
                                    <p className="text-xs text-slate-400 mt-0.5">Before → After (current version)</p>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-slate-600">
                                                <th className="text-left py-2.5 px-4 font-medium text-slate-400">Field</th>
                                                <th className="text-left py-2.5 px-4 font-medium text-slate-400 w-[40%]">Before</th>
                                                <th className="text-left py-2.5 px-4 font-medium text-slate-400 w-[40%]">After</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {allRows.map(({ key, before, after }) => (
                                                <tr key={key} className="border-b border-slate-700/80 hover:bg-slate-700/30">
                                                    <td className="py-2 px-4 text-slate-300 font-medium shrink-0">{prettyKey(key)}</td>
                                                    <td className="py-2 px-4 text-slate-400 max-w-[200px] truncate" title={String(before)}>{before}</td>
                                                    <td className="py-2 px-4 text-emerald-300 font-medium max-w-[200px] truncate" title={String(after)}>{after}</td>
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
                        <div className="absolute left-[11px] md:left-[15px] top-0 bottom-0 w-0.5 bg-slate-700 rounded-full" aria-hidden />

                        <div className="space-y-6 pb-8">
                            {/* Current version */}
                            <div className="relative flex gap-4">
                        <div className="absolute -left-6 md:-left-8 top-6 w-4 h-4 rounded-full bg-orange-500 border-2 border-slate-900 shrink-0" aria-hidden />
                        <div className="flex-1 min-w-0 rounded-xl border border-orange-500/40 bg-slate-800/60 shadow-lg overflow-hidden">
                            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/80">
                                <span className="text-xs font-semibold text-orange-400 uppercase tracking-wide">Current version</span>
                                {record.updated_at && (
                                    <span className="ml-2 text-slate-500 text-xs">
                                        As of {new Date(record.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                                    </span>
                                )}
                            </div>
                            <div className="p-4 space-y-3">
                              <div className="flex items-center justify-between gap-3">
                                <p className="text-xs text-slate-400">
                                  Showing {expandedCurrent ? 'all fields' : 'only important fields that changed'} in this version.
                                </p>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  className="h-7 px-2 text-xs border-slate-600 text-slate-200 hover:bg-slate-700"
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
                                            ? 'text-emerald-300 font-semibold'
                                            : 'text-slate-500')
                                        }
                                      >
                                        {prettyKey(key)}:
                                      </dt>
                                      <dd
                                        className={
                                          'truncate min-w-0 ' +
                                          (currentChangedKeys.has(key)
                                            ? 'text-emerald-300 font-semibold'
                                            : 'text-slate-200')
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
                        return (
                            <div key={idx} className="relative flex gap-4">
                                <div className="absolute -left-6 md:-left-8 top-6 w-4 h-4 rounded-full bg-slate-600 border-2 border-slate-900 shrink-0" aria-hidden />
                                <div className="flex-1 min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 shadow overflow-hidden">
                                    <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/60">
                                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                                            Before this update
                                        </span>
                                        <span className="ml-2 text-slate-500 text-xs">
                                            {entry.at ? new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–'}
                                            {idx === 0 && ' (replaced by current version above)'}
                                        </span>
                                    </div>
                                    <div className="p-4 space-y-3">
                                      {idx === 0 && (
                                        <p className="mb-1 text-xs text-slate-400">
                                          Snapshot of this record before the latest update. See &quot;What changed in this update&quot; above for the exact before → after values.
                                        </p>
                                      )}
                                      <div className="flex items-center justify-between gap-3">
                                        <p className="text-xs text-slate-400">
                                          Showing {expandedTimeline[idx] ? 'all fields' : 'only important fields that changed'} in this snapshot.
                                        </p>
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="h-7 px-2 text-xs border-slate-600 text-slate-200 hover:bg-slate-700"
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
                                                      ? 'text-amber-300 font-semibold'
                                                      : 'text-slate-500')
                                                  }
                                                >
                                                  {prettyKey(key)}:
                                                </dt>
                                                <dd
                                                  className={
                                                    'truncate min-w-0 ' +
                                                    (changedKeys.has(key)
                                                      ? 'text-amber-300 font-semibold'
                                                      : 'text-slate-300')
                                                  }
                                                >
                                                  {String(val)}
                                                </dd>
                                              </span>
                                            )
                                          })}
                                        </dl>
                                      ) : (
                                        <p className="text-slate-500 text-sm">No snapshot data.</p>
                                      )}
                                    </div>
                                </div>
                            </div>
                        )
                            })}

                            {(!record.version_history || record.version_history.length === 0) && (
                                <div className="relative flex gap-4">
                                    <div className="absolute -left-6 md:-left-8 top-4 w-4 h-4 rounded-full bg-slate-700 border-2 border-slate-900 shrink-0" aria-hidden />
                                    <p className="text-slate-500 text-sm pl-2">No previous versions (record has not been updated since creation).</p>
                                </div>
                            )}
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </div>
    )
}
