'use client'

import { useRef, useLayoutEffect, useState, useCallback, useEffect } from 'react'
import { OrgChart } from 'd3-org-chart'
import { zoomIdentity } from 'd3-zoom'
import { supabase } from '@/lib/supabaseClient'
import { Building2, Users, FileText, ChevronRight, ChevronDown, Plus, X, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type ChartNode = {
  id: string
  parentId: string
  name: string
  type: 'Agency' | 'Agent' | 'Carrier'
  agentId?: string
  agencyCarrierId?: string
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
  
  // Carrier
  return `<div style="${base}background:linear-gradient(135deg,#1e293b 0%,#334155 100%);color:#e2e8f0;border:2px solid #64748b;">
    <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
    <div style="font-size:10px;color:#94a3b8;">Carrier</div>
  </div>`
}

export function OrganizationChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartInstanceRef = useRef<InstanceType<typeof OrgChart> | null>(null)
  const [agencies, setAgencies] = useState<{ id: string; name: string }[]>([])
  const [selectedAgencyId, setSelectedAgencyId] = useState<string>('')
  const [chartData, setChartData] = useState<ChartNode[]>([])
  const [loading, setLoading] = useState(false)

  const loadAgencies = useCallback(async () => {
    const { data } = await supabase.from('agencies').select('id, name').order('name')
    setAgencies(data ?? [])
  }, [])

  const loadTreeData = useCallback(async () => {
    if (!selectedAgencyId) {
      setChartData([])
      return
    }
    setLoading(true)
    try {
      const [agencyRes, agentsRes, acRes] = await Promise.all([
        supabase.from('agencies').select('id, name').eq('id', selectedAgencyId).single(),
        supabase.from('agents').select('id, name, email').eq('agency_id', selectedAgencyId).order('name'),
        supabase.from('agency_carriers')
          .select('id, agency_id, carriers(id, name, code)')
          .eq('agency_id', selectedAgencyId)
          .order('carriers(name)'),
      ])
      
      const agency = agencyRes.data
      const agents = (agentsRes.data ?? []) as { id: string; name: string; email?: string }[]
      const agencyCarriers = (acRes.data ?? []).map((ac: any) => ({
        id: ac.id,
        agency_id: ac.agency_id,
        carrier: Array.isArray(ac.carriers) ? ac.carriers[0] ?? null : ac.carriers ?? null,
      })) as { id: string; agency_id: string; carrier: { id: string; name: string; code: string } | null }[]
      
      if (!agency) {
        setChartData([])
        return
      }

      // Fetch agent-carrier relationships
      const { data: agentCarriersData } = await supabase
        .from('agent_carriers')
        .select('agent_id, agency_carrier_id')
        .in('agent_id', agents.map(a => a.id))

      const agentCarrierMap = new Map<string, Set<string>>()
      if (agentCarriersData) {
        agentCarriersData.forEach((ac: any) => {
          if (!agentCarrierMap.has(ac.agent_id)) {
            agentCarrierMap.set(ac.agent_id, new Set())
          }
          agentCarrierMap.get(ac.agent_id)!.add(ac.agency_carrier_id)
        })
      }

      const nodes: ChartNode[] = []
      const rootId = `agency-${agency.id}`
      nodes.push({
        id: rootId,
        parentId: '',
        name: agency.name || 'Agency',
        type: 'Agency',
      })

      // Add agents as children of agency
      for (const agent of agents) {
        const agentId = `agent-${agent.id}`
        nodes.push({
          id: agentId,
          parentId: rootId,
          name: agent.name || 'Unnamed Agent',
          type: 'Agent',
          agentId: agent.id,
          email: agent.email,
        })

        // Add carriers assigned to this agent
        const agentCarrierIds = agentCarrierMap.get(agent.id) || new Set()
        for (const ac of agencyCarriers) {
          if (agentCarrierIds.has(ac.id) && ac.carrier) {
            nodes.push({
              id: `carrier-${agent.id}-${ac.id}`,
              parentId: agentId,
              name: ac.carrier.name || 'Carrier',
              type: 'Carrier',
              agencyCarrierId: ac.id,
            })
          }
        }
      }

      setChartData(nodes)
    } catch (e) {
      console.error(e)
      setChartData([])
    } finally {
      setLoading(false)
    }
  }, [selectedAgencyId])

  useEffect(() => {
    loadAgencies()
  }, [loadAgencies])

  useEffect(() => {
    loadTreeData()
  }, [loadTreeData])

  useLayoutEffect(() => {
    if (!chartData.length || !containerRef.current) return

    const chart = new OrgChart()
    chartInstanceRef.current = chart
    chart
      .container(containerRef.current)
      .data(chartData as any)
      .nodeWidth(() => 180)
      .nodeHeight(() => 90)
      .compactMarginBetween(() => 40)
      .onNodeClick((node: any) => {
        // View-only: no action on click
        // Carrier assignment is done in the Agents page
      })
      .nodeContent((node: any) => getNodeHtml((node?.data || {}) as ChartNode))
      .render()

    // Center the chart after render
    setTimeout(() => {
      try {
        if ((chart as any).centerOnNode && chartData.length > 0) {
          const rootNode = chartData.find(n => n.type === 'Agency')
          if (rootNode) {
            (chart as any).centerOnNode(rootNode.id, true)
            return
          }
        }
      } catch (_) {}
      
      try {
        const state = chart.getChartState?.()
        if (state?.svg && containerRef.current) {
          const svg = state.svg as any
          const container = containerRef.current
          const containerWidth = container.clientWidth || container.offsetWidth || 1200
          const containerHeight = container.clientHeight || container.offsetHeight || 800
          
          const svgElement = svg.node?.() || container.querySelector('svg')
          if (svgElement) {
            const bbox = svgElement.getBBox()
            const svgWidth = bbox.width || svgElement.viewBox?.baseVal?.width || 1000
            const svgHeight = bbox.height || svgElement.viewBox?.baseVal?.height || 600
            
            const scale = Math.min(1, Math.min(containerWidth / svgWidth, containerHeight / svgHeight) * 0.9)
            const x = (containerWidth - svgWidth * scale) / 2 - bbox.x * scale
            const y = (containerHeight - svgHeight * scale) / 2 - bbox.y * scale
            
            if (state.zoomBehavior) {
              const identity = zoomIdentity.translate(x, y).scale(scale)
              svg.call(state.zoomBehavior.transform, identity)
            }
          }
        }
      } catch (err) {
        console.warn('[OrganizationChart] Failed to center chart:', err)
      }
    }, 150)

    return () => {
      chartInstanceRef.current = null
      if (containerRef.current?.firstChild) containerRef.current.innerHTML = ''
    }
  }, [chartData])


  return (
    <div className="space-y-6">
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 bg-slate-800 rounded-lg px-4 py-2 border border-slate-700">
            <Building2 className="w-4 h-4 text-orange-400" />
            <Label className="text-sm text-slate-300 font-medium">Agency:</Label>
            <Select value={selectedAgencyId || undefined} onValueChange={setSelectedAgencyId}>
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
            <Button 
              variant="outline" 
              size="sm" 
              className="border-slate-700 text-slate-300 hover:bg-slate-800" 
              onClick={loadTreeData}
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {!selectedAgencyId && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-16 flex flex-col items-center justify-center min-h-[500px] text-center">
          <div className="w-16 h-16 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center mb-4">
            <Building2 className="w-8 h-8 text-slate-400" />
          </div>
          <p className="text-slate-300 text-lg font-medium">Select an agency</p>
          <p className="text-slate-500 text-sm mt-2 max-w-sm">Choose an agency to see the organization hierarchy: Agency → Agents → Carriers.</p>
        </div>
      )}

      {selectedAgencyId && loading && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-12 flex flex-col items-center justify-center min-h-[500px]">
          <Loader2 className="w-12 h-12 animate-spin text-orange-400 mb-4" />
          <p className="text-slate-300">Loading organization chart...</p>
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length > 0 && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl overflow-hidden min-h-[600px]" style={{ minHeight: '700px', width: '100%' }}>
          <div ref={containerRef} className="w-full h-full min-h-[600px] [&>svg]:max-w-full [&>svg]:h-auto [&>svg]:mx-auto [&>svg]:block" style={{ overflow: 'auto' }} />
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length === 0 && (
        <div className="bg-slate-900 border-2 border-slate-800 rounded-xl p-12 flex flex-col items-center justify-center min-h-[500px] text-center">
          <Users className="w-12 h-12 text-slate-400 mb-4" />
          <p className="text-slate-300 text-lg font-medium">No agents found</p>
          <p className="text-slate-500 text-sm mt-2">Add agents to this agency to see the organization chart.</p>
        </div>
      )}
    </div>
  )
}
