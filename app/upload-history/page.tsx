'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { History, Search, Loader2, Calendar } from 'lucide-react'
import { FilterBarHeader, QuickDateRangeChips } from '@/components/filters/SmartFilters'
import { PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'
import {
  adminCardHeaderBar,
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

export default function UploadHistoryPage() {
  const [uploads, setUploads] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [carrierFilter, setCarrierFilter] = useState<string>('all')
  const [uploadedFrom, setUploadedFrom] = useState('')
  const [uploadedTo, setUploadedTo] = useState('')
  const [carriers, setCarriers] = useState<string[]>([])
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)

  useEffect(() => {
    fetchUploads()
  }, [])

  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, typeFilter, carrierFilter, uploadedFrom, uploadedTo])

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
      const rows = (data || []) as any[]
      setUploads(rows)
      const uniqueCarriers: string[] = Array.from(
        new Set(
          rows
            .map((f: any) => f.agency_carriers?.carriers?.name)
            .filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0)
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
    if (uploadedFrom || uploadedTo) {
      const ts = f.created_at ? new Date(f.created_at) : null
      if (!ts || Number.isNaN(ts.getTime())) return false
      if (uploadedFrom) {
        const start = new Date(uploadedFrom)
        start.setHours(0, 0, 0, 0)
        if (ts < start) return false
      }
      if (uploadedTo) {
        const end = new Date(uploadedTo)
        end.setHours(23, 59, 59, 999)
        if (ts > end) return false
      }
    }
    return true
  })

  const uploadFilterCount = [
    searchTerm,
    typeFilter !== 'all',
    carrierFilter !== 'all',
    uploadedFrom,
    uploadedTo,
  ].filter(Boolean).length

  const clearUploadFilters = () => {
    setSearchTerm('')
    setTypeFilter('all')
    setCarrierFilter('all')
    setUploadedFrom('')
    setUploadedTo('')
  }

  const totalPages = Math.ceil(filteredUploads.length / pageSize)
  const startIndex = (currentPage - 1) * pageSize
  const endIndex = startIndex + pageSize
  const paginatedUploads = filteredUploads.slice(startIndex, endIndex)

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Upload History"
        description="When and what files were loaded into the system."
        icon={<History className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
      />

      <Card>
        <CardHeader className={cn('space-y-4 pb-5', adminCardHeaderBar)}>
        <FilterBarHeader
          title="Narrow uploads"
          description="Filter by file name, agency, type, carrier, or when the upload hit the server."
          activeCount={uploadFilterCount}
          onClearAll={uploadFilterCount ? clearUploadFilters : undefined}
        />
        </CardHeader>
        <CardContent className="space-y-4 pt-5">

        <QuickDateRangeChips
          dateFrom={uploadedFrom}
          dateTo={uploadedTo}
          onRangeChange={(from, to) => {
            setUploadedFrom(from)
            setUploadedTo(to)
          }}
        />

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Uploaded from</span>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
              <Input
                type="date"
                value={uploadedFrom}
                onChange={(e) => setUploadedFrom(e.target.value)}
                className={cn(adminInput, 'h-9 w-[150px] [color-scheme:light] dark:[color-scheme:dark]')}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Uploaded to</span>
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 shrink-0 text-orange-500 dark:text-orange-400" />
              <Input
                type="date"
                value={uploadedTo}
                onChange={(e) => setUploadedTo(e.target.value)}
                className={cn(adminInput, 'h-9 w-[150px] [color-scheme:light] dark:[color-scheme:dark]')}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="relative min-w-[200px] max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filename or agency…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={cn(adminInput, 'pl-10')}
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className={cn('h-10 w-[140px]', adminSelectTrigger)}>
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent className={adminSelectContent}>
              <SelectItem value="all" className={adminSelectItem}>All Types</SelectItem>
              <SelectItem value="Policy" className={adminSelectItem}>Policy</SelectItem>
              <SelectItem value="Commission" className={adminSelectItem}>Commission</SelectItem>
            </SelectContent>
          </Select>
          <Select value={carrierFilter} onValueChange={setCarrierFilter}>
            <SelectTrigger className={cn('h-10 w-[160px]', adminSelectTrigger)}>
              <SelectValue placeholder="Carrier" />
            </SelectTrigger>
            <SelectContent className={adminSelectContent}>
              <SelectItem value="all" className={adminSelectItem}>All Carriers</SelectItem>
              {carriers.map((c) => (
                <SelectItem key={c} value={c} className={adminSelectItem}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>
            Showing {filteredUploads.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredUploads.length)} of {filteredUploads.length} uploads
          </span>
          <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
            <SelectTrigger className={cn('h-8 w-20 text-xs', adminSelectTrigger)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent className={adminSelectContent}>
              <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
              <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
              <SelectItem value="100" className={adminSelectItem}>100</SelectItem>
            </SelectContent>
          </Select>
        </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-orange-400" />
          </div>
        ) : filteredUploads.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            {searchTerm || typeFilter !== 'all' || carrierFilter !== 'all'
              ? 'No uploads match your filters.'
              : 'No file uploads yet. Use Organization Tree (Upload) to upload files.'}
          </div>
        ) : (
          <>
              <Table>
                <TableHeader>
                  <TableRow className="border-b border-border hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800">
                    <TableHead className={adminThPlain}>Date</TableHead>
                    <TableHead className={adminThPlain}>File</TableHead>
                    <TableHead className={adminThPlain}>Type</TableHead>
                    <TableHead className={adminThPlain}>Carrier</TableHead>
                    <TableHead className={adminThPlain}>Agency</TableHead>
                    <TableHead className={adminThPlain}>Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedUploads.map((f: any) => (
                    <TableRow key={f.id} className={adminTableRowInteractive}>
                      <TableCell className={cn(adminTdMuted, 'whitespace-nowrap text-sm')}>
                        {f.created_at
                          ? new Date(f.created_at).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
                          : '–'}
                      </TableCell>
                      <TableCell className={cn(adminTdStrong, 'max-w-[280px] truncate font-mono text-sm')}>
                        {f.original_filename || '–'}
                      </TableCell>
                      <TableCell>
                        <span className="rounded bg-muted px-2 py-0.5 text-xs text-foreground dark:bg-slate-700 dark:text-slate-200">
                          {f.file_type || '–'}
                        </span>
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, 'text-sm')}>
                        {f.agency_carriers?.carriers?.name || '–'}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, 'text-sm')}>
                        {f.agency_carriers?.agencies?.name || '–'}
                      </TableCell>
                      <TableCell className={cn(adminTdMuted, 'text-sm')}>
                        {f.records_processed != null ? f.records_processed : '–'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            {filteredUploads.length > 0 && (
              <div className={cn('flex flex-col gap-3 border-t border-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80', adminPaginationBar)}>
                <div className="text-sm text-muted-foreground">
                  Page {currentPage} of {totalPages}
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>
                    First
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                    Next
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                    Last
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
        </CardContent>
      </Card>
    </div>
  )
}
