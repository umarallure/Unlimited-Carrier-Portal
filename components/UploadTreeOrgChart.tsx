'use client'

import { useRef, useLayoutEffect, useState, useCallback, useEffect } from 'react'
import { OrgChart } from 'd3-org-chart'
import { zoomIdentity } from 'd3-zoom'
import { supabase } from '@/lib/supabaseClient'
import { executeUpload, type FileKind } from '@/lib/uploadLogic'
import { useDealTrackerUpload } from '@/lib/useDealTrackerUpload'
import { useCommissionReportUpload } from '@/lib/useCommissionReportUpload'
import type { PendingRowsPayload } from '@/lib/dealTrackerUpload'
import { DealTrackerVerificationDialog } from '@/components/DealTrackerVerificationDialog'
import { CommissionReportDialog } from '@/components/CommissionReportDialog'
import { fetchDailyStatus, fetchDailyFileTypes, getLocalDayRange, type DailyStatus } from '@/lib/dailyUploadStatus'
import { Building2, Calendar, Loader2, RefreshCw, CheckCircle, AlertCircle, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/ThemeProvider'
import { adminOutlineBtn, adminSelectContent, adminSelectItem, adminSelectTrigger } from '@/lib/adminFieldClasses'

const MAX_FILE_SIZE_MB = 10
const ACCEPT_TYPES = '.xlsx,.xls,.csv'
const ACCEPT_TYPES_WITH_PDF = '.xlsx,.xls,.csv,.pdf'
const ACCEPT_LABEL = 'CSV, XLSX, XLS'
const ACCEPT_LABEL_WITH_PDF = 'CSV, XLSX, XLS, PDF (Corebridge Commission)'

type ChartNode = {
  id: string
  parentId: string
  name: string
  type: 'Agency' | 'Carrier' | 'Upload' | 'Agent'
  fileType?: FileKind
  agencyCarrierId?: string
  agencyName?: string
  carrierName?: string
  carrierCode?: string
  status?: DailyStatus
  thisFileTypeUploaded?: boolean
  carrierNoUpdate?: boolean
  email?: string
}

function escapeHtml(s: string): string {
  if (typeof document === 'undefined') return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function getNodeHtml(d: ChartNode, light: boolean): string {
  const base = 'border-radius:10px;padding:12px 16px;min-width:140px;min-height:70px;display:flex;align-items:center;justify-content:center;gap:10px;box-shadow:0 2px 4px rgb(0 0 0/0.12);cursor:pointer;'
  if (d.type === 'Agency') {
    if (light) {
      return `<div style="${base}background:linear-gradient(135deg,#fff 0%,#f8fafc 100%);color:#0f172a;border:2px solid #f97316;">
      <div style="font-weight:600;font-size:14px;">${escapeHtml(d.name)}</div>
      <div style="font-size:11px;color:#64748b;">Agency</div>
    </div>`
    }
    return `<div style="${base}background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f8fafc;border:2px solid #f97316;">
      <div style="font-weight:600;font-size:14px;">${escapeHtml(d.name)}</div>
      <div style="font-size:11px;color:#94a3b8;">Agency</div>
    </div>`
  }
  if (d.type === 'Agent') {
    if (light) {
      return `<div style="${base}background:#f1f5f9;color:#0f172a;border:2px solid #94a3b8;flex-direction:column;">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:#475569;">Agent${d.email ? ' · ' + escapeHtml(d.email) : ''}</div>
    </div>`
    }
    return `<div style="${base}background:#475569;color:#f1f5f9;border:2px solid #64748b;flex-direction:column;">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:#94a3b8;">Agent${d.email ? ' · ' + escapeHtml(d.email) : ''}</div>
    </div>`
  }
  if (d.type === 'Carrier') {
    const isUploaded = d.status === 'uploaded'
    const isNoUpdate = d.status === 'no_update'
    if (light) {
      const border = isUploaded ? '2px solid #16a34a' : isNoUpdate ? '2px solid #94a3b8' : '2px solid #cbd5e1'
      const bg = isUploaded ? 'linear-gradient(135deg,#dcfce7 0%,#bbf7d0 100%)' : isNoUpdate ? '#e2e8f0' : 'linear-gradient(135deg,#f8fafc 0%,#e2e8f0 100%)'
      const fg = '#0f172a'
      const sub = '#475569'
      return `<div style="${base}background:${bg};color:${fg};border:${border};">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:${sub};">Carrier · ${isUploaded ? 'Uploaded' : isNoUpdate ? 'No update' : 'Pending'}</div>
    </div>`
    }
    const border = isUploaded ? '2px solid #22c55e' : isNoUpdate ? '2px solid #64748b' : '2px solid #64748b'
    const bg = isUploaded ? 'linear-gradient(135deg,#14532d 0%,#166534 100%)' : isNoUpdate ? '#334155' : 'linear-gradient(135deg,#1e293b 0%,#334155 100%)'
    return `<div style="${base}background:${bg};color:#e2e8f0;border:${border};">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:#94a3b8;">Carrier · ${isUploaded ? 'Uploaded' : isNoUpdate ? 'No update' : 'Pending'}</div>
    </div>`
  }
  const isGreen = d.thisFileTypeUploaded && !d.carrierNoUpdate
  const isGray = d.carrierNoUpdate
  const label = d.fileType === 'Policy' ? 'P' : 'C'
  if (light) {
    const border = isGray ? '2px solid #94a3b8' : isGreen ? '2px solid #16a34a' : '2px solid #ea580c'
    const bg = isGray ? '#e2e8f0' : isGreen ? '#bbf7d0' : '#e0e7ff'
    const fg = '#0f172a'
    const sub = '#334155'
    return `<div style="${base}background:${bg};color:${fg};border:${border};flex-direction:column;">
    <div style="font-weight:700;font-size:18px;">${label}</div>
    <div style="font-size:11px;color:${sub};">${escapeHtml(d.fileType || '')} ${isGreen ? '· Done' : isGray ? '· No update' : '· Click to upload'}</div>
  </div>`
  }
  const border = isGray ? '2px solid #475569' : isGreen ? '2px solid #22c55e' : '2px solid #f97316'
  const bg = isGray ? '#334155' : isGreen ? '#166534' : '#4338ca'
  return `<div style="${base}background:${bg};color:#f1f5f9;border:${border};flex-direction:column;">
    <div style="font-weight:700;font-size:18px;">${label}</div>
    <div style="font-size:11px;color:#cbd5e1;">${escapeHtml(d.fileType || '')} ${isGreen ? '· Done' : isGray ? '· No update' : '· Click to upload'}</div>
  </div>`
}

type SavedTransform = { x: number; y: number; k: number }

type LastUploadContext = {
  agencyCarrierId: string
  fileId: string
  carrierCode: string
  fileType: FileKind
}

export function UploadTreeOrgChart() {
  const { theme } = useTheme()
  const isLight = theme === 'light'
  const dealTracker = useDealTrackerUpload()
  const deferredCommissionRowsRef = useRef<Record<string, unknown>[] | null>(null)
  const commissionReport = useCommissionReportUpload({
    onAfterSave: async () => {
      deferredCommissionRowsRef.current = null
      await dealTracker.confirmAndSave()
    },
  })
  const [lastUploadContext, setLastUploadContext] = useState<LastUploadContext | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<InstanceType<typeof OrgChart> | null>(null)
  const savedTransformRef = useRef<SavedTransform | null>(null)
  const [agencies, setAgencies] = useState<{ id: string; name: string }[]>([])
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('')
  const [uploadDate, setUploadDate] = useState(() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })
  /** Latest toolbar date for d3 onNodeClick (chart effect deps are only chartData). */
  const uploadDateRef = useRef(uploadDate)
  uploadDateRef.current = uploadDate
  const [chartData, setChartData] = useState<ChartNode[]>([])
  const [loading, setLoading] = useState(false)
  const [dailyStatusMap, setDailyStatusMap] = useState<Record<string, DailyStatus>>({})
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [uploadDialog, setUploadDialog] = useState<{
    agencyCarrierId: string
    fileType: FileKind
    agencyName: string
    carrierName: string
    carrierCode: string
    /** Date shown in toolbar when the user opened this upload (YYYY-MM-DD). */
    uploadDateYmd: string
  } | null>(null)
  const [uploadingFile, setUploadingFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const loadAgencies = useCallback(async () => {
    const { data } = await supabase.from('agencies').select('id, name').order('name')
    setAgencies(data ?? [])
  }, [])

  const loadDailyStatuses = useCallback(async () => {
    const { data: rows } = await supabase.from('agency_carriers').select('id')
    if (!rows?.length) return
    const typedRows = rows as Array<{ id: string }>
    const ids = typedRows.map((r) => r.id)
    const dayRange = getLocalDayRange(uploadDate)
    const map = await fetchDailyStatus(uploadDate, ids, { startISO: dayRange.start, endISO: dayRange.end })
    setDailyStatusMap(map)
  }, [uploadDate])

  const loadTreeData = useCallback(async () => {
    if (!selectedAgencyId) {
      setChartData([])
      return
    }
    setLoading(true)
    try {
      const [agencyRes, acRes, agentsRes] = await Promise.all([
        supabase.from('agencies').select('id, name').eq('id', selectedAgencyId).single(),
        supabase.from('agency_carriers').select('id, agency_id, carriers(id, name, code)').eq('agency_id', selectedAgencyId).order('carriers(name)'),
        supabase.from('agents').select('id, name, email').eq('agency_id', selectedAgencyId).order('name'),
      ])
      const agency = agencyRes.data
      const acData = acRes.data ?? []
      const agencyCarriers = (Array.isArray(acData) ? acData : []).map((ac: any) => ({
        id: ac.id,
        agency_id: ac.agency_id,
        carriers: Array.isArray(ac.carriers) ? ac.carriers[0] ?? null : ac.carriers ?? null,
      })) as { id: string; agency_id: string; carriers: { id: string; name: string; code: string } | null }[]
      const agents = (agentsRes.data ?? []) as { id: string; name: string; email?: string }[]
      if (!agency) {
        setChartData([])
        return
      }
      const acIds = agencyCarriers.map(ac => ac.id)
      const dayRange = getLocalDayRange(uploadDate)
      const [statusMap, fileTypesByAc] = await Promise.all([
        fetchDailyStatus(uploadDate, acIds, { startISO: dayRange.start, endISO: dayRange.end }),
        fetchDailyFileTypes(uploadDate, acIds, { startISO: dayRange.start, endISO: dayRange.end }),
      ])
      const nodes: ChartNode[] = []
      const rootId = `agency-${agency.id}`
      nodes.push({
        id: rootId,
        parentId: '',
        name: agency.name || 'Agency',
        type: 'Agency',
      })
      for (const ac of agencyCarriers) {
        const carrier = ac.carriers
        if (!carrier) continue
        const carrierId = `carrier-${ac.id}`
        const status = statusMap[ac.id]
        nodes.push({
          id: carrierId,
          parentId: rootId,
          name: carrier.name || 'Carrier',
          type: 'Carrier',
          agencyCarrierId: ac.id,
          status,
        })
        for (const fileType of ['Policy', 'Commission'] as FileKind[]) {
          nodes.push({
            id: `upload-${ac.id}-${fileType}`,
            parentId: carrierId,
            name: fileType,
            type: 'Upload',
            fileType,
            agencyCarrierId: ac.id,
            agencyName: agency.name,
            carrierName: carrier.name,
            carrierCode: carrier.code,
            thisFileTypeUploaded: fileTypesByAc[ac.id]?.has(fileType) ?? false,
            carrierNoUpdate: status === 'no_update',
          })
        }
      }
      for (const agent of agents) {
        nodes.push({
          id: `agent-${agent.id}`,
          parentId: rootId,
          name: agent.name || 'Unnamed Agent',
          type: 'Agent',
          email: agent.email,
        })
      }
      setChartData(nodes)
    } catch (e) {
      console.error(e)
      setChartData([])
    } finally {
      setLoading(false)
    }
  }, [selectedAgencyId, uploadDate])

  useEffect(() => {
    loadAgencies()
  }, [loadAgencies])

  useEffect(() => {
    loadDailyStatuses()
  }, [loadDailyStatuses])

  // Depend only on primitives so the dependency array length is always constant (React requirement)
  useEffect(() => {
    loadTreeData()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: loadTreeData is derived from selectedAgencyId/uploadDate
  }, [selectedAgencyId, uploadDate])

  useLayoutEffect(() => {
    if (!chartData.length || !containerRef.current) return
    
    // Don't restore transform - always center the chart after re-render
    // This prevents the chart from jumping to corners or off-screen
    const chart = new OrgChart()
    chartInstanceRef.current = chart
    chart
      .container(containerRef.current)
      .data(chartData as any)
      .nodeWidth(() => 180)
      .nodeHeight(() => 90)
      .compactMarginBetween(() => 40)
      .onNodeClick((node: any) => {
        const d = node?.data as ChartNode
        if (!d) return
        if (d.type === 'Upload' && d.agencyCarrierId && d.fileType && d.agencyName && d.carrierName && d.carrierCode) {
          setUploadDialog({
            agencyCarrierId: d.agencyCarrierId,
            fileType: d.fileType,
            agencyName: d.agencyName,
            carrierName: d.carrierName,
            carrierCode: d.carrierCode,
            uploadDateYmd: uploadDateRef.current,
          })
        }
      })
      .nodeContent((node: any) => getNodeHtml((node?.data || {}) as ChartNode, isLight))
      .render()

    // Always center the chart after render to keep it visible
    setTimeout(() => {
      try {
        // Try to use centerOnNode if available (d3-org-chart method)
        if ((chart as any).centerOnNode && chartData.length > 0) {
          const rootNode = chartData.find(n => n.type === 'Agency')
          if (rootNode) {
            (chart as any).centerOnNode(rootNode.id, true)
            return
          }
        }
      } catch (_) {}
      
      // Fallback: manually center the chart
      try {
        const state = chart.getChartState?.()
        if (state?.svg && containerRef.current) {
          const svg = state.svg as any
          const container = containerRef.current
          const containerWidth = container.clientWidth || container.offsetWidth || 1200
          const containerHeight = container.clientHeight || container.offsetHeight || 800
          
          // Get SVG dimensions
          const svgElement = svg.node?.() || container.querySelector('svg')
          if (svgElement) {
            const bbox = svgElement.getBBox()
            const svgWidth = bbox.width || svgElement.viewBox?.baseVal?.width || 1000
            const svgHeight = bbox.height || svgElement.viewBox?.baseVal?.height || 600
            
            // Calculate center position
            const scale = Math.min(1, Math.min(containerWidth / svgWidth, containerHeight / svgHeight) * 0.9)
            const x = (containerWidth - svgWidth * scale) / 2 - bbox.x * scale
            const y = (containerHeight - svgHeight * scale) / 2 - bbox.y * scale
            
            // Apply transform
            if (state.zoomBehavior) {
              const identity = zoomIdentity.translate(x, y).scale(scale)
              svg.call(state.zoomBehavior.transform, identity)
            }
          }
        }
      } catch (err) {
        console.warn('[UploadTreeOrgChart] Failed to center chart:', err)
      }
    }, 150)

    return () => {
      chartInstanceRef.current = null
      if (containerRef.current?.firstChild) containerRef.current.innerHTML = ''
    }
  }, [chartData, isLight])

  const handleUploadSubmit = useCallback(async () => {
    if (!uploadDialog || !uploadingFile) return
    setUploading(true)
    try {
      const result = await executeUpload({
        agencyCarrierId: uploadDialog.agencyCarrierId,
        agencyName: uploadDialog.agencyName,
        carrierName: uploadDialog.carrierName,
        carrierCode: uploadDialog.carrierCode,
        file: uploadingFile,
        fileType: uploadDialog.fileType,
        // Toolbar date when the dialog was opened — drives file.created_at override and commission statement_date backfill in uploadLogic.
        uploadDateYmd: uploadDialog.uploadDateYmd,
      })
      if (result.success) {
        const count = (result as { count?: number }).count ?? 0
        setUploadMessage({ type: 'success', text: `${uploadDialog.fileType} uploaded. ${count} record(s) processed.` })
        setTimeout(() => setUploadMessage(null), 6000)

        const pendingPayload =
          'pendingRows' in result && result.pendingRows
            ? (result.pendingRows as PendingRowsPayload)
            : undefined
        deferredCommissionRowsRef.current =
          pendingPayload?.rows?.length ? pendingPayload.rows : null
        
        // Always hand off to central deal-tracker hook for Policy/Commission uploads.
        // The hook itself decides which carriers are supported.
        const upperCarrierCode = (uploadDialog.carrierCode || '').toUpperCase()

        console.log('[UploadTreeOrgChart] Upload successful, checking deal tracker processing...', {
          carrierCode: upperCarrierCode,
          fileType: uploadDialog.fileType,
          hasFileId: 'fileId' in result,
          fileId: 'fileId' in result ? result.fileId : 'N/A',
        })
        
        if ((uploadDialog.fileType === 'Policy' || uploadDialog.fileType === 'Commission') && 'fileId' in result) {
          setLastUploadContext({
            agencyCarrierId: uploadDialog.agencyCarrierId,
            fileId: result.fileId,
            carrierCode: uploadDialog.carrierCode,
            fileType: uploadDialog.fileType,
          })
          console.log('[UploadTreeOrgChart] Triggering deal tracker processing for', uploadDialog.fileType, 'file...')
          await dealTracker.processAfterUpload(
            uploadDialog.agencyCarrierId,
            result.fileId,
            uploadDialog.carrierCode,
            uploadDialog.fileType,
            pendingPayload
          )
        }
        
        setUploadDialog(null)
        setUploadingFile(null)
        // Reset saved transform so chart centers properly after reload
        savedTransformRef.current = null
        await loadDailyStatuses()
        await loadTreeData()
      } else {
        setUploadMessage({ type: 'error', text: result.error })
      }
    } catch (e: any) {
      setUploadMessage({ type: 'error', text: e?.message || 'Upload failed' })
    } finally {
      setUploading(false)
    }
  }, [uploadDialog, uploadingFile, loadDailyStatuses, loadTreeData, dealTracker])

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2 dark:bg-slate-800 dark:border-slate-700">
            <Building2 className="h-4 w-4 text-orange-500 dark:text-orange-400" />
            <Label className="text-sm font-medium text-foreground">Agency:</Label>
            <Select value={selectedAgencyId} onValueChange={setSelectedAgencyId}>
              <SelectTrigger className={cn('h-10 w-[220px]', adminSelectTrigger)}>
                <SelectValue placeholder="Select an agency" />
              </SelectTrigger>
              <SelectContent className={adminSelectContent}>
                {agencies.map(a => (
                  <SelectItem key={a.id} value={a.id} className={adminSelectItem}>{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedAgencyId && (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2 dark:bg-slate-800 dark:border-slate-700">
                <Calendar className="h-4 w-4 text-orange-500 dark:text-orange-400" />
                <Label className="text-sm font-medium text-foreground">Date:</Label>
                <Input type="date" value={uploadDate} onChange={e => setUploadDate(e.target.value)} className={cn('h-9 w-40 text-sm', adminSelectTrigger)} />
              </div>
              <Button variant="outline" size="sm" className={adminOutlineBtn} onClick={() => { loadDailyStatuses(); loadTreeData(); }}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {uploadMessage && (
        <div className={cn('flex items-center justify-between gap-4 rounded-xl border px-4 py-3', uploadMessage.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-100' : 'border-red-200 bg-red-50 text-red-900 dark:border-red-600 dark:bg-red-950/60 dark:text-red-100')}>
          <div className="flex items-center gap-3">
            {uploadMessage.type === 'success' ? <CheckCircle className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400" /> : <AlertCircle className="h-5 w-5 shrink-0 text-red-600 dark:text-red-400" />}
            <span className="text-sm font-medium">{uploadMessage.text}</span>
          </div>
          <button type="button" onClick={() => setUploadMessage(null)} className="text-sm underline text-muted-foreground hover:text-foreground">Dismiss</button>
        </div>
      )}

      {!selectedAgencyId && (
        <div className="flex min-h-[500px] flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/20 p-16 text-center dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-muted dark:border-slate-700 dark:bg-slate-800">
            <Building2 className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="text-lg font-medium text-foreground">Select an agency</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">Choose an agency to see the org chart and upload Policy or Commission files per carrier.</p>
        </div>
      )}

      {selectedAgencyId && loading && (
        <div className="flex min-h-[500px] flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/20 p-12 dark:border-slate-800 dark:bg-slate-900/40">
          <Loader2 className="mb-4 h-12 w-12 animate-spin text-orange-500 dark:text-orange-400" />
          <p className="text-muted-foreground">Loading tree...</p>
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length > 0 && (
        <div className="min-h-[600px] overflow-hidden rounded-xl border-2 border-border bg-muted/10 dark:border-slate-800 dark:bg-slate-900/40" style={{ minHeight: '700px', width: '100%' }}>
          <div ref={containerRef} className="h-full min-h-[600px] w-full [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full" style={{ overflow: 'auto' }} />
        </div>
      )}

      <Dialog open={!!uploadDialog} onOpenChange={(open) => {
        if (!open) {
          setUploadDialog(null)
          setUploadingFile(null)
          setDragActive(false)
        }
      }}>
        <DialogContent className="sm:max-w-lg" aria-describedby="upload-dialog-desc">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Upload className="h-5 w-5 text-orange-500 dark:text-orange-400" />
              Upload {uploadDialog?.fileType} — {uploadDialog?.carrierName}
            </DialogTitle>
            <DialogDescription id="upload-dialog-desc" className="sr-only">
              Select a file to upload for this carrier and file type.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <input
              ref={fileInputRef}
              type="file"
              accept={
                (uploadDialog?.carrierCode === 'COREBRIDGE' ||
                  uploadDialog?.carrierCode === 'SENTINEL') &&
                uploadDialog?.fileType === 'Commission'
                  ? ACCEPT_TYPES_WITH_PDF
                  : ACCEPT_TYPES
              }
              className="sr-only"
              onChange={e => setUploadingFile(e.target.files?.[0] ?? null)}
            />
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
              onDragLeave={() => setDragActive(false)}
              onDrop={e => {
                e.preventDefault();
                setDragActive(false);
                const file = e.dataTransfer.files?.[0];
                if (file) setUploadingFile(file);
              }}
              className={cn(
                'flex cursor-pointer items-center gap-4 rounded-xl border-2 border-dashed border-border bg-muted/40 p-6 transition-colors',
                'hover:border-orange-500/50 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:border-slate-600 dark:bg-slate-700/50 dark:hover:bg-slate-700',
                dragActive && 'border-orange-500 bg-muted/60 dark:bg-slate-700'
              )}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground dark:bg-slate-600 dark:text-slate-300">
                <Upload className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-foreground">Drag and drop files</p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  Up to {MAX_FILE_SIZE_MB}MB per file in{' '}
                  {uploadDialog?.carrierCode === 'COREBRIDGE' && uploadDialog?.fileType === 'Commission'
                    ? ACCEPT_LABEL_WITH_PDF
                    : ACCEPT_LABEL}
                  .
                </p>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  className="mt-1 text-sm font-medium text-orange-600 underline hover:text-orange-700 dark:text-orange-400 dark:hover:text-orange-300"
                >
                  Browse files
                </button>
              </div>
            </div>
            {uploadingFile && (
              <p className="text-sm text-muted-foreground">
                Selected: <span className="font-medium text-foreground">{uploadingFile.name}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialog(null)} className={adminOutlineBtn}>Cancel</Button>
            <Button onClick={handleUploadSubmit} disabled={!uploadingFile || uploading} className="bg-orange-600 text-white hover:bg-orange-700">
              {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Upload'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Deal Tracker Verification Dialog */}
      <DealTrackerVerificationDialog
        open={dealTracker.showVerification}
        onOpenChange={dealTracker.setShowVerification}
        entries={dealTracker.verificationEntries}
        loadingMessage={dealTracker.previewLoadingMessage}
        saveProgressLogs={dealTracker.saveProgressLogs}
        onConfirm={dealTracker.confirmAndSave}
        onCancel={dealTracker.cancelVerification}
        fileType={lastUploadContext?.fileType}
        onNext={
          lastUploadContext?.fileType === 'Commission' &&
          ['AETNA', 'AMAM', 'MOH', 'COREBRIDGE', 'AFLAC', 'AHL', 'SENTINEL'].includes(
            (lastUploadContext?.carrierCode || '').toUpperCase()
          )
            ? async (entries) => {
                await dealTracker.confirmDealTrackerOnly(entries)
                dealTracker.setShowVerification(false)
                if (lastUploadContext) {
                  commissionReport.openCommissionReport(
                    lastUploadContext.agencyCarrierId,
                    lastUploadContext.fileId,
                    lastUploadContext.carrierCode,
                    {
                      pendingRows:
                        deferredCommissionRowsRef.current && deferredCommissionRowsRef.current.length > 0
                          ? deferredCommissionRowsRef.current
                          : undefined,
                    }
                  )
                }
              }
            : undefined
        }
      />

      {/* Commission Report step (after "Next" from deal tracker for AETNA/AMAM Commission) */}
      <CommissionReportDialog
        open={commissionReport.showCommissionReport}
        onOpenChange={commissionReport.handleCommissionReportOpenChange}
        rows={commissionReport.commissionRows}
        loading={commissionReport.loading}
        saving={commissionReport.saving}
        carrierCode={lastUploadContext?.carrierCode ?? 'AETNA'}
        agencyCarrierId={commissionReport.reportContext?.agencyCarrierId}
        fileId={commissionReport.reportContext?.fileId}
        onSave={async (editedRows) => {
          await commissionReport.saveCommissionReport(editedRows)
        }}
      />
    </div>
  )
}
