'use client'

import { useState, useEffect, type ReactNode } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { TreeNode } from './Tree'
import { Building2, FileText, Upload, Loader2, RefreshCw, CloudUpload, CheckCircle, AlertCircle, ChevronRight, ChevronDown, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { executeUpload, type FileKind } from '@/lib/uploadLogic'
import { useDealTrackerUpload } from '@/lib/useDealTrackerUpload'
import { useCommissionReportUpload } from '@/lib/useCommissionReportUpload'
import { DealTrackerVerificationDialog } from '@/components/DealTrackerVerificationDialog'
import { CommissionReportDialog } from '@/components/CommissionReportDialog'
import { fetchDailyStatus, type DailyStatus } from '@/lib/dailyUploadStatus'
import { cn } from '@/lib/utils'

export function UploadTree() {
  const dealTracker = useDealTrackerUpload()
  const commissionReport = useCommissionReportUpload({
    onAfterSave: () => dealTracker.confirmAndSave(),
  })
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())
  const [uploadDate, setUploadDate] = useState(() => {
    const today = new Date()
    return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  })
  const [uploadingStates, setUploadingStates] = useState<Record<string, { uploading: boolean; message?: { type: 'success' | 'error'; text: string } }>>({})
  const [dailyStatusMap, setDailyStatusMap] = useState<Record<string, DailyStatus>>({})
  const [lastUploadContext, setLastUploadContext] = useState<{
    agencyCarrierId: string
    fileId: string
    carrierCode: string
    fileType: FileKind
  } | null>(null)

  useEffect(() => {
    loadTreeData()
  }, [])

  useEffect(() => {
    if (treeNodes.length > 0 && uploadDate) {
      loadDailyStatuses()
    }
  }, [uploadDate, treeNodes])

  const loadDailyStatuses = async () => {
    const agencyCarrierIds: string[] = []
    treeNodes.forEach(agency => {
      agency.children?.forEach(carrier => {
        if (carrier.agencyCarrierId) {
          agencyCarrierIds.push(carrier.agencyCarrierId)
        }
      })
    })
    
    if (agencyCarrierIds.length > 0) {
      const statusMap = await fetchDailyStatus(uploadDate, agencyCarrierIds)
      setDailyStatusMap(statusMap)
    }
  }

  const loadTreeData = async () => {
    setLoading(true)
    try {
      const { data: agencies, error: agenciesError } = await supabase
        .from('agencies')
        .select('id, name')
        .order('name')

      if (agenciesError) {
        console.error('Error fetching agencies:', agenciesError)
        throw agenciesError
      }

      if (!agencies || agencies.length === 0) {
        setTreeNodes([])
        setLoading(false)
        return
      }

      const nodes: TreeNode[] = await Promise.all(
        agencies.map(async (agency) => {
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

          const agencyId = `agency-${agency.id}`
          
          const carrierNodes: TreeNode[] = (agencyCarriers || [])
            .map((ac: any) => {
              const carrier = ac.carriers
              if (!carrier) return null

              const carrierId = `carrier-${ac.id}`
              const policyUploadId = `upload-policy-${ac.id}`
              const commissionUploadId = `upload-commission-${ac.id}`

              return {
                id: carrierId,
                label: carrier.name || 'Unknown Carrier',
                icon: <FileText className="w-4 h-4" />,
                children: [
                  {
                    id: policyUploadId,
                    label: 'Upload Policy File',
                    icon: <Upload className="w-4 h-4" />,
                    isUploadNode: true,
                    fileType: 'Policy' as FileKind,
                    agencyCarrierId: ac.id,
                    agencyName: agency.name,
                    carrierName: carrier.name,
                    carrierCode: carrier.code,
                  },
                  {
                    id: commissionUploadId,
                    label: 'Upload Commission File',
                    icon: <Upload className="w-4 h-4" />,
                    isUploadNode: true,
                    fileType: 'Commission' as FileKind,
                    agencyCarrierId: ac.id,
                    agencyName: agency.name,
                    carrierName: carrier.name,
                    carrierCode: carrier.code,
                  },
                ] as any[],
                data: { type: 'carrier', ...carrier },
                agencyCarrierId: ac.id,
              } as TreeNode
            })
            .filter(Boolean) as TreeNode[]

          return {
            id: agencyId,
            label: agency.name,
            icon: <Building2 className="w-4 h-4" />,
            children: carrierNodes.length > 0 ? carrierNodes : undefined,
            data: { type: 'agency', ...agency },
          } as TreeNode
        })
      )

      setTreeNodes(nodes)
      // Auto-expand all agencies by default for smooth top-to-bottom view
      const allAgencyIds = new Set(nodes.map(n => n.id))
      setExpandedNodes(allAgencyIds)
    } catch (error) {
      console.error('Error loading tree data:', error)
    } finally {
      setLoading(false)
    }
  }

  const handleFileUpload = async (
    agencyCarrierId: string,
    agencyName: string,
    carrierName: string,
    carrierCode: string,
    fileType: FileKind,
    file: File
  ) => {
    const uploadKey = `${agencyCarrierId}-${fileType}`
    setUploadingStates(prev => ({ ...prev, [uploadKey]: { uploading: true } }))

    try {
      const result = await executeUpload({
        agencyCarrierId,
        agencyName,
        carrierName,
        carrierCode,
        file,
        fileType,
      })

      if (result.success) {
        // Process deal tracker for supported carriers
        console.log('[UploadTree] Upload successful, checking deal tracker processing...', {
          carrierCode,
          fileType,
          hasFileId: 'fileId' in result,
          fileId: 'fileId' in result ? result.fileId : 'N/A',
        })
        
        const upperCarrierCode = (carrierCode || '').toUpperCase()

        if ((fileType === 'Policy' || fileType === 'Commission') && 'fileId' in result) {
          console.log('[UploadTree] Triggering deal tracker processing for', fileType, 'file...')
          setLastUploadContext({
            agencyCarrierId,
            fileId: result.fileId,
            carrierCode,
            fileType,
          })
          await dealTracker.processAfterUpload(agencyCarrierId, result.fileId, carrierCode, fileType)
        }
        
        await loadDailyStatuses() // Refresh – carrier shows green only when both Policy and Commission uploaded
        setUploadingStates(prev => ({
          ...prev,
          [uploadKey]: {
            uploading: false,
            message: { type: 'success', text: `Uploaded ${result.count} records successfully!` }
          }
        }))
        setTimeout(() => {
          setUploadingStates(prev => {
            const next = { ...prev }
            delete next[uploadKey]
            return next
          })
        }, 5000)
      } else {
        setUploadingStates(prev => ({
          ...prev,
          [uploadKey]: {
            uploading: false,
            message: { type: 'error', text: result.error || 'Upload failed' }
          }
        }))
      }
    } catch (error: any) {
      setUploadingStates(prev => ({
        ...prev,
        [uploadKey]: {
          uploading: false,
          message: { type: 'error', text: error?.message || 'Upload failed' }
        }
      }))
    }
  }

  if (loading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-8 flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
      </div>
    )
  }

  if (treeNodes.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center">
        <div className="max-w-md mx-auto space-y-4">
          <div className="w-16 h-16 mx-auto rounded-full bg-slate-800 flex items-center justify-center">
            <Building2 className="w-8 h-8 text-slate-400" />
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-semibold text-slate-100">No agencies found</h3>
            <p className="text-sm text-slate-400">Create an agency and link carriers to start uploading files.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header with Date Selector */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-50 mb-1">Upload Tree</h2>
            <p className="text-sm text-slate-400">Upload policy and commission files by agency and carrier</p>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
              <Calendar className="w-4 h-4 text-orange-400" />
              <Label htmlFor="upload-date" className="text-sm text-slate-300 font-medium whitespace-nowrap">Date:</Label>
              <Input
                id="upload-date"
                type="date"
                value={uploadDate}
                onChange={(e) => setUploadDate(e.target.value)}
                className="w-40 bg-slate-900 border-slate-700 text-white text-sm focus:border-orange-500 focus:ring-orange-500"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={loadTreeData}
              className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </div>
      
      {/* Tree Structure */}
      <CustomUploadTree
        nodes={treeNodes}
        defaultExpanded={Array.from(expandedNodes)}
        uploadDate={uploadDate}
        uploadingStates={uploadingStates}
        dailyStatusMap={dailyStatusMap}
        onFileUpload={handleFileUpload}
      />

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
            ? () => {
                dealTracker.setShowVerification(false)
                if (lastUploadContext) {
                  commissionReport.openCommissionReport(
                    lastUploadContext.agencyCarrierId,
                    lastUploadContext.fileId,
                    lastUploadContext.carrierCode
                  )
                }
              }
            : undefined
        }
      />

      {/* Commission Report Dialog (Commission Tracker) */}
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

interface CustomUploadTreeProps {
  nodes: TreeNode[]
  defaultExpanded?: string[]
  uploadDate: string
  uploadingStates: Record<string, { uploading: boolean; message?: { type: 'success' | 'error'; text: string } }>
  dailyStatusMap: Record<string, DailyStatus>
  onFileUpload: (
    agencyCarrierId: string,
    agencyName: string,
    carrierName: string,
    carrierCode: string,
    fileType: FileKind,
    file: File
  ) => void
}

function CustomUploadTree({ nodes, defaultExpanded = [], uploadDate, uploadingStates, dailyStatusMap, onFileUpload }: CustomUploadTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set(defaultExpanded))
  const [fileInputs, setFileInputs] = useState<Record<string, File | null>>({})

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const renderNode = (node: TreeNode & { isUploadNode?: boolean; fileType?: FileKind; agencyCarrierId?: string; agencyName?: string; carrierName?: string; carrierCode?: string }, level: number = 0): ReactNode => {
    const hasChildren = node.children && node.children.length > 0
    const isExpanded = expanded.has(node.id)
    const indent = level * 20
    const isTopLevel = level === 0
    const isCarrierLevel = level === 1
    const isUploadNode = node.isUploadNode
    const uploadKey = node.agencyCarrierId && node.fileType ? `${node.agencyCarrierId}-${node.fileType}` : null
    const uploadState = uploadKey ? uploadingStates[uploadKey] : null
    const file = uploadKey ? fileInputs[uploadKey] : null
    const carrierStatus = node.agencyCarrierId ? dailyStatusMap[node.agencyCarrierId] : undefined

    if (isUploadNode && node.agencyCarrierId && node.fileType && node.agencyName && node.carrierName && node.carrierCode) {
      return (
        <div key={node.id} className="select-none relative">
          {level > 0 && (
            <div
              className="absolute left-0 top-0 bottom-0 w-px bg-slate-700/50"
              style={{ left: `${indent - 8}px` }}
            />
          )}
          
          <div
            className={cn(
              'group flex flex-col gap-2 px-3 py-3 rounded-lg transition-all duration-200 relative',
              'hover:bg-slate-800/50',
              level > 0 && 'ml-1'
            )}
            style={{ paddingLeft: `${12 + indent}px` }}
          >
            <div className="flex items-center gap-2.5">
              <div className="w-5 h-5 flex items-center justify-center shrink-0 -ml-1">
                <div className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              </div>
              <div className="w-5 h-5 flex items-center justify-center shrink-0 text-slate-400">
                {node.icon}
              </div>
              <span className="flex-1 text-sm text-slate-300 font-medium">{node.label}</span>
            </div>

            <div className="ml-8 mt-3 space-y-3 bg-slate-900/50 rounded-lg p-4 border border-slate-700/50">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1 h-4 bg-orange-500 rounded-full" />
                <span className="text-xs font-medium text-slate-300 uppercase tracking-wide">{node.fileType} File Upload</span>
              </div>
              
              <div className="space-y-3">
                <div>
                  <Label className="text-xs text-slate-400 mb-1.5 block">Select File (CSV or Excel)</Label>
                  <Input
                    type="file"
                    accept=".csv,.xlsx,.xls,.pdf"
                    onChange={(e) => {
                      const selectedFile = e.target.files?.[0]
                      if (selectedFile && uploadKey) {
                        setFileInputs(prev => ({ ...prev, [uploadKey]: selectedFile }))
                      }
                    }}
                    className="bg-slate-800 border-slate-700 text-white text-sm file:mr-2 file:rounded file:border-0 file:bg-orange-600 file:px-3 file:py-1.5 file:text-white file:text-xs file:cursor-pointer hover:border-orange-500/50 transition-colors"
                  />
                </div>
                
                {file && (
                  <div className="flex items-center gap-2 text-xs text-slate-300 bg-slate-800/50 rounded px-3 py-2 border border-slate-700/50">
                    <FileText className="w-3.5 h-3.5 text-orange-400" />
                    <span className="truncate flex-1">{file.name}</span>
                    <span className="text-slate-500">({(file.size / 1024).toFixed(1)} KB)</span>
                  </div>
                )}

                <Button
                  size="sm"
                  onClick={() => {
                    if (file && uploadKey) {
                      onFileUpload(
                        node.agencyCarrierId!,
                        node.agencyName!,
                        node.carrierName!,
                        node.carrierCode!,
                        node.fileType!,
                        file
                      )
                    }
                  }}
                  disabled={!file || uploadState?.uploading}
                  className="w-full bg-orange-600 hover:bg-orange-700 text-white text-sm h-9 font-medium shadow-lg shadow-orange-600/20 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {uploadState?.uploading ? (
                    <>
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    <>
                      <CloudUpload className="w-4 h-4 mr-2" />
                      Upload {node.fileType} File
                    </>
                  )}
                </Button>

                {uploadState?.message && (
                  <div className={cn(
                    'flex items-center gap-2 p-3 rounded-lg text-xs border',
                    uploadState.message.type === 'success'
                      ? 'bg-emerald-900/40 text-emerald-300 border-emerald-700/50'
                      : 'bg-red-900/40 text-red-300 border-red-700/50'
                  )}>
                    {uploadState.message.type === 'success' ? (
                      <CheckCircle className="w-4 h-4 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 shrink-0" />
                    )}
                    <span className="flex-1">{uploadState.message.text}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )
    }

    // Render carrier node with status indicator
    if (isCarrierLevel && node.agencyCarrierId) {
      const status = carrierStatus
      const isUploaded = status === 'uploaded'
      const isNoUpdate = status === 'no_update'
      
      return (
        <div key={node.id} className="select-none relative">
          <div
            className={cn(
              'group flex items-center gap-2.5 px-4 py-3 rounded-lg cursor-pointer transition-all duration-200 relative border',
              'hover:bg-slate-800/70 hover:border-slate-600',
              isUploaded 
                ? 'bg-emerald-950/30 border-emerald-700/50' 
                : isNoUpdate
                  ? 'bg-slate-800/40 border-slate-700/50'
                  : 'bg-slate-800/30 border-slate-700/30'
            )}
            style={{ paddingLeft: `${16 + indent}px` }}
            onClick={() => {
              if (hasChildren) {
                toggle(node.id)
              }
            }}
          >
            <div className="w-5 h-5 flex items-center justify-center shrink-0 -ml-1">
              {hasChildren ? (
                <div 
                  className="transition-transform duration-200 rounded hover:bg-slate-700/50 p-0.5" 
                  style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                >
                  <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-200" />
                </div>
              ) : (
                <div className="w-1.5 h-1.5 rounded-full bg-slate-500 group-hover:bg-slate-400 transition-colors" />
              )}
            </div>

            <div className="w-5 h-5 flex items-center justify-center shrink-0 transition-colors text-slate-300">
              {node.icon || <FileText className="w-4 h-4" />}
            </div>

            <span className="flex-1 text-sm font-medium text-slate-200">
              {node.label}
            </span>

            {isUploaded && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-900/60 px-2.5 py-0.5 text-xs font-medium text-emerald-300">
                <CheckCircle className="w-3 h-3" /> Uploaded
              </span>
            )}
            {isNoUpdate && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-700 px-2.5 py-0.5 text-xs font-medium text-slate-300">
                No update
              </span>
            )}
            {!status && (
              <span className="rounded-full bg-amber-900/50 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                Pending
              </span>
            )}
          </div>
        </div>
      )
    }

    // Render agency or other nodes
    return (
      <div key={node.id} className="select-none relative">
        <div
          className={cn(
            'group flex items-center gap-2.5 px-4 py-3 rounded-lg cursor-pointer transition-all duration-200 relative border',
            'hover:bg-slate-800/70 hover:border-slate-600',
            isTopLevel && 'font-medium bg-slate-800/40 border-slate-700/50 hover:bg-slate-800/60'
          )}
          style={{ paddingLeft: `${16 + indent}px` }}
          onClick={() => {
            if (hasChildren) {
              toggle(node.id)
            }
          }}
        >
          <div className="w-5 h-5 flex items-center justify-center shrink-0 -ml-1">
            {hasChildren ? (
              <div 
                className="transition-transform duration-200 rounded hover:bg-slate-700/50 p-0.5" 
                style={{ transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
              >
                <ChevronRight className="w-4 h-4 text-slate-400 group-hover:text-slate-200" />
              </div>
            ) : (
              <div className="w-1.5 h-1.5 rounded-full bg-slate-500 group-hover:bg-slate-400 transition-colors" />
            )}
          </div>

          <div className={cn(
            'w-5 h-5 flex items-center justify-center shrink-0 transition-colors',
            isTopLevel ? 'text-orange-400' : 'text-slate-400 group-hover:text-slate-200'
          )}>
            {node.icon || <FileText className="w-4 h-4" />}
          </div>

          <span className={cn(
            'flex-1 text-sm truncate transition-colors',
            isTopLevel ? 'text-slate-100 font-semibold' : 'text-slate-300'
          )}>
            {node.label}
          </span>

          {node.badge !== undefined && (
            <span className={cn(
              'px-2 py-0.5 text-xs font-medium rounded-full transition-colors',
              isTopLevel 
                ? 'bg-orange-600/20 text-orange-300 border border-orange-600/30' 
                : 'bg-slate-800 text-slate-300 group-hover:bg-slate-700'
            )}>
              {node.badge}
            </span>
          )}
        </div>

        {hasChildren && (
          <div
            className={cn(
              'overflow-hidden transition-all duration-300 ease-in-out relative',
              isExpanded ? 'max-h-[10000px] opacity-100' : 'max-h-0 opacity-0'
            )}
          >
            <div className="relative pt-2 pb-1">
              {node.children!.map((child, idx) => (
                <div key={child.id} className="relative mb-2 last:mb-0">
                  {renderNode(child as any, level + 1)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl">
      <div className="p-4 space-y-2">
        {nodes.length === 0 ? (
          <div className="text-center py-12 text-slate-400">
            <Building2 className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p>No agencies found. Create agencies and link carriers to start uploading files.</p>
          </div>
        ) : (
          nodes.map((node) => (
            <div key={node.id} className="mb-3 last:mb-0">
              {renderNode(node, 0)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
