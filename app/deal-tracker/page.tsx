'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { getDealTrackerEntries } from '@/lib/dealTracker'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader2, Search, RefreshCw, X, Calendar } from 'lucide-react'

export default function DealTrackerPage() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [agentFilter, setAgentFilter] = useState<string>('all')
  const [callCenterFilter, setCallCenterFilter] = useState<string>('all')
  const [dateFromFilter, setDateFromFilter] = useState<string>('')
  const [dateToFilter, setDateToFilter] = useState<string>('')
  const [dealValueMin, setDealValueMin] = useState<string>('')
  const [dealValueMax, setDealValueMax] = useState<string>('')
  const [carriers, setCarriers] = useState<string[]>([])
  const [agents, setAgents] = useState<string[]>([])
  const [callCenters, setCallCenters] = useState<string[]>([])
  const [statuses, setStatuses] = useState<string[]>([])
  
  // Pagination
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  useEffect(() => {
    fetchEntries()
    fetchFilterOptions()
  }, [])

  useEffect(() => {
    setCurrentPage(1) // Reset to page 1 when filters change
  }, [searchTerm, carrierFilter, statusFilter, agentFilter, callCenterFilter, dateFromFilter, dateToFilter, dealValueMin, dealValueMax])

  const fetchFilterOptions = async () => {
    // Fetch all entries to get unique filter values
    const { data } = await supabase
      .from('deal_tracker')
      .select('carrier, policy_status, sales_agent, call_center')
      .order('carrier')

    if (data) {
      const uniqueCarriers = Array.from(new Set(data.map(e => e.carrier).filter(Boolean))).sort()
      const uniqueAgents = Array.from(new Set(data.map(e => e.sales_agent).filter(Boolean))).sort()
      const uniqueCallCenters = Array.from(new Set(data.map(e => e.call_center).filter(Boolean))).sort()
      const uniqueStatuses = Array.from(new Set(data.map(e => e.policy_status).filter(Boolean))).sort()
      
      setCarriers(uniqueCarriers)
      setAgents(uniqueAgents)
      setCallCenters(uniqueCallCenters)
      setStatuses(uniqueStatuses)
    }
  }

  const fetchEntries = async () => {
    setLoading(true)
    try {
      // Fetch all entries (we'll filter client-side for complex filters)
      const data = await getDealTrackerEntries({
        limit: 10000, // Fetch a large batch for filtering
      })

      setEntries(data || [])
    } catch (error) {
      console.error('Error fetching entries:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredEntries = entries.filter(entry => {
    // Search filter
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase()
      const matchesSearch = (
        entry.name?.toLowerCase().includes(searchLower) ||
        entry.policy_number?.toLowerCase().includes(searchLower) ||
        entry.sales_agent?.toLowerCase().includes(searchLower) ||
        entry.call_center?.toLowerCase().includes(searchLower) ||
        entry.phone_number?.toLowerCase().includes(searchLower) ||
        entry.writing_number?.toLowerCase().includes(searchLower)
      )
      if (!matchesSearch) return false
    }

    // Carrier filter
    if (carrierFilter !== 'all' && entry.carrier !== carrierFilter) {
      return false
    }

    // Status filter
    if (statusFilter !== 'all' && entry.policy_status !== statusFilter) {
      return false
    }

    // Agent filter
    if (agentFilter !== 'all' && entry.sales_agent !== agentFilter) {
      return false
    }

    // Call Center filter
    if (callCenterFilter !== 'all' && entry.call_center !== callCenterFilter) {
      return false
    }

    // Date range filters
    if (dateFromFilter) {
      const entryDate = entry.deal_creation_date ? new Date(entry.deal_creation_date) : null
      const filterDate = new Date(dateFromFilter)
      if (!entryDate || entryDate < filterDate) {
        return false
      }
    }

    if (dateToFilter) {
      const entryDate = entry.deal_creation_date ? new Date(entry.deal_creation_date) : null
      const filterDate = new Date(dateToFilter)
      filterDate.setHours(23, 59, 59, 999) // End of day
      if (!entryDate || entryDate > filterDate) {
        return false
      }
    }

    // Deal value range filters
    if (dealValueMin) {
      const minValue = parseFloat(dealValueMin)
      if (isNaN(minValue) || !entry.deal_value || entry.deal_value < minValue) {
        return false
      }
    }

    if (dealValueMax) {
      const maxValue = parseFloat(dealValueMax)
      if (isNaN(maxValue) || !entry.deal_value || entry.deal_value > maxValue) {
        return false
      }
    }

    return true
  })

  // Pagination
  const totalPages = Math.ceil(filteredEntries.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedEntries = filteredEntries.slice(startIndex, endIndex)

  const clearFilters = () => {
    setSearchTerm('')
    setCarrierFilter('all')
    setStatusFilter('all')
    setAgentFilter('all')
    setCallCenterFilter('all')
    setDateFromFilter('')
    setDateToFilter('')
    setDealValueMin('')
    setDealValueMax('')
  }

  const hasActiveFilters = searchTerm || carrierFilter !== 'all' || statusFilter !== 'all' || 
    agentFilter !== 'all' || callCenterFilter !== 'all' || dateFromFilter || dateToFilter || 
    dealValueMin || dealValueMax

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    )
  }

  return (
    <div className="w-full max-w-none py-8 px-4 space-y-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2 text-white">Deal Tracker</h1>
        <p className="text-slate-400">
          Standardized view of all deals across carriers
        </p>
      </div>

      {/* Filters Card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800">
          <div className="flex items-center justify-between">
            <CardTitle className="text-white">Filters</CardTitle>
            {hasActiveFilters && (
              <Button onClick={clearFilters} variant="ghost" size="sm" className="text-slate-400 hover:text-white">
                <X className="w-4 h-4 mr-2" />
                Clear All
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          {/* Row 1: Search and Basic Filters */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 w-4 h-4" />
              <Input
                placeholder="Search name, policy #, agent..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Carriers</SelectItem>
                {carriers.map(carrier => (
                  <SelectItem key={carrier} value={carrier} className="text-white">
                    {carrier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Statuses</SelectItem>
                {statuses.map(status => (
                  <SelectItem key={status} value={status} className="text-white">
                    {status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={fetchEntries} variant="outline" className="border-slate-700 text-slate-300 hover:bg-slate-800">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>

          {/* Row 2: Agent, Call Center, Date Range */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Select value={agentFilter} onValueChange={setAgentFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Agents" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Agents</SelectItem>
                {agents.map(agent => (
                  <SelectItem key={agent} value={agent} className="text-white">
                    {agent}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={callCenterFilter} onValueChange={setCallCenterFilter}>
              <SelectTrigger className="bg-slate-950 border-slate-800 text-white">
                <SelectValue placeholder="All Call Centers" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                <SelectItem value="all" className="text-white">All Call Centers</SelectItem>
                {callCenters.map(cc => (
                  <SelectItem key={cc} value={cc} className="text-white">
                    {cc}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
              <Input
                type="date"
                placeholder="From Date"
                value={dateFromFilter}
                onChange={(e) => setDateFromFilter(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white text-sm"
              />
            </div>
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-slate-400 shrink-0" />
              <Input
                type="date"
                placeholder="To Date"
                value={dateToFilter}
                onChange={(e) => setDateToFilter(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white text-sm"
              />
            </div>
          </div>

          {/* Row 3: Deal Value Range */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Deal Value Min</label>
              <Input
                type="number"
                placeholder="Min value"
                value={dealValueMin}
                onChange={(e) => setDealValueMin(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
            <div>
              <label className="text-sm text-slate-400 mb-2 block">Deal Value Max</label>
              <Input
                type="number"
                placeholder="Max value"
                value={dealValueMax}
                onChange={(e) => setDealValueMax(e.target.value)}
                className="bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
              />
            </div>
          </div>

          {/* Results Count */}
          <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between text-sm text-slate-400">
            <span>
              Showing {filteredEntries.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredEntries.length)} of {filteredEntries.length} deals
            </span>
            <div className="flex items-center gap-2">
              <span>Rows per page:</span>
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                <SelectTrigger className="h-8 w-20 bg-slate-950 border-slate-800 text-white text-xs">
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
          </div>
        </CardContent>
      </Card>

      {/* Table Card */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="border-b border-slate-800">
          <CardTitle className="text-white">
            Deals ({filteredEntries.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-slate-800 hover:bg-transparent">
                  <TableHead className="text-slate-300 font-semibold">Name</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Policy Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Policy Status</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Deal Value</TableHead>
                  <TableHead className="text-slate-300 font-semibold">CC Value</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Sales Agent</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Writing #</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Call Center</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Phone Number</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Deal Creation Date</TableHead>
                  <TableHead className="text-slate-300 font-semibold">Effective Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-orange-400 mx-auto" />
                    </TableCell>
                  </TableRow>
                ) : filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center text-slate-400 py-8">
                      {hasActiveFilters ? 'No deals found matching your filters' : 'No deals found'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedEntries.map((entry) => (
                    <TableRow key={entry.id} className="border-b border-slate-800 hover:bg-slate-800/50 transition-colors">
                      <TableCell className="font-medium text-slate-100">{entry.name || '-'}</TableCell>
                      <TableCell className="text-slate-300 font-mono text-sm">{entry.policy_number}</TableCell>
                      <TableCell className="text-slate-300">{entry.carrier}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="border-slate-700 text-slate-300">
                          {entry.policy_status || '-'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {entry.deal_value
                          ? `$${entry.deal_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {entry.cc_value
                          ? `$${entry.cc_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-300">{entry.sales_agent || '-'}</TableCell>
                      <TableCell className="text-slate-300">{entry.writing_number || '-'}</TableCell>
                      <TableCell className="text-slate-300">{entry.call_center || '-'}</TableCell>
                      <TableCell className="text-slate-300">{entry.phone_number || '-'}</TableCell>
                      <TableCell className="text-slate-300">
                        {entry.deal_creation_date
                          ? new Date(entry.deal_creation_date).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell className="text-slate-300">
                        {entry.effective_date
                          ? new Date(entry.effective_date).toLocaleDateString()
                          : '-'}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* Pagination Controls */}
          {filteredEntries.length > 0 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
              <div className="text-sm text-slate-400">
                Page {currentPage} of {totalPages}
              </div>
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
          )}
        </CardContent>
      </Card>
    </div>
  )
}
