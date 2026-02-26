'use client'

import { useRef, useLayoutEffect, useState, useCallback, useEffect } from 'react'
import { OrgChart } from 'd3-org-chart'
import { zoomIdentity } from 'd3-zoom'
import { supabase } from '@/lib/supabaseClient'
import { executeUpload, type FileKind } from '@/lib/uploadLogic'
import { useDealTrackerUpload } from '@/lib/useDealTrackerUpload'
import type { PendingRowsPayload } from '@/lib/dealTrackerUpload'
import { DealTrackerVerificationDialog } from '@/components/DealTrackerVerificationDialog'
import { fetchDailyStatus, fetchDailyFileTypes, getLocalDayRange, type DailyStatus } from '@/lib/dailyUploadStatus'
import { Building2, Calendar, Loader2, RefreshCw, CheckCircle, AlertCircle, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const MAX_FILE_SIZE_MB = 10
const ACCEPT_TYPES = '.xlsx,.xls,.csv'
const ACCEPT_LABEL = 'CSV, XLSX, XLS'

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

function getNodeHtml(d: ChartNode): string {
  const base = 'border-radius:10px;padding:12px 16px;min-width:140px;min-height:70px;display:flex;align-items:center;justify-content:center;gap:10px;box-shadow:0 2px 4px rgb(0 0 0/0.2);cursor:pointer;'
  if (d.type === 'Agency') {
    return `<div style="${base}background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%);color:#f8fafc;border:2px solid #f97316;">
      <div style="font-weight:600;font-size:14px;">${escapeHtml(d.name)}</div>
      <div style="font-size:11px;color:#94a3b8;">Agency</div>
    </div>`
  }
  if (d.type === 'Agent') {
    return `<div style="${base}background:#475569;color:#f1f5f9;border:2px solid #64748b;flex-direction:column;">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:#94a3b8;">Agent${d.email ? ' · ' + escapeHtml(d.email) : ''}</div>
    </div>`
  }
  if (d.type === 'Carrier') {
    const isUploaded = d.status === 'uploaded'
    const isNoUpdate = d.status === 'no_update'
    const border = isUploaded ? '2px solid #22c55e' : isNoUpdate ? '2px solid #64748b' : '2px solid #64748b'
    const bg = isUploaded ? 'linear-gradient(135deg,#14532d 0%,#166534 100%)' : isNoUpdate ? '#334155' : 'linear-gradient(135deg,#1e293b 0%,#334155 100%)'
    return `<div style="${base}background:${bg};color:#e2e8f0;border:${border};">
      <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
      <div style="font-size:10px;color:#94a3b8;">Carrier · ${isUploaded ? 'Uploaded' : isNoUpdate ? 'No update' : 'Pending'}</div>
    </div>`
  }
  // Upload (Policy / Commission)
  const isGreen = d.thisFileTypeUploaded && !d.carrierNoUpdate
  const isGray = d.carrierNoUpdate
  const label = d.fileType === 'Policy' ? 'P' : 'C'
  const border = isGray ? '2px solid #475569' : isGreen ? '2px solid #22c55e' : '2px solid #f97316'
  const bg = isGray ? '#334155' : isGreen ? '#166534' : '#4338ca'
  return `<div style="${base}background:${bg};color:#f1f5f9;border:${border};flex-direction:column;">
    <div style="font-weight:700;font-size:18px;">${label}</div>
    <div style="font-size:11px;color:#cbd5e1;">${escapeHtml(d.fileType || '')} ${isGreen ? '· Done' : isGray ? '· No update' : '· Click to upload'}</div>
  </div>`
}

type SavedTransform = { x: number; y: number; k: number }

export function UploadTreeOrgChart() {
  const dealTracker = useDealTrackerUpload()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<InstanceType<typeof OrgChart> | null>(null)
  const savedTransformRef = useRef<SavedTransform | null>(null)
  const [agencies, setAgencies] = useState<{ id: string; name: string }[]>([])
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('')
  const [uploadDate, setUploadDate] = useState(() => {
    const t = new Date()
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  })
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
    const ids = rows.map(r => r.id)
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
          })
        }
      })
      .nodeContent((node: any) => getNodeHtml((node?.data || {}) as ChartNode))
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
      // Don't save transform - we'll always center on re-render
      chartInstanceRef.current = null
      if (containerRef.current?.firstChild) containerRef.current.innerHTML = ''
    }
  }, [chartData])

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
      })
      if (result.success) {
        const count = (result as { count?: number }).count ?? 0
        setUploadMessage({ type: 'success', text: `${uploadDialog.fileType} uploaded. ${count} record(s) processed.` })
        setTimeout(() => setUploadMessage(null), 6000)
        
        // Process deal tracker for supported carriers (AETNA, AMAM, MOH, RNA, TRANSAMERICA, LIBERTY)
        console.log('[UploadTreeOrgChart] Upload successful, checking deal tracker processing...', {
          carrierCode: uploadDialog.carrierCode,
          fileType: uploadDialog.fileType,
          hasFileId: 'fileId' in result,
          fileId: 'fileId' in result ? result.fileId : 'N/A',
        })
        
        if ((uploadDialog.carrierCode === 'AETNA' || uploadDialog.carrierCode === 'AMAM' || uploadDialog.carrierCode === 'MOH' || uploadDialog.carrierCode === 'RNA' || uploadDialog.carrierCode === 'TRANSAMERICA' || uploadDialog.carrierCode === 'LIBERTY' || uploadDialog.carrierCode === 'COREBRIDGE') && (uploadDialog.fileType === 'Policy' || uploadDialog.fileType === 'Commission') && 'fileId' in result) {
          console.log('[UploadTreeOrgChart] Triggering deal tracker processing for', uploadDialog.fileType, 'file...')
          await dealTracker.processAfterUpload(
            uploadDialog.agencyCarrierId,
            result.fileId,
            uploadDialog.carrierCode,
            uploadDialog.fileType,
            'pendingRows' in result ? (result.pendingRows as PendingRowsPayload) : undefined
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
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
            <Building2 className="w-4 h-4 text-orange-400" />
            <Label className="text-sm text-slate-300 font-medium">Agency:</Label>
            <Select value={selectedAgencyId} onValueChange={setSelectedAgencyId}>
              <SelectTrigger className="w-[220px] bg-slate-900 border-slate-700 text-white">
                <SelectValue placeholder="Select an agency" />
              </SelectTrigger>
              <SelectContent className="bg-slate-800 border-slate-700">
                {agencies.map(a => (
                  <SelectItem key={a.id} value={a.id} className="text-white focus:bg-slate-700">{a.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {selectedAgencyId && (
            <>
              <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
                <Calendar className="w-4 h-4 text-orange-400" />
                <Label className="text-sm text-slate-300 font-medium">Date:</Label>
                <Input type="date" value={uploadDate} onChange={e => setUploadDate(e.target.value)} className="w-40 bg-slate-900 border-slate-700 text-white text-sm" />
              </div>
              <Button variant="outline" size="sm" className="border-slate-700 text-slate-300 hover:bg-slate-800" onClick={() => { loadDailyStatuses(); loadTreeData(); }}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Refresh
              </Button>
            </>
          )}
        </div>
      </div>

      {uploadMessage && (
        <div className={cn('rounded-xl border px-4 py-3 flex items-center justify-between gap-4', uploadMessage.type === 'success' ? 'bg-emerald-950/60 border-emerald-600 text-emerald-100' : 'bg-red-950/60 border-red-600 text-red-100')}>
          <div className="flex items-center gap-3">
            {uploadMessage.type === 'success' ? <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" /> : <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />}
            <span className="text-sm font-medium">{uploadMessage.text}</span>
          </div>
          <button type="button" onClick={() => setUploadMessage(null)} className="text-slate-300 hover:text-white text-sm underline">Dismiss</button>
        </div>
      )}

      {!selectedAgencyId && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-16 flex flex-col items-center justify-center min-h-[500px] text-center">
          <div className="w-16 h-16 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-slate-400" />
          </div>
          <p className="text-slate-300 text-lg font-medium">Select an agency</p>
          <p className="text-slate-500 text-sm mt-2 max-w-sm">Choose an agency to see the org chart and upload Policy or Commission files per carrier.</p>
        </div>
      )}

      {selectedAgencyId && loading && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-12 flex flex-col items-center justify-center min-h-[500px]">
          <Loader2 className="w-12 h-12 animate-spin text-orange-400 mb-4" />
          <p className="text-slate-300">Loading tree...</p>
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length > 0 && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl overflow-hidden min-h-[600px]" style={{ minHeight: '700px', width: '100%' }}>
          <div ref={containerRef} className="w-full h-full min-h-[600px] [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:mx-auto [&>svg]:block" style={{ overflow: 'auto' }} />
        </div>
      )}

      <Dialog open={!!uploadDialog} onOpenChange={(open) => {
        if (!open) {
          setUploadDialog(null)
          setUploadingFile(null)
          setDragActive(false)
        }
      }}>
        <DialogContent className="bg-slate-900 border-slate-700" aria-describedby="upload-dialog-desc">
          <DialogHeader>
            <DialogTitle className="text-white flex items-center gap-2">
              <Upload className="w-5 h-5 text-orange-400" />
              Upload {uploadDialog?.fileType} — {uploadDialog?.carrierName}
            </DialogTitle>
            <DialogDescription id="upload-dialog-desc" className="text-slate-400 sr-only">
              Select a file to upload for this carrier and file type.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPT_TYPES}
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
                'flex items-center gap-4 rounded-xl border-2 border-dashed p-6 cursor-pointer transition-colors',
                'bg-slate-700/80 border-slate-600 hover:border-orange-500 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900',
                dragActive && 'border-orange-500 bg-slate-700'
              )}
            >
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-slate-600 text-slate-300">
                <Upload className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-slate-200">Drag and drop files</p>
                <p className="mt-0.5 text-sm text-slate-400">
                  Up to {MAX_FILE_SIZE_MB}MB per file in {ACCEPT_LABEL}.
                </p>
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                  className="mt-1 text-sm font-medium text-orange-400 underline hover:text-orange-300"
                >
                  Browse files
                </button>
              </div>
            </div>
            {uploadingFile && (
              <p className="text-sm text-slate-400">
                Selected: <span className="font-medium text-slate-200">{uploadingFile.name}</span>
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUploadDialog(null)} className="border-slate-600 text-slate-300">Cancel</Button>
            <Button onClick={handleUploadSubmit} disabled={!uploadingFile || uploading} className="bg-orange-600 hover:bg-orange-700">
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
      />
    </div>
  )
}
