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
import { Loader2, Search, RefreshCw } from 'lucide-react'

export default function DealTrackerPage() {
  const [entries, setEntries] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [carriers, setCarriers] = useState<string[]>([])

  useEffect(() => {
    fetchEntries()
    fetchCarriers()
  }, [])

  const fetchCarriers = async () => {
    const { data } = await supabase
      .from('deal_tracker')
      .select('carrier')
      .order('carrier')

    if (data) {
      const uniqueCarriers = Array.from(new Set(data.map(e => e.carrier).filter(Boolean)))
      setCarriers(uniqueCarriers)
    }
  }

  const fetchEntries = async () => {
    setLoading(true)
    try {
      const filters: any = {}
      if (carrierFilter !== 'all') {
        filters.carrier = carrierFilter
      }
      if (statusFilter !== 'all') {
        filters.policy_status = statusFilter
      }

      const data = await getDealTrackerEntries({
        ...filters,
        limit: 1000,
      })

      setEntries(data || [])
    } catch (error) {
      console.error('Error fetching entries:', error)
    } finally {
      setLoading(false)
    }
  }

  const filteredEntries = entries.filter(entry => {
    if (searchTerm) {
      const searchLower = searchTerm.toLowerCase()
      return (
        entry.name?.toLowerCase().includes(searchLower) ||
        entry.policy_number?.toLowerCase().includes(searchLower) ||
        entry.sales_agent?.toLowerCase().includes(searchLower) ||
        entry.call_center?.toLowerCase().includes(searchLower)
      )
    }
    return true
  })

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Deal Tracker</h1>
        <p className="text-muted-foreground">
          Standardized view of all deals across carriers
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-muted-foreground w-4 h-4" />
              <Input
                placeholder="Search by name, policy number, agent..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <Select value={carrierFilter} onValueChange={setCarrierFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Carriers" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Carriers</SelectItem>
                {carriers.map(carrier => (
                  <SelectItem key={carrier} value={carrier}>
                    {carrier}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger>
                <SelectValue placeholder="All Statuses" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="Issued Paid">Issued Paid</SelectItem>
                <SelectItem value="Issued Not Paid">Issued Not Paid</SelectItem>
                <SelectItem value="Pending">Pending</SelectItem>
                <SelectItem value="Declined">Declined</SelectItem>
                <SelectItem value="Charge Back">Charge Back</SelectItem>
                <SelectItem value="Pending Lapse">Pending Lapse</SelectItem>
                <SelectItem value="Closed as Incomplete">Closed as Incomplete</SelectItem>
                <SelectItem value="Withdrawn">Withdrawn</SelectItem>
              </SelectContent>
            </Select>
            <Button onClick={fetchEntries} variant="outline">
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Deals ({filteredEntries.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Policy Number</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Policy Status</TableHead>
                  <TableHead>Deal Value</TableHead>
                  <TableHead>CC Value</TableHead>
                  <TableHead>Sales Agent</TableHead>
                  <TableHead>Writing #</TableHead>
                  <TableHead>Call Center</TableHead>
                  <TableHead>Phone Number</TableHead>
                  <TableHead>Deal Creation Date</TableHead>
                  <TableHead>Effective Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={12} className="text-center text-muted-foreground py-8">
                      No deals found
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredEntries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="font-medium">{entry.name || '-'}</TableCell>
                      <TableCell>{entry.policy_number}</TableCell>
                      <TableCell>{entry.carrier}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{entry.policy_status || '-'}</Badge>
                      </TableCell>
                      <TableCell>
                        {entry.deal_value
                          ? `$${entry.deal_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell>
                        {entry.cc_value
                          ? `$${entry.cc_value.toLocaleString('en-US', {
                              minimumFractionDigits: 2,
                              maximumFractionDigits: 2,
                            })}`
                          : '-'}
                      </TableCell>
                      <TableCell>{entry.sales_agent || '-'}</TableCell>
                      <TableCell>{entry.writing_number || '-'}</TableCell>
                      <TableCell>{entry.call_center || '-'}</TableCell>
                      <TableCell>{entry.phone_number || '-'}</TableCell>
                      <TableCell>
                        {entry.deal_creation_date
                          ? new Date(entry.deal_creation_date).toLocaleDateString()
                          : '-'}
                      </TableCell>
                      <TableCell>
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
        </CardContent>
      </Card>
    </div>
  )
}
