'use client'

import { useState, useEffect, use } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabaseClient'
import { Button } from '@/components/ui/button'
import { History, ArrowLeft, Loader2 } from 'lucide-react'

const EXCLUDE_KEYS = ['id', 'agency_carrier_id', 'file_id', 'row_number', 'source_file', 'source_format', 'agency_carriers', 'version_history', 'raw_data', 'file_type', 'carrier_code', 'table']

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

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
                <Link href="/records">
                    <Button variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to Records
                    </Button>
                </Link>
                <div className="flex items-center gap-2">
                    <History className="w-6 h-6 text-orange-400" />
                    <h1 className="text-2xl font-bold text-white">
                        Version history — <span className="font-mono text-orange-300">{record.policy_number}</span>
                    </h1>
                </div>
            </div>

            {/* Journey timeline: vertical line + cards */}
            <div className="relative pl-6 md:pl-8">
                {/* Vertical line */}
                <div className="absolute left-[11px] md:left-[15px] top-0 bottom-0 w-0.5 bg-slate-700 rounded-full" aria-hidden />

                <div className="space-y-6 pb-8">
                    {/* Current (first step) */}
                    <div className="relative flex gap-4">
                        <div className="absolute -left-6 md:-left-8 top-6 w-4 h-4 rounded-full bg-orange-500 border-2 border-slate-900 shrink-0" aria-hidden />
                        <div className="flex-1 min-w-0 rounded-xl border border-orange-500/40 bg-slate-800/60 shadow-lg overflow-hidden">
                            <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/80">
                                <span className="text-xs font-semibold text-orange-400 uppercase tracking-wide">Current</span>
                                {record.updated_at && (
                                    <span className="ml-2 text-slate-500 text-xs">
                                        Updated {new Date(record.updated_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                                    </span>
                                )}
                            </div>
                            <div className="p-4">
                                {prevFlats.length > 0 && (() => {
                                    const d = diff(prevFlats[0], currentFlat)
                                    const hasChanges = d.added.length + d.removed.length + d.changed.length > 0
                                    return hasChanges ? (
                                        <div className="mb-4 rounded-lg bg-slate-900/80 border border-slate-600 p-3 text-xs">
                                            <span className="font-medium text-slate-300">What changed from previous:</span>
                                            <ul className="mt-2 space-y-1 text-slate-200">
                                                {d.changed.map(([key, oldVal, newVal]) => (
                                                    <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="line-through text-red-400/90">{oldVal}</span> → <span className="text-emerald-400">{newVal}</span></li>
                                                ))}
                                                {d.added.map(([key, val]) => (
                                                    <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-emerald-400">added: {val}</span></li>
                                                ))}
                                                {d.removed.map(([key, val]) => (
                                                    <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-red-400/90">removed (was: {val})</span></li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null
                                })()}
                                <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                    {Object.entries(currentFlat).map(([key, val]) => (
                                        <span key={key} className="flex gap-2">
                                            <dt className="text-slate-500 shrink-0">{key.replace(/_/g, ' ')}:</dt>
                                            <dd className="text-slate-200 truncate min-w-0">{String(val)}</dd>
                                        </span>
                                    ))}
                                </dl>
                            </div>
                        </div>
                    </div>

                    {/* Previous versions (journey steps) */}
                    {historyReversed.map((entry: any, idx: number) => {
                        const thisFlat = prevFlats[idx] || {}
                        const nextFlat = idx === 0 ? currentFlat : prevFlats[idx - 1]
                        const d = diff(thisFlat, nextFlat)
                        const hasChanges = d.added.length + d.removed.length + d.changed.length > 0
                        return (
                            <div key={idx} className="relative flex gap-4">
                                <div className="absolute -left-6 md:-left-8 top-6 w-4 h-4 rounded-full bg-slate-600 border-2 border-slate-900 shrink-0" aria-hidden />
                                <div className="flex-1 min-w-0 rounded-xl border border-slate-700 bg-slate-800/40 shadow overflow-hidden">
                                    <div className="px-4 py-3 border-b border-slate-700 bg-slate-800/60">
                                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                                            Previous — {entry.at ? new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '–'}
                                        </span>
                                    </div>
                                    <div className="p-4">
                                        {hasChanges && (
                                            <div className="mb-4 rounded-lg bg-slate-900/80 border border-slate-600 p-3 text-xs">
                                                <span className="font-medium text-slate-300">What changed in next version:</span>
                                                <ul className="mt-2 space-y-1 text-slate-200">
                                                    {d.changed.map(([key, oldVal, newVal]) => (
                                                        <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="line-through text-red-400/90">{oldVal}</span> → <span className="text-emerald-400">{newVal}</span></li>
                                                    ))}
                                                    {d.added.map(([key, val]) => (
                                                        <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-emerald-400">added: {val}</span></li>
                                                    ))}
                                                    {d.removed.map(([key, val]) => (
                                                        <li key={key}><span className="text-slate-500">{key.replace(/_/g, ' ')}:</span> <span className="text-red-400/90">removed (was: {val})</span></li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                        {Object.keys(thisFlat).length > 0 ? (
                                            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2 text-sm">
                                                {Object.entries(thisFlat).map(([key, val]) => (
                                                    <span key={key} className="flex gap-2">
                                                        <dt className="text-slate-500 shrink-0">{key.replace(/_/g, ' ')}:</dt>
                                                        <dd className="text-slate-300 truncate min-w-0">{String(val)}</dd>
                                                    </span>
                                                ))}
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
        </div>
    )
}
