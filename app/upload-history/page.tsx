'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { History, Search, Loader2 } from 'lucide-react'

export default function UploadHistoryPage() {
  const [uploads, setUploads] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [carriers, setCarriers] = useState<string[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  useEffect(() => {
    fetchUploads()
  }, [])

  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, typeFilter, carrierFilter])

  const fetchUploads = async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('files')
      .select(`
        id,
        original_filename,
        file_type,
        created_at,
        records_processed,
        agency_carriers (
          carriers (name),
          agencies (name)
        )
      `)
      .order('created_at', { ascending: false })
      .limit(500)

    if (error) {
      console.error('Error fetching uploads:', error)
    } else {
      setUploads(data || [])
      const uniqueCarriers = Array.from(
        new Set(
          (data || [])
            .map((f: any) => f.agency_carriers?.carriers?.name)
            .filter(Boolean)
        )
      ).sort()
      setCarriers(uniqueCarriers)
    }
    setLoading(false)
  }

  const filteredUploads = uploads.filter((f: any) => {
    if (searchTerm) {
      const term = searchTerm.toLowerCase()
      const filename = (f.original_filename || '').toLowerCase()
      const agency = (f.agency_carriers?.agencies?.name || '').toLowerCase()
      if (!filename.includes(term) && !agency.includes(term)) return false
    }
    if (typeFilter !== 'all' && f.file_type !== typeFilter) return false
    if (carrierFilter !== 'all' && f.agency_carriers?.carriers?.name !== carrierFilter) return false
    return true
  })

  const totalPages = Math.ceil(filteredUploads.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedUploads = filteredUploads.slice(startIndex, endIndex)

  return (
    <div className="w-full max-w-none py-8 px-4 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white mb-2">Upload History</h1>
        <p className="text-slate-400">When and what files were loaded into the system</p>
      </div>

      <div className="bg-slate-900 rounded-xl border border-slate-800 p-4">
        <div className="flex flex-wrap items-center gap-4 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 w-4 h-4" />
            <Input
              placeholder="Search by filename or agency..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[140px] bg-slate-950 border-slate-800 text-white">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="all" className="text-white">All Types</SelectItem>
              <SelectItem value="Policy" className="text-white">Policy</SelectItem>
              <SelectItem value="Commission" className="text-white">Commission</SelectItem>
            </SelectContent>
          </Select>
          <Select value={carrierFilter} onValueChange={setCarrierFilter}>
            <SelectTrigger className="w-[160px] bg-slate-950 border-slate-800 text-white">
              <SelectValue placeholder="Carrier" />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="all" className="text-white">All Carriers</SelectItem>
              {carriers.map((c) => (
                <SelectItem key={c} value={c} className="text-white">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between text-sm text-slate-400">
          <span>
            Showing {filteredUploads.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredUploads.length)} of {filteredUploads.length} uploads
          </span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
            <SelectTrigger className="h-8 w-20 bg-slate-950 border-slate-800 text-white text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 border-slate-700">
              <SelectItem value="25" className="text-white">25</SelectItem>
              <SelectItem value="50" className="text-white">50</SelectItem>
              <SelectItem value="100" className="text-white">100</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
          </div>
        ) : filteredUploads.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            {searchTerm || typeFilter !== 'all' || carrierFilter !== 'all'
              ? 'No uploads match your filters.'
              : 'No file uploads yet. Use Organization Tree (Upload) to upload files.'}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-300 font-semibold">Date</TableHead>
                    <TableHead className="text-slate-300 font-semibold">File</TableHead>
                    <TableHead className="text-slate-300 font-semibold">Type</TableHead>
                    <TableHead className="text-slate-300 font-semibold">Carrier</TableHead>
                    <TableHead className="text-slate-300 font-semibold">Agency</TableHead>
                    <TableHead className="text-slate-300 font-semibold">Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedUploads.map((f: any) => (
                    <TableRow key={f.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                      <TableCell className="text-slate-300 text-sm whitespace-nowrap">
                        {f.created_at
                          ? new Date(f.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                          : '–'}
                      </TableCell>
                      <TableCell className="text-slate-200 text-sm font-mono max-w-[280px] truncate" title={f.original_filename}>
                        {f.original_filename || '–'}
                      </TableCell>
                      <TableCell>
                        <span className="px-2 py-0.5 rounded text-xs bg-slate-700 text-slate-200">
                          {f.file_type || '–'}
                        </span>
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {f.agency_carriers?.carriers?.name || '–'}
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {f.agency_carriers?.agencies?.name || '–'}
                      </TableCell>
                      <TableCell className="text-slate-400 text-sm">
                        {f.records_processed != null ? f.records_processed : '–'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {filteredUploads.length > 0 && (
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
                    onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage === 1}
                    className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
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
          </>
        )}
      </div>
    </div>
  )
}
