'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import ReactFlow, {
  Node,
  Edge,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  Position,
  MarkerType,
  NodeTypes,
  Handle,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { supabase } from '@/lib/supabaseClient'
import { Building2, FileText, Loader2, RefreshCw, CheckCircle, AlertCircle, Calendar, ChevronRight, ChevronDown, MinusCircle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { executeUpload, type FileKind } from '@/lib/uploadLogic'
import { fetchDailyStatus, fetchDailyFileTypes, setDailyStatus, getLocalDayRange, type DailyStatus } from '@/lib/dailyUploadStatus'
import { useDealTrackerUpload } from '@/lib/useDealTrackerUpload'
import { useCommissionReportUpload, rollbackCommissionFileSession } from '@/lib/useCommissionReportUpload'
import { DealTrackerVerificationDialog } from '@/components/DealTrackerVerificationDialog'
import {
  CommissionReportDialog,
  type CommissionReportDialogProps,
} from '@/components/CommissionReportDialog'
import { cn } from '@/lib/utils'
import { adminOutlineBtn } from '@/lib/adminFieldClasses'

// Custom Node Components - Professional and Simple
function AgencyNode({ data }: { data: any }) {
  const hasChildren = data.hasChildren || false
  const isExpanded = data.isExpanded || false
  
  return (
    <div className="relative px-4 py-3 bg-gradient-to-br from-slate-800 to-slate-900 border-2 border-orange-500 rounded-lg shadow-xl min-w-[160px] max-w-[180px] cursor-pointer hover:border-orange-400 hover:shadow-2xl transition-all duration-200">
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-orange-500 !border-2 !border-slate-900" />
      <div className="flex items-center gap-2">
        {hasChildren && (
          <div className="flex items-center justify-center w-5 h-5 rounded bg-orange-500/20 shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-orange-400" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-orange-400" />
            )}
          </div>
        )}
        {!hasChildren && <div className="w-5 h-5 shrink-0" />}
        <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center shrink-0">
          <Building2 className="w-4 h-4 text-orange-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-white truncate">{data.label}</div>
          <div className="text-xs text-slate-400 font-medium">Agency</div>
        </div>
      </div>
    </div>
  )
}

function CarrierNode({ data }: { data: any }) {
  const status = data.status
  const isUploaded = status === 'uploaded'
  const isNoUpdate = status === 'no_update'
  const isPending = !status
  const hasChildren = data.hasChildren || false
  const isExpanded = data.isExpanded || false
  const [marking, setMarking] = useState(false)
  const onMarkNoUpdate = data.onMarkNoUpdate

  const handleNoUpdateToday = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!onMarkNoUpdate || marking) return
    setMarking(true)
    try {
      await onMarkNoUpdate()
    } finally {
      setMarking(false)
    }
  }

  return (
    <div className={cn(
      "relative px-4 py-3 rounded-lg shadow-lg min-w-[140px] max-w-[170px] border-2 cursor-pointer transition-all duration-200",
      isUploaded 
        ? 'bg-emerald-950/60 border-emerald-500 hover:border-emerald-400 hover:shadow-xl' 
        : isNoUpdate
          ? 'bg-slate-800/70 border-slate-600 hover:border-slate-500 hover:shadow-xl'
          : 'bg-slate-800 border-slate-700 hover:border-slate-600 hover:shadow-xl'
    )}>
      <Handle type="target" position={Position.Top} className="!w-3 !h-3 !bg-slate-400 !border-2 !border-slate-900" />
      <Handle type="source" position={Position.Bottom} className="!w-3 !h-3 !bg-slate-400 !border-2 !border-slate-900" />
      <div className="flex items-center gap-2 mb-1.5">
        {hasChildren && (
          <div className="flex items-center justify-center w-4 h-4 rounded bg-slate-700/50 shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-3 h-3 text-slate-300" />
            ) : (
              <ChevronRight className="w-3 h-3 text-slate-300" />
            )}
          </div>
        )}
        {!hasChildren && <div className="w-4 h-4 shrink-0" />}
        <div className="w-6 h-6 rounded bg-slate-700/50 flex items-center justify-center shrink-0">
          <FileText className="w-3.5 h-3.5 text-slate-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-slate-100 truncate">{data.label}</div>
          <div className="text-[10px] text-slate-400">Carrier</div>
        </div>
      </div>
      {isUploaded && (
        <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-300 bg-emerald-900/30 px-1.5 py-0.5 rounded">
          <CheckCircle className="w-3 h-3" />
          <span>Uploaded</span>
        </div>
      )}
      {isNoUpdate && (
        <div className="text-[10px] text-slate-400 bg-slate-800/50 px-1.5 py-0.5 rounded">No update</div>
      )}
      {isPending && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-medium text-amber-300 bg-amber-900/30 px-1.5 py-0.5 rounded">Pending</div>
          {onMarkNoUpdate && (
            <button
              type="button"
              onClick={handleNoUpdateToday}
              disabled={marking}
              className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-slate-200 hover:underline"
            >
              {marking ? <Loader2 className="w-3 h-3 animate-spin" /> : <MinusCircle className="w-3 h-3" />}
              No update today
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Compact round node: click to pick file and upload. Green when done or when carrier fully uploaded; gray when no update today. */
function UploadNode({ data }: { data: any }) {
  const [uploading, setUploading] = useState(false)
  const [localStatus, setLocalStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const carrierFullyUploaded = data.carrierFullyUploaded === true
  const carrierNoUpdate = data.carrierNoUpdate === true
  const thisFileTypeUploaded = data.thisFileTypeUploaded === true

  const label = data.fileType === 'Policy' ? 'P' : 'C'
  const title = carrierNoUpdate ? `${data.fileType} – no update today` : `${data.fileType} file – click to upload`

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
  }

  const handleClick = () => {
    if (uploading || carrierNoUpdate) return
    setLocalStatus('idle')
    const input = document.getElementById(`file-input-${data.id}`) as HTMLInputElement
    input?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Store file and show confirmation dialog instead of uploading immediately
    setPendingFile(file)
    setShowConfirmDialog(true)
    // Reset input so same file can be selected again if cancelled
    e.target.value = ''
  }

  const handleConfirmUpload = async () => {
    if (!pendingFile || !data.onUpload) return
    setShowConfirmDialog(false)
    setUploading(true)
    setLocalStatus('idle')
    try {
      await data.onUpload(pendingFile)
      setLocalStatus('success')
    } catch {
      setLocalStatus('error')
    } finally {
      setUploading(false)
      setPendingFile(null)
    }
  }

  const handleCancelUpload = () => {
    setShowConfirmDialog(false)
    setPendingFile(null)
  }

  const showGreen = localStatus === 'success' || carrierFullyUploaded || thisFileTypeUploaded
  const showGray = carrierNoUpdate
  const showError = localStatus === 'error'

  return (
    <>
      <input
        id={`file-input-${data.id}`}
        type="file"
        accept=".csv,.xlsx,.xls,.pdf"
        onChange={handleFileChange}
        className="hidden"
      />
      <div
        role="button"
        title={title}
        onClick={handleClick}
        className={cn(
          'relative w-11 h-11 rounded-full border-2 flex items-center justify-center transition-all duration-200 select-none',
          !showGray && 'hover:scale-110 hover:shadow-lg',
          showGreen && 'border-emerald-500 bg-emerald-500/20 cursor-default',
          showError && 'border-red-500 bg-red-500/20 cursor-pointer',
          showGray && 'border-slate-600 bg-slate-700/50 cursor-default',
          !showGreen && !showError && !showGray && !uploading && 'border-orange-500 bg-orange-500/20 hover:border-orange-400 cursor-pointer',
          uploading && 'border-slate-500 bg-slate-700/50 cursor-wait'
        )}
      >
        <Handle type="target" position={Position.Top} className="!w-2.5 !h-2.5 !bg-slate-500 !border-2 !border-slate-900 !-top-1" />
        {uploading ? (
          <Loader2 className="w-5 h-5 text-slate-300 animate-spin" />
        ) : showGreen ? (
          <CheckCircle className="w-5 h-5 text-emerald-400" />
        ) : showGray ? (
          <MinusCircle className="w-5 h-5 text-slate-400" />
        ) : showError ? (
          <AlertCircle className="w-5 h-5 text-red-400" />
        ) : (
          <span className="text-sm font-bold text-orange-200">{label}</span>
        )}
      </div>

      {/* Confirmation Dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent className="max-w-md border-border bg-card sm:rounded-2xl" aria-describedby="upload-confirm-desc">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <AlertCircle className="h-5 w-5 text-orange-500 dark:text-orange-400" />
              Confirm File Upload
            </DialogTitle>
            <DialogDescription id="upload-confirm-desc" className="text-muted-foreground">
              Please verify the file details before uploading.
            </DialogDescription>
          </DialogHeader>
          {pendingFile && (
            <div className="space-y-4 py-4">
              <div className="space-y-3 rounded-lg border border-border bg-muted/50 p-4 dark:border-slate-700 dark:bg-slate-800/50">
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">File Name</div>
                  <div className="break-all text-sm font-medium text-foreground">{pendingFile.name}</div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">File Size</div>
                  <div className="text-sm text-foreground/90">{formatFileSize(pendingFile.size)}</div>
                </div>
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">File Type</div>
                  <div className="text-sm text-foreground/90">{pendingFile.type || 'Not specified'}</div>
                </div>
                <div className="border-t border-border pt-2 dark:border-slate-700">
                  <div className="mb-1 text-xs text-muted-foreground">Upload Location</div>
                  <div className="text-sm text-foreground/90">
                    <div className="font-medium">{data.fileType}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {data.agencyName} → {data.carrierName}
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-900/20">
                <div className="flex items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                  <div className="text-xs text-amber-900 dark:text-amber-300">
                    Make sure this is the correct file. Uploading the wrong file may overwrite existing records.
                  </div>
                </div>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={handleCancelUpload}
              className={adminOutlineBtn}
            >
              Cancel
            </Button>
            <Button
              onClick={handleConfirmUpload}
              className="bg-orange-600 text-white hover:bg-orange-700"
            >
              Confirm & Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const nodeTypes: NodeTypes = {
  agency: AgencyNode,
  carrier: CarrierNode,
  upload: UploadNode,
}

// Layout: centered 3-tier tree (Agency → Carriers → Uploads). Bottom tier = small round nodes (P/C).
const NODE_WIDTH = 200
const UPLOAD_NODE_SIZE = 48    // small round nodes (44px + margin)
const TIER_GAP = 220
const SIBLING_GAP = 320
const UPLOAD_SIBLING_GAP = 64  // two small circles per carrier, tight

function calculateLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const nodeMap = new Map(nodes.map(n => [n.id, { ...n }]))
  const parentMap = new Map<string, string>()
  edges.forEach(edge => parentMap.set(edge.target, edge.source))

  const agencyNodes = nodes.filter(n => n.type === 'agency')
  const carrierNodes = nodes.filter(n => n.type === 'carrier')
  const uploadNodes = nodes.filter(n => n.type === 'upload')

  const agencyY = 20
  const carrierY = agencyY + TIER_GAP
  const uploadY = carrierY + TIER_GAP

  const carriersByAgency = new Map<string, Node[]>()
  carrierNodes.forEach(c => {
    const parent = parentMap.get(c.id)
    if (parent) {
      if (!carriersByAgency.has(parent)) carriersByAgency.set(parent, [])
      carriersByAgency.get(parent)!.push(c)
    }
  })
  const uploadsByCarrier = new Map<string, Node[]>()
  uploadNodes.forEach(u => {
    const parent = parentMap.get(u.id)
    if (parent) {
      if (!uploadsByCarrier.has(parent)) uploadsByCarrier.set(parent, [])
      uploadsByCarrier.get(parent)!.push(u)
    }
  })

  // Tier 1: single agency centered
  const numCarriers = carrierNodes.length
  const carrierRowWidth = Math.max((numCarriers - 1) * SIBLING_GAP + NODE_WIDTH, NODE_WIDTH)
  const agencyX = -carrierRowWidth / 2 + NODE_WIDTH / 2
  agencyNodes.forEach(node => {
    node.position = { x: agencyX, y: agencyY }
    nodeMap.set(node.id, node)
  })

  // Tier 2: carriers evenly spaced, row centered
  let carrierX = -carrierRowWidth / 2 + NODE_WIDTH / 2
  agencyNodes.forEach(agency => {
    const carriers = carriersByAgency.get(agency.id) || []
    carriers.forEach((carrier, i) => {
      carrier.position = { x: carrierX + i * SIBLING_GAP, y: carrierY }
      nodeMap.set(carrier.id, carrier)
    })
    carrierX += carriers.length * SIBLING_GAP
  })

  // Tier 3: two small round nodes (P / C) per carrier, centered under each carrier
  carrierNodes.forEach(carrier => {
    const uploads = uploadsByCarrier.get(carrier.id) || []
    if (uploads.length === 0) return
    const carrierPos = nodeMap.get(carrier.id)?.position ?? { x: 0, y: 0 }
    const uploadBlockWidth = Math.max((uploads.length - 1) * UPLOAD_SIBLING_GAP + UPLOAD_NODE_SIZE, UPLOAD_NODE_SIZE)
    const startX = carrierPos.x - uploadBlockWidth / 2 + UPLOAD_NODE_SIZE / 2
    uploads.forEach((upload, i) => {
      upload.position = { x: startX + i * UPLOAD_SIBLING_GAP, y: uploadY }
      nodeMap.set(upload.id, upload)
    })
  })

  return {
    nodes: Array.from(nodeMap.values()),
    edges: edges.map(edge => ({
      ...edge,
      type: 'smoothstep',
      animated: false,
      style: { 
        stroke: '#f97316', // Orange - matches theme, highly visible
        strokeWidth: 4,
        strokeDasharray: '0',
        opacity: 1,
        filter: 'drop-shadow(0 0 4px rgba(249, 115, 22, 0.6))',
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: '#f97316',
        width: 24,
        height: 24,
      },
    })),
  }
}

type AgencyOption = { id: string; name: string }

type LastUploadContext = {
  agencyCarrierId: string
  fileId: string
  carrierCode: string
  fileType: FileKind
}

export function UploadTreeFlow() {
  const dealTracker = useDealTrackerUpload()
  const commissionReport = useCommissionReportUpload({
    onAfterSave: () => dealTracker.confirmAndSave(),
  })
  const [lastUploadContext, setLastUploadContext] = useState<LastUploadContext | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [loading, setLoading] = useState(true)
  const [agencies, setAgencies] = useState<AgencyOption[]>([])
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('')
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [uploadDate, setUploadDate] = useState(() => {
    const today = new Date()
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  })
  const [dailyStatusMap, setDailyStatusMap] = useState<Record<string, DailyStatus>>({})
  const [uploadMessage, setUploadMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const onCommissionSaveDealTrackerOnly = useCallback<
    NonNullable<CommissionReportDialogProps['onSaveDealTrackerOnly']>
  >(async () => {
    const ctx = commissionReport.reportContext
    if (!ctx) return
    await dealTracker.confirmAndSave()
    await rollbackCommissionFileSession(ctx)
    commissionReport.closeAfterDealTrackerOnly()
  }, [commissionReport, dealTracker])

  const toggleNode = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev)
      if (next.has(nodeId)) {
        next.delete(nodeId)
      } else {
        next.add(nodeId)
      }
      return next
    })
  }, [])

  const loadTreeData = useCallback(async (
    agencyId: string,
    currentDailyStatusMap: Record<string, DailyStatus>,
    onMarkNoUpdateCarrier?: (agencyCarrierId: string) => Promise<void>,
    onUploadMessage?: (type: 'success' | 'error', text: string) => void
  ) => {
    if (!agencyId) {
      setNodes([])
      setEdges([])
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const { data: agencyRow, error: agencyError } = await supabase
        .from('agencies')
        .select('id, name')
        .eq('id', agencyId)
        .single()

      if (agencyError || !agencyRow) {
        setNodes([])
        setEdges([])
        setLoading(false)
        return
      }

      const agencies = [agencyRow]
      const allNodes: Node[] = []
      const allEdges: Edge[] = []
      const nodeMap = new Map<string, Node>()
      const childrenMap = new Map<string, string[]>() // parent -> children

      // Build all nodes for the selected agency only (use agencyRow.name so label matches selected agency)
      for (const agency of agencies) {
        const { data: agencyCarriers } = await supabase
          .from('agency_carriers')
          .select(`
            id,
            carriers (
              id,
              name,
              code
            )
          `)
          .eq('agency_id', agency.id)
          .order('carriers(name)')

        const agencyNodeId = `agency-${agency.id}`
        const agencyNode: Node = {
          id: agencyNodeId,
          type: 'agency',
          position: { x: 0, y: 0 },
          sourcePosition: Position.Bottom,
          data: { 
            label: agencyRow.name,
            hasChildren: (agencyCarriers?.length || 0) > 0,
            isExpanded: true,
            onNodeClick: () => toggleNode(agencyNodeId),
          },
        }
        allNodes.push(agencyNode)
        nodeMap.set(agencyNodeId, agencyNode)

        if (agencyCarriers && agencyCarriers.length > 0) {
          childrenMap.set(agencyNodeId, [])
          const acIds = agencyCarriers.map((ac: any) => ac.id)
          const dayRange = getLocalDayRange(uploadDate)
          const fileTypesByAc = await fetchDailyFileTypes(uploadDate, acIds, { startISO: dayRange.start, endISO: dayRange.end })

          agencyCarriers.forEach((ac: any) => {
            const carrier = ac.carriers
            if (!carrier) return

            const carrierId = `carrier-${ac.id}`
            const status = currentDailyStatusMap[ac.id]
            
            const carrierNode: Node = {
              id: carrierId,
              type: 'carrier',
              position: { x: 0, y: 0 },
              sourcePosition: Position.Bottom,
              targetPosition: Position.Top,
              data: {
                label: carrier.name || 'Unknown Carrier',
                status,
                hasChildren: true, // Always has 2 upload nodes
                isExpanded: true,
                onNodeClick: () => toggleNode(carrierId),
                onMarkNoUpdate: onMarkNoUpdateCarrier ? () => onMarkNoUpdateCarrier(ac.id) : undefined,
              },
            }
            allNodes.push(carrierNode)
            nodeMap.set(carrierId, carrierNode)
            childrenMap.get(agencyNodeId)!.push(carrierId)
            childrenMap.set(carrierId, [])

            // Upload nodes for Policy and Commission
            const uploadTypes: FileKind[] = ['Policy', 'Commission']
            uploadTypes.forEach((fileType) => {
              const uploadId = `upload-${ac.id}-${fileType}`
              
              const handleUpload = async (file: File) => {
                try {
                  const result = await executeUpload({
                    agencyCarrierId: ac.id,
                    agencyName: agency.name,
                    carrierName: carrier.name,
                    carrierCode: carrier.code,
                    file,
                    fileType,
                  })

                  if (result.success) {
                    await loadDailyStatuses() // Refetch – carrier and Policy/Commission nodes update (uses local day range)
                    const count = (result as { count?: number }).count ?? 0
                    
                    // Process deal tracker for supported carriers
                    console.log('[UploadTreeFlow] Upload successful, checking deal tracker processing...', {
                      carrierCode: carrier.code,
                      fileType,
                      hasFileId: 'fileId' in result,
                      fileId: 'fileId' in result ? result.fileId : 'N/A',
                    })
                    
                    const upperCarrierCode = String(carrier.code || '').toUpperCase()
                    const shouldProcessDealTracker =
                      (fileType === 'Policy' || fileType === 'Commission') &&
                      'fileId' in result
                    if (shouldProcessDealTracker) {
                      setLastUploadContext({
                        agencyCarrierId: ac.id,
                        fileId: result.fileId,
                        carrierCode: upperCarrierCode,
                        fileType,
                      })
                      console.log('[UploadTreeFlow] Triggering deal tracker processing for', fileType, 'file...')
                      const dealTrackerResult = await dealTracker.processAfterUpload(
                        ac.id,
                        result.fileId,
                        upperCarrierCode,
                        fileType
                      )
                      console.log('[UploadTreeFlow] Deal tracker processing result:', dealTrackerResult)
                    } else {
                      console.log('[UploadTreeFlow] Deal tracker processing skipped:', {
                        fileType,
                        hasFileId: 'fileId' in result,
                        shouldProcess: (fileType === 'Policy' || fileType === 'Commission'),
                      })
                    }
                    
                    onUploadMessage?.('success', `${fileType} file uploaded successfully. ${count} record(s) processed.`)
                    return result
                  } else {
                    const errMsg = result.error || 'Upload failed'
                    onUploadMessage?.('error', errMsg)
                    throw new Error(errMsg)
                  }
                } catch (e: any) {
                  const errMsg = e?.message || 'Upload failed'
                  onUploadMessage?.('error', errMsg)
                  throw e
                }
              }

              const uploadNode: Node = {
                id: uploadId,
                type: 'upload',
                position: { x: 0, y: 0 },
                targetPosition: Position.Top,
                data: {
                  id: uploadId,
                  fileType,
                  onUpload: handleUpload,
                  hasChildren: false,
                  carrierFullyUploaded: status === 'uploaded', // both P and C done → show both green
                  carrierNoUpdate: status === 'no_update',    // carrier marked no update → show P/C gray
                  thisFileTypeUploaded: fileTypesByAc[ac.id]?.has(fileType) ?? false, // this P or C already uploaded today
                  agencyName: agency.name, // For confirmation dialog
                  carrierName: carrier.name, // For confirmation dialog
                },
              }
              allNodes.push(uploadNode)
              nodeMap.set(uploadId, uploadNode)
              childrenMap.get(carrierId)!.push(uploadId)
            })
          })
        }
      }

      // Single-agency view: all nodes with children show as expanded
      allNodes.forEach(node => {
        const nodeData = node.data as any
        if (nodeData.hasChildren) {
          nodeData.isExpanded = true
        }
      })

      // Single-agency view: always show full tree (completely expanded). No intermingled wires.
      const singleAgencyView = agencies.length === 1
      const visibleNodes: Node[] = []
      const visibleEdges: Edge[] = []
      const visited = new Set<string>()

      const addNodeAndChildren = (nodeId: string, forceExpand: boolean = false) => {
        if (visited.has(nodeId)) return
        visited.add(nodeId)
        
        const node = nodeMap.get(nodeId)
        if (!node) return

        const nodeData = node.data as any
        const children = childrenMap.get(nodeId) || []
        const isExpanded = forceExpand
        if (nodeData.hasChildren) {
          nodeData.isExpanded = isExpanded
        }

        visibleNodes.push(node)
        if (children.length > 0 && (isExpanded || singleAgencyView)) {
          children.forEach(childId => {
            visibleEdges.push({
              id: `edge-${nodeId}-${childId}`,
              source: nodeId,
              target: childId,
              type: 'smoothstep',
              style: {
                stroke: '#f97316',
                strokeWidth: 4,
                opacity: 1,
              },
              markerEnd: {
                type: MarkerType.ArrowClosed,
                color: '#f97316',
                width: 24,
                height: 24,
              },
            })
            addNodeAndChildren(childId, singleAgencyView)
          })
        }
      }

      agencies.forEach(agency => {
        addNodeAndChildren(`agency-${agency.id}`, singleAgencyView)
      })

      // Don't update expanded state here – it causes the effect to re-run and reload in a loop

      // Calculate layout only for visible nodes
      const { nodes: positionedNodes, edges: styledEdges } = calculateLayout(visibleNodes, visibleEdges)
      
      // Smooth update
      setTimeout(() => {
        setNodes(positionedNodes)
        setEdges(styledEdges)
        setLoading(false)
      }, 50)
    } catch (error) {
      console.error('Error loading tree data:', error)
      setLoading(false)
    }
  }, [uploadDate, toggleNode])

  const loadDailyStatuses = useCallback(async () => {
    const { data: agencyCarriers } = await supabase
      .from('agency_carriers')
      .select('id')

    if (agencyCarriers && agencyCarriers.length > 0) {
      const ids = agencyCarriers.map(ac => ac.id)
      const dayRange = getLocalDayRange(uploadDate)
      const statusMap = await fetchDailyStatus(uploadDate, ids, { startISO: dayRange.start, endISO: dayRange.end })
      setDailyStatusMap(statusMap)
    }
  }, [uploadDate])

  const onMarkNoUpdateCarrier = useCallback(async (agencyCarrierId: string) => {
    const res = await setDailyStatus(uploadDate, agencyCarrierId, 'no_update')
    if (res.ok) await loadDailyStatuses()
  }, [uploadDate, loadDailyStatuses])

  const onUploadMessage = useCallback((type: 'success' | 'error', text: string) => {
    setUploadMessage({ type, text })
    setTimeout(() => setUploadMessage(null), 6000)
  }, [])

  const fetchAgencies = useCallback(async () => {
    const { data, error } = await supabase
      .from('agencies')
      .select('id, name')
      .order('name')
    if (!error && data) setAgencies(data)
  }, [])

  useEffect(() => {
    fetchAgencies()
  }, [fetchAgencies])

  // When switching agency, reset expanded state so the new tree loads fully expanded
  useEffect(() => {
    setExpandedNodes(new Set())
  }, [selectedAgencyId])

  useEffect(() => {
    loadDailyStatuses()
  }, [loadDailyStatuses])

  useEffect(() => {
    if (selectedAgencyId) {
      loadTreeData(selectedAgencyId, dailyStatusMap, onMarkNoUpdateCarrier, onUploadMessage)
    } else {
      setNodes([])
      setEdges([])
      setLoading(false)
    }
  }, [selectedAgencyId, dailyStatusMap, uploadDate, loadTreeData, onMarkNoUpdateCarrier, onUploadMessage])

  return (
    <div className="space-y-6">
      {/* Header with Agency dropdown and Date */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-50 mb-1">Upload Tree</h2>
            <p className="text-sm text-slate-400">Select an agency to view and upload files for that organization</p>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
              <Building2 className="w-4 h-4 text-orange-400" />
              <Label htmlFor="agency-select" className="text-sm text-slate-300 font-medium whitespace-nowrap">Agency:</Label>
              <Select value={selectedAgencyId} onValueChange={setSelectedAgencyId}>
                <SelectTrigger id="agency-select" className="w-[220px] bg-slate-900 border-slate-700 text-white focus:ring-orange-500 focus:border-orange-500">
                  <SelectValue placeholder="Select an agency" />
                </SelectTrigger>
                <SelectContent className="bg-slate-800 border-slate-700">
                  {agencies.map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-white focus:bg-slate-700 focus:text-white">
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selectedAgencyId && (
              <>
                <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
                  <Calendar className="w-4 h-4 text-orange-400" />
                  <Label htmlFor="upload-date-flow" className="text-sm text-slate-300 font-medium whitespace-nowrap">Date:</Label>
                  <Input
                    id="upload-date-flow"
                    type="date"
                    value={uploadDate}
                    onChange={(e) => setUploadDate(e.target.value)}
                    className="w-40 bg-slate-900 border-slate-700 text-white text-sm focus:border-orange-500 focus:ring-orange-500"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => loadTreeData(selectedAgencyId, dailyStatusMap, onMarkNoUpdateCarrier, onUploadMessage)}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Refresh
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {uploadMessage && (
        <div
          className={cn(
            'rounded-xl border px-4 py-3 flex items-center justify-between gap-4',
            uploadMessage.type === 'success'
              ? 'bg-emerald-950/60 border-emerald-600 text-emerald-100'
              : 'bg-red-950/60 border-red-600 text-red-100'
          )}
        >
          <div className="flex items-center gap-3">
            {uploadMessage.type === 'success' ? (
              <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            )}
            <span className="text-sm font-medium">{uploadMessage.text}</span>
          </div>
          <button
            type="button"
            onClick={() => setUploadMessage(null)}
            className="text-slate-300 hover:text-white text-sm underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {loading && selectedAgencyId && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-12 flex flex-col items-center justify-center min-h-[500px]">
          <Loader2 className="w-12 h-12 animate-spin text-orange-400 mb-4" />
          <p className="text-slate-300 text-lg font-medium">Loading organization tree...</p>
          <p className="text-slate-500 text-sm mt-2">Please wait</p>
        </div>
      )}

      {!selectedAgencyId && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-16 flex flex-col items-center justify-center min-h-[500px] text-center">
          <div className="w-16 h-16 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-slate-400" />
          </div>
          <p className="text-slate-300 text-lg font-medium">Select an agency</p>
          <p className="text-slate-500 text-sm mt-2 max-w-sm">Choose an agency from the dropdown above to see its upload tree (carriers and policy/commission uploads).</p>
        </div>
      )}

      {selectedAgencyId && !loading && (
      <>
      {/* React Flow Tree - Professional Dashboard */}
      <div className="bg-slate-900 border-2 border-slate-800 rounded-xl overflow-hidden shadow-2xl" style={{ height: '950px' }}>
        <ReactFlow
          key={`upload-tree-${selectedAgencyId}`}
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(event, node) => {
            const nodeData = node.data as any
            if (nodeData.onNodeClick) {
              nodeData.onNodeClick()
            }
          }}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.3, duration: 400 }}
          defaultViewport={{ x: 0, y: 0, zoom: 0.75 }}
          minZoom={0.2}
          maxZoom={2}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable={true}
          edgesUpdatable={false}
          edgesFocusable={true}
          connectionLineStyle={{ stroke: '#f97316', strokeWidth: 4 }}
          defaultEdgeOptions={{
            type: 'smoothstep',
            animated: false,
            style: { 
              stroke: '#f97316', 
              strokeWidth: 4,
              opacity: 1,
              filter: 'drop-shadow(0 0 4px rgba(249, 115, 22, 0.6))',
            },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              color: '#f97316',
              width: 24,
              height: 24,
            },
          }}
        >
          <Background color="#0f172a" gap={25} size={1} />
          <Controls 
            className="bg-slate-800/90 border-slate-700 rounded-lg shadow-lg"
            showZoom={true}
            showFitView={true}
            showInteractive={false}
          />
          <MiniMap 
            className="bg-slate-800/90 border-slate-700 rounded-lg shadow-lg"
            nodeColor={(node) => {
              if (node.type === 'agency') return '#f97316'
              if (node.type === 'carrier') return '#64748b'
              return '#475569'
            }}
            maskColor="rgba(0, 0, 0, 0.7)"
            pannable={true}
            zoomable={true}
          />
        </ReactFlow>
      </div>
      </>
      )}

      {/* Deal Tracker Verification Dialog */}
      <DealTrackerVerificationDialog
        open={dealTracker.showVerification}
        onOpenChange={dealTracker.setShowVerification}
        entries={dealTracker.verificationEntries}
        onConfirm={dealTracker.confirmAndSave}
        onCancel={dealTracker.cancelVerification}
        fileType={lastUploadContext?.fileType}
        onNext={
          lastUploadContext?.fileType === 'Commission' &&
          ['AETNA', 'AMAM', 'MOH', 'COREBRIDGE', 'AFLAC', 'AHL'].includes(
            (lastUploadContext?.carrierCode || '').toUpperCase()
          )
            ? () => {
                dealTracker.setShowVerification(false)
                if (lastUploadContext)
                  commissionReport.openCommissionReport(
                    lastUploadContext.agencyCarrierId,
                    lastUploadContext.fileId,
                    lastUploadContext.carrierCode
                  )
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
        onSaveDealTrackerOnly={onCommissionSaveDealTrackerOnly}
      />
    </div>
  )
}
