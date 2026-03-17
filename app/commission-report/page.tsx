'use client'

import { Fragment, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Calendar, Loader2, Search } from 'lucide-react'

type CommissionRow = {
  id?: string
  agency_carrier_id: string
  carrier_id: string | null
  carrier: string
  policy_number: string
  name: string | null
  sales_agent: string | null
  date: string
  commission_rate: number | null
  advance_amount: number | null
  charge_back_amount: number | null
  version_history?: any[]
  source_table?: string | null
}

type CarrierRecord = {
  id: string
  name: string
  code: string | null
}

type CarrierFilter = 'ALL' | 'AMAM' | 'AETNA'

export default function CommissionReportPage() {
  const [rows, setRows] = useState<CommissionRow[]>([])
  const [allRows, setAllRows] = useState<CommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [carrierCode, setCarrierCode] = useState<CarrierFilter>('ALL')
  const [searchTerm, setSearchTerm] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [carrierCodeById, setCarrierCodeById] = useState<Map<string, string | null>>(new Map())
  const [carrierCodeByName, setCarrierCodeByName] = useState<Map<string, string | null>>(new Map())
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [expandedKey, setExpandedKey] = useState<string | null>(null)

  useEffect(() => {
    const fetchAllCommissionRows = async () => {
      setLoading(true)
      try {
        const PAGE_SIZE = 1000
        let all: CommissionRow[] = []
        let from = 0

        while (true) {
          const to = from + PAGE_SIZE - 1
          const { data, error } = await supabase
            .from<any, CommissionRow>('commission_tracker')
            .select('*')
            .order('date', { ascending: false })
            .range(from, to)

          if (error) {
            console.error('Error loading commission report:', error)
            all = []
            break
          }

          const chunk = data || []
          all = all.concat(chunk)

          if (chunk.length < PAGE_SIZE) {
            break
          }

          from = to + 1
        }

        // Keep all normalized commission_tracker rows so we can:
        // - Aggregate per policy for the main table (sum advance/chargeback),
        // - And still show every individual transaction when a row is expanded.
        setAllRows(all)

        // Collapse to one display row per (agency_carrier, policy, carrier)
        // using the most recent date row as the "header" for that policy.
        const byKey = new Map<string, CommissionRow>()
        const parseDate = (d: string): number => {
          const dt = new Date(String(d).split('to')[0].trim().replace(/\./g, '-').replace(/\//g, '-'))
          return isNaN(dt.getTime()) ? 0 : dt.getTime()
        }
        for (const row of all) {
          const key = `${row.agency_carrier_id}::${row.policy_number}::${row.carrier}`
          const existing = byKey.get(key)
          if (!existing) {
            byKey.set(key, row)
            continue
          }
          if (parseDate(row.date) > parseDate(existing.date)) {
            byKey.set(key, row)
          }
        }

        setRows(Array.from(byKey.values()))

        // Fetch carrier codes once for mapping name/id -> code
        const { data: carriers, error: carriersError } = await supabase
          .from<any, CarrierRecord>('carriers')
          .select('id, name, code')

        if (!carriersError && carriers) {
          const byId = new Map<string, string | null>()
          const byName = new Map<string, string | null>()
          carriers.forEach(c => {
            byId.set(c.id, c.code)
            byName.set(c.name, c.code)
          })
          setCarrierCodeById(byId)
          setCarrierCodeByName(byName)
        }
      } catch (err) {
        console.error('Error loading commission report:', err)
        setRows([])
        setAllRows([])
      } finally {
        setLoading(false)
      }
    }

    fetchAllCommissionRows()
  }, [])

  const normalizeDate = (value: any): Date | null => {
    if (!value) return null
    // NOTE: We now display the raw YYYY-MM-DD string in the UI to avoid
    // timezone shifting, but still use Date objects internally only for
    // comparisons and sorting.
    const str = String(value).trim()
    if (!str) return null
    const rangePart = str.split('to')[0].trim()
    const parsed = new Date(rangePart.replace(/\./g, '-').replace(/\//g, '-'))
    return isNaN(parsed.getTime()) ? null : parsed
  }

  const filtered = rows.filter(row => {
    const name = row.name ?? ''
    const policy = row.policy_number ?? ''
    const salesAgent = row.sales_agent ?? ''

    const dt = normalizeDate(row.date)

    if (dateFrom) {
      const from = new Date(dateFrom)
      if (!dt || dt < from) return false
    }
    if (dateTo) {
      const to = new Date(dateTo)
      if (!dt || dt > to) return false
    }

    // Carrier filter using carrier codes when possible
    const code =
      (row.carrier_id && carrierCodeById.get(row.carrier_id)) ??
      carrierCodeByName.get(row.carrier) ??
      row.carrier.toUpperCase()

    if (carrierCode === 'AMAM') {
      if (code !== 'AMAM') return false
    } else if (carrierCode === 'AETNA') {
      if (code !== 'AETNA') return false
    }

    if (!searchTerm) return true
    const q = searchTerm.toLowerCase()
    return (
      String(name).toLowerCase().includes(q) ||
      String(policy).toLowerCase().includes(q) ||
      String(salesAgent).toLowerCase().includes(q)
    )
  })

  // Reset to first page when filters change
  useEffect(() => {
    setCurrentPage(1)
    setExpandedKey(null)
  }, [carrierCode, searchTerm, dateFrom, dateTo])

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginated = filtered.slice(startIndex, endIndex)

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      <div className="flex items-center space-x-3">
        <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
          <span className="text-lg font-semibold text-orange-400">$</span>
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white">Commission Report</h1>
          <p className="text-gray-400">
            Read-only view of normalized commission rows from all carriers, formatted like your Excel report.
          </p>
        </div>
      </div>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800">
          <CardTitle className="text-white text-base">Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-4">
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative min-w-[220px] flex-1 max-w-sm">
              <Search className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                placeholder="Search by name, policy number, or sales agent..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-8 h-9 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500 text-sm"
              />
            </div>

            <Select value={carrierCode} onValueChange={value => setCarrierCode(value as CarrierFilter)}>
              <SelectTrigger className="h-9 w-[160px] bg-slate-950 border-slate-800 text-white text-sm">
                <SelectValue placeholder="Select carrier" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="ALL" className="text-white">
                  All Carriers
                </SelectItem>
                <SelectItem value="AMAM" className="text-white">
                  AMAM
                </SelectItem>
                <SelectItem value="AETNA" className="text-white">
                  Aetna
                </SelectItem>
              </SelectContent>
            </Select>

            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-orange-400 shrink-0" />
              <Input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white w-[150px] h-9 text-sm"
                title="From date"
              />
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-orange-400 shrink-0" />
              <Input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white w-[150px] h-9 text-sm"
                title="To date"
              />
            </div>

            {(searchTerm || dateFrom || dateTo) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchTerm('')
                  setDateFrom('')
                  setDateTo('')
                }}
                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800"
              >
                Clear filters
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800 flex flex-row items-center justify-between">
          <CardTitle className="text-white text-base">
            Commission report table{' '}
            <span className="text-xs text-slate-400 font-normal">
              ({filtered.length} row{filtered.length === 1 ? '' : 's'})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-300 font-semibold">Name</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Date</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Commission Rate</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Advance</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-right">Charge Back</TableHead>
                  <TableHead className="text-slate-300 font-semibold text-center">Transactions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-orange-400 mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-slate-400 py-8">
                      No commission rows found for the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((row, idx) => {
                    const name = row.name || '-'
                    const policyNumber = row.policy_number || '-'
                    const carrierCodeDisplay =
                      (row.carrier_id && carrierCodeById.get(row.carrier_id)) ??
                      carrierCodeByName.get(row.carrier) ??
                      row.carrier
                    const salesAgent = row.sales_agent || '-'
                    const commissionRate = row.commission_rate

                    const key = `${row.agency_carrier_id}::${row.policy_number}::${row.carrier}`
                    const detailRows = allRows.filter(r =>
                      r.agency_carrier_id === row.agency_carrier_id &&
                      r.policy_number === row.policy_number &&
                      r.carrier === row.carrier
                    )

                    const advanceTotal = detailRows.reduce((sum, r) => sum + (r.advance_amount ?? 0), 0)
                    const chargeBackTotal = detailRows.reduce((sum, r) => sum + (r.charge_back_amount ?? 0), 0)
                    const transactionCount = detailRows.length || 1

                    const formatMoney = (v: any) => {
                      if (v == null || v === '') return ''
                      const num = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
                      if (isNaN(num)) return String(v)
                      return num.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })
                    }

                    return (
                      <Fragment key={row.id || `${policyNumber}-${idx}`}>
                        <TableRow className="border-b border-slate-800 hover:bg-slate-800/40">
                          <TableCell className="text-slate-100">{name}</TableCell>
                          <TableCell className="text-slate-300">
                            {row.date || '-'}
                          </TableCell>
                          <TableCell className="text-slate-300 font-mono text-sm">{policyNumber}</TableCell>
                          <TableCell className="text-slate-300">{carrierCodeDisplay}</TableCell>
                          <TableCell className="text-slate-300">{salesAgent}</TableCell>
                          <TableCell className="text-slate-300 text-right">
                            {commissionRate != null ? String(commissionRate) : ''}
                          </TableCell>
                          <TableCell className="text-slate-300 text-right">
                            {advanceTotal !== 0 ? formatMoney(advanceTotal) : ''}
                          </TableCell>
                          <TableCell className="text-slate-300 text-right">
                            {chargeBackTotal !== 0 ? formatMoney(chargeBackTotal) : ''}
                          </TableCell>
                          <TableCell className="text-center text-slate-300 text-sm whitespace-nowrap">
                            {transactionCount > 1 ? (
                              <button
                                type="button"
                                onClick={() => setExpandedKey(prev => (prev === key ? null : key))}
                                className="inline-flex items-center px-2 py-1.5 rounded-md text-orange-400 hover:text-orange-300 hover:bg-slate-800 transition-colors"
                                title="View individual commission transactions for this policy"
                              >
                                <span className="font-mono mr-1">{transactionCount}</span>
                                <span>{expandedKey === key ? 'Hide' : 'Details'}</span>
                              </button>
                            ) : (
                              <span className="text-slate-500">1</span>
                            )}
                          </TableCell>
                        </TableRow>
                        {expandedKey === key && transactionCount > 1 && (
                          <TableRow className="border-b border-slate-900 bg-slate-950/60">
                            <TableCell colSpan={9} className="p-0">
                              <div className="px-4 py-3 border-t border-slate-800">
                                <div className="text-xs font-semibold text-slate-300 mb-2">
                                  Individual commission transactions for policy {policyNumber}
                                </div>
                                <div className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950/80">
                                  <Table>
                                    <TableHeader>
                                      <TableRow className="border-b border-slate-800">
                                        <TableHead className="text-slate-300 text-xs">Date</TableHead>
                                        <TableHead className="text-slate-300 text-xs">Name</TableHead>
                                        <TableHead className="text-slate-300 text-xs">Sales Agent</TableHead>
                                        <TableHead className="text-slate-300 text-xs text-right">Commission Rate</TableHead>
                                        <TableHead className="text-slate-300 text-xs text-right">Advance</TableHead>
                                        <TableHead className="text-slate-300 text-xs text-right">Charge Back</TableHead>
                                        <TableHead className="text-slate-300 text-xs">Source</TableHead>
                                      </TableRow>
                                    </TableHeader>
                                    <TableBody>
                                      {detailRows
                                        .slice()
                                        .sort((a, b) => {
                                          const da = normalizeDate(a.date)?.getTime() ?? 0
                                          const db = normalizeDate(b.date)?.getTime() ?? 0
                                          return da - db
                                        })
                                        .map((tx, i) => {
                                          return (
                                            <TableRow key={tx.id || `${key}-tx-${i}`} className="border-b border-slate-900/60">
                                              <TableCell className="text-slate-300 text-xs">
                                                {tx.date || '-'}
                                              </TableCell>
                                              <TableCell className="text-slate-200 text-xs">
                                                {tx.name || '-'}
                                              </TableCell>
                                              <TableCell className="text-slate-300 text-xs">
                                                {tx.sales_agent || '-'}
                                              </TableCell>
                                              <TableCell className="text-slate-300 text-right text-xs">
                                                {tx.commission_rate != null ? String(tx.commission_rate) : ''}
                                              </TableCell>
                                              <TableCell className="text-slate-300 text-right text-xs">
                                                {tx.advance_amount != null ? formatMoney(tx.advance_amount) : ''}
                                              </TableCell>
                                              <TableCell className="text-slate-300 text-right text-xs">
                                                {tx.charge_back_amount != null ? formatMoney(tx.charge_back_amount) : ''}
                                              </TableCell>
                                              <TableCell className="text-slate-400 text-xs">
                                                {tx.source_table || ''}
                                              </TableCell>
                                            </TableRow>
                                          )
                                        })}
                                    </TableBody>
                                  </Table>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {filtered.length > 0 && (
        <div className="flex items-center justify-between px-4 py-3 border border-slate-800 bg-slate-900/50 rounded-lg">
          <div className="text-sm text-slate-400">
            Showing {filtered.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filtered.length)} of {filtered.length} rows
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-slate-400">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                <SelectTrigger className="h-8 w-24 bg-slate-950 border-slate-800 text-white text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  <SelectItem value="25" className="text-white">25</SelectItem>
                  <SelectItem value="50" className="text-white">50</SelectItem>
                  <SelectItem value="100" className="text-white">100</SelectItem>
                  <SelectItem value="250" className="text-white">250</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-400">
                Page {currentPage} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(1)}
                  disabled={currentPage === 1}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  First
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Next
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCurrentPage(totalPages)}
                  disabled={currentPage === totalPages}
                  className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                >
                  Last
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

