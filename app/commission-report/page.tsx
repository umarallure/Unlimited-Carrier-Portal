'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Calendar, Loader2, Search } from 'lucide-react'

type CommissionRow = Record<string, any>
type CarrierFilter = 'ALL' | 'AMAM' | 'AETNA'

function looksLikeNumberOnly(val: unknown): boolean {
  if (val == null) return true
  const s = String(val).trim()
  if (!s) return true
  return /^\d+$/.test(s)
}

export default function CommissionReportPage() {
  const [rows, setRows] = useState<CommissionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [carrierCode, setCarrierCode] = useState<CarrierFilter>('ALL')
  const [searchTerm, setSearchTerm] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dealTrackerAgentNames, setDealTrackerAgentNames] = useState<Map<string, string>>(new Map())
  const [dealTrackerAmounts, setDealTrackerAmounts] = useState<
    Map<string, { deal_value: number | null; charge_back: number | null }>
  >(new Map())

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      try {
        // Commission report is based on per-carrier commission uploads
        if (carrierCode === 'ALL') {
          const [amamRes, aetnaRes] = await Promise.all([
            supabase.from<CommissionRow>('amam_commissions').select('*').order('created_at', { ascending: false }).limit(2000),
            supabase.from<CommissionRow>('aetna_commissions').select('*').order('created_at', { ascending: false }).limit(2000),
          ])

          if (amamRes.error) console.error('Error loading AMAM commission report:', amamRes.error)
          if (aetnaRes.error) console.error('Error loading Aetna commission report:', aetnaRes.error)

          const amamRows = (amamRes.data || []).map(r => ({ ...r, __carrier: 'AMAM' }))
          const aetnaRows = (aetnaRes.data || []).map(r => ({ ...r, __carrier: 'AETNA' }))
          const allRows = [...amamRows, ...aetnaRows]
          setRows(allRows)

          // Load deal_tracker financials (deal_value & charge_back) for Aetna policies
          const aetnaForDt = allRows.filter(
            r => r.__carrier === 'AETNA' && r.agency_carrier_id && r.policy_number
          )
          const dtAmountMap = new Map<string, { deal_value: number | null; charge_back: number | null }>()
          if (aetnaForDt.length > 0) {
            const byAc = new Map<string, string[]>()
            for (const r of aetnaForDt) {
              const acId = String(r.agency_carrier_id)
              if (!byAc.has(acId)) byAc.set(acId, [])
              byAc.get(acId)!.push(String(r.policy_number))
            }
            for (const [acId, policyNumbers] of byAc) {
              const { data: dtRows, error: dtError } = await supabase
                .from('deal_tracker')
                .select('policy_number, deal_value, charge_back')
                .eq('agency_carrier_id', acId)
                .in('policy_number', policyNumbers)
              if (dtError) {
                console.warn('[Commission Report] deal_tracker fetch error:', dtError.message)
                continue
              }
              for (const d of dtRows || []) {
                dtAmountMap.set(`${acId}::${d.policy_number}`, {
                  deal_value: d.deal_value as number | null,
                  charge_back: d.charge_back as number | null,
                })
              }
            }
          }
          setDealTrackerAmounts(dtAmountMap)

          // Enrich AMAM sales agent from deal_tracker when commission has only agent number
          const amamNeedName = amamRows.filter(
            r => r.agency_carrier_id && r.policy_number && looksLikeNumberOnly(r.writingagent)
          )
          if (amamNeedName.length > 0) {
            const byAc = new Map<string, string[]>()
            for (const r of amamNeedName) {
              const id = r.agency_carrier_id
              if (!byAc.has(id)) byAc.set(id, [])
              byAc.get(id)!.push(r.policy_number)
            }
            const nameMap = new Map<string, string>()
            for (const [agencyCarrierId, policyNumbers] of byAc) {
              const { data } = await supabase
                .from('deal_tracker')
                .select('policy_number, sales_agent')
                .eq('agency_carrier_id', agencyCarrierId)
                .in('policy_number', policyNumbers)
              for (const d of data || []) {
                if (d.policy_number && d.sales_agent?.trim())
                  nameMap.set(`${agencyCarrierId}::${d.policy_number}`, d.sales_agent)
              }
            }
            setDealTrackerAgentNames(nameMap)
          } else {
            setDealTrackerAgentNames(new Map())
          }
        } else {
          const tableName = carrierCode === 'AMAM' ? 'amam_commissions' : 'aetna_commissions'
          const { data, error } = await supabase
            .from<CommissionRow>(tableName)
            .select('*')
            .order('created_at', { ascending: false })
            .limit(2000)

          if (error) {
            console.error('Error loading commission report:', error)
            setRows([])
            setDealTrackerAgentNames(new Map())
            setDealTrackerAmounts(new Map())
          } else {
            const tagged = (data || []).map(r => ({
              ...r,
              __carrier: carrierCode,
            }))
            setRows(tagged)

            // Load deal_tracker financials only for Aetna when that carrier is selected
            if (carrierCode === 'AETNA') {
              const aetnaForDt = tagged.filter(
                r => r.agency_carrier_id && r.policy_number
              )
              const dtAmountMap = new Map<
                string,
                { deal_value: number | null; charge_back: number | null }
              >()
              if (aetnaForDt.length > 0) {
                const byAc = new Map<string, string[]>()
                for (const r of aetnaForDt) {
                  const acId = String(r.agency_carrier_id)
                  if (!byAc.has(acId)) byAc.set(acId, [])
                  byAc.get(acId)!.push(String(r.policy_number))
                }
                for (const [acId, policyNumbers] of byAc) {
                  const { data: dtRows, error: dtError } = await supabase
                    .from('deal_tracker')
                    .select('policy_number, deal_value, charge_back')
                    .eq('agency_carrier_id', acId)
                    .in('policy_number', policyNumbers)
                  if (dtError) {
                    console.warn(
                      '[Commission Report] deal_tracker fetch error (single carrier):',
                      dtError.message
                    )
                    continue
                  }
                  for (const d of dtRows || []) {
                    dtAmountMap.set(`${acId}::${d.policy_number}`, {
                      deal_value: d.deal_value as number | null,
                      charge_back: d.charge_back as number | null,
                    })
                  }
                }
              }
              setDealTrackerAmounts(dtAmountMap)
            } else {
              setDealTrackerAmounts(new Map())
            }

            if (carrierCode === 'AMAM') {
              const needName = tagged.filter(
                r => r.agency_carrier_id && r.policy_number && looksLikeNumberOnly(r.writingagent)
              )
              if (needName.length > 0) {
                const byAc = new Map<string, string[]>()
                for (const r of needName) {
                  const id = r.agency_carrier_id
                  if (!byAc.has(id)) byAc.set(id, [])
                  byAc.get(id)!.push(r.policy_number)
                }
                const nameMap = new Map<string, string>()
                for (const [agencyCarrierId, policyNumbers] of byAc) {
                  const { data: dtData } = await supabase
                    .from('deal_tracker')
                    .select('policy_number, sales_agent')
                    .eq('agency_carrier_id', agencyCarrierId)
                    .in('policy_number', policyNumbers)
                  for (const d of dtData || []) {
                    if (d.policy_number && d.sales_agent?.trim())
                      nameMap.set(`${agencyCarrierId}::${d.policy_number}`, d.sales_agent)
                  }
                }
                setDealTrackerAgentNames(nameMap)
              } else {
                setDealTrackerAgentNames(new Map())
              }
            } else {
              setDealTrackerAgentNames(new Map())
            }
          }
        }
      } catch (err) {
        console.error('Error loading commission report:', err)
        setRows([])
        setDealTrackerAgentNames(new Map())
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [carrierCode])

  const normalizeDate = (value: any): Date | null => {
    if (!value) return null
    // Support values like '2025-12-07', '2025/12/07', or Excel-style '2025-12-07 to 2026-01-20'
    const str = String(value).trim()
    if (!str) return null
    const rangePart = str.split('to')[0].trim()
    const parsed = new Date(rangePart.replace(/\./g, '-').replace(/\//g, '-'))
    return isNaN(parsed.getTime()) ? null : parsed
  }

  const filtered = rows.filter(row => {
    const name =
      row['Name'] ??
      row['name'] ??
      row['INSURED_NAME'] ??
      row['insured_name'] ??
      row['client'] ??
      ''
    const policy = row['Policy Number'] ?? row['policy_number'] ?? ''
    let salesAgent = row['Sales Agent'] ?? row['sales_agent'] ?? row['writingagentname'] ?? row['writingagent'] ?? ''
    if (row['__carrier'] === 'AMAM' && row.agency_carrier_id && row.policy_number) {
      const dtName = dealTrackerAgentNames.get(`${row.agency_carrier_id}::${row.policy_number}`)
      if (dtName) salesAgent = dtName
    }

    const dateRaw =
      row['Date'] ??
      row['date'] ??
      row['PAID_TO_DATE'] ??
      row['paid_to_date'] ??
      row['commissionpaiddate'] ??
      row['statement_date'] ??
      row['appdate'] ??
      row['effectivedate']
    const dt = normalizeDate(dateRaw)

    if (dateFrom) {
      const from = new Date(dateFrom)
      if (!dt || dt < from) return false
    }
    if (dateTo) {
      const to = new Date(dateTo)
      if (!dt || dt > to) return false
    }

    if (!searchTerm) return true
    const q = searchTerm.toLowerCase()
    return (
      String(name).toLowerCase().includes(q) ||
      String(policy).toLowerCase().includes(q) ||
      String(salesAgent).toLowerCase().includes(q)
    )
  })

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      <div className="flex items-center space-x-3">
        <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
          <span className="text-lg font-semibold text-orange-400">$</span>
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white">Commission Report</h1>
          <p className="text-gray-400">
            Read-only view of {carrierCode === 'ALL' ? 'AMAM + Aetna' : carrierCode === 'AMAM' ? 'AMAM' : 'Aetna'} commission rows, formatted like your Excel report.
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
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-orange-400 mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-slate-400 py-8">
                      No commission rows found for the current filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  filtered.map((row, idx) => {
                    const name =
                      row['Name'] ??
                      row['name'] ??
                      row['INSURED_NAME'] ??
                      row['insured_name'] ??
                      row['client'] ??
                      '-'
                    const dateRaw =
                      row['Date'] ??
                      row['date'] ??
                      row['PAID_TO_DATE'] ??
                      row['paid_to_date'] ??
                      row['commissionpaiddate'] ??
                      row['statement_date'] ??
                      row['appdate'] ??
                      row['effectivedate'] ??
                      ''
                    const policyNumber =
                      row['Policy Number'] ??
                      row['policy_number'] ??
                      row['POLICY_NUMBER'] ??
                      '-'
                    const carrier =
                      row['Carrier'] ??
                      row['carrier'] ??
                      row['__carrier'] ??
                      (carrierCode === 'AMAM' ? 'AMAM' : carrierCode === 'AETNA' ? 'Aetna' : '')
                    let salesAgent =
                      row['Sales Agent'] ??
                      row['sales_agent'] ??
                      row['AGENT'] ??
                      row['writingagentname'] ??
                      row['writingagent'] ??
                      '-'
                    if (row['__carrier'] === 'AMAM' && row.agency_carrier_id && row.policy_number) {
                      const dtName = dealTrackerAgentNames.get(`${row.agency_carrier_id}::${row.policy_number}`)
                      if (dtName) salesAgent = dtName
                    }
                    const commissionRate =
                      row['Commission Rate'] ??
                      row['commission_rate'] ??
                      row['RATE'] ??
                      row['rate'] ??
                      row['com_rate'] ??   // AMAM
                      row['rate_pct'] ??   // Aetna
                      null
                    let advance =
                      row['Advance'] ??
                      row['advance'] ??
                      row['ADVANCE'] ??
                      (carrierCode === 'AETNA' ? row['commissionamount'] : null) ??
                      null
                    let chargeBack: number | null = null

                    // Prefer aggregated amounts from deal_tracker for Aetna rows
                    if (row.__carrier === 'AETNA' && row.agency_carrier_id && row.policy_number) {
                      const key = `${row.agency_carrier_id}::${row.policy_number}`
                      const dt = dealTrackerAmounts.get(key)
                      if (dt) {
                        advance = dt.deal_value
                        chargeBack = dt.charge_back ?? null
                      } else {
                        // Fallback: derive from raw commission when no deal_tracker row yet
                        const parsedAdvance =
                          advance != null && advance !== ''
                            ? parseFloat(String(advance).replace(/,/g, ''))
                            : NaN
                        if (!Number.isNaN(parsedAdvance) && parsedAdvance < 0) {
                          advance = ''
                          chargeBack = parsedAdvance
                        }
                      }
                    } else {
                      // Non-Aetna carriers: derive purely from raw commission
                      const parsedAdvance =
                        advance != null && advance !== ''
                          ? parseFloat(String(advance).replace(/,/g, ''))
                          : NaN
                      if (!Number.isNaN(parsedAdvance) && parsedAdvance < 0) {
                        advance = ''
                        chargeBack = parsedAdvance
                      }
                    }

                    const dt = normalizeDate(dateRaw)

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
                      <TableRow key={row.id || `${policyNumber}-${idx}`} className="border-b border-slate-800 hover:bg-slate-800/40">
                        <TableCell className="text-slate-100">{name}</TableCell>
                        <TableCell className="text-slate-300">
                          {dt ? dt.toLocaleDateString() : String(dateRaw || '-')}
                        </TableCell>
                        <TableCell className="text-slate-300 font-mono text-sm">{policyNumber}</TableCell>
                        <TableCell className="text-slate-300">{carrier}</TableCell>
                        <TableCell className="text-slate-300">{salesAgent}</TableCell>
                        <TableCell className="text-slate-300 text-right">
                          {commissionRate != null && commissionRate !== ''
                            ? String(commissionRate)
                            : ''}
                        </TableCell>
                        <TableCell className="text-slate-300 text-right">
                          {advance != null && advance !== '' ? formatMoney(advance) : ''}
                        </TableCell>
                        <TableCell className="text-slate-300 text-right">
                          {chargeBack != null && chargeBack !== '' ? formatMoney(chargeBack) : ''}
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

