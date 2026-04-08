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
import { useTheme } from '@/components/ThemeProvider'
import { adminOutlineBtn, adminSelectContent, adminSelectItem, adminSelectTrigger } from '@/lib/adminFieldClasses'

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

  if (light) {
    return `<div style="${base}background:linear-gradient(135deg,#f8fafc 0%,#e2e8f0 100%);color:#0f172a;border:2px solid #94a3b8;">
    <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
    <div style="font-size:10px;color:#475569;">Carrier</div>
  </div>`
  }
  return `<div style="${base}background:linear-gradient(135deg,#1e293b 0%,#334155 100%);color:#e2e8f0;border:2px solid #64748b;">
    <div style="font-weight:600;font-size:13px;">${escapeHtml(d.name)}</div>
    <div style="font-size:10px;color:#94a3b8;">Carrier</div>
  </div>`
}

export function OrganizationChart() {
  const { theme } = useTheme()
  const isLight = theme === 'light'
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
      .nodeContent((node: any) => getNodeHtml((node?.data || {}) as ChartNode, isLight))
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
  }, [chartData, isLight])


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
            <Button
              variant="outline"
              size="sm"
              className={adminOutlineBtn}
              onClick={loadTreeData}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
          )}
        </div>
      </div>

      {!selectedAgencyId && (
        <div className="flex min-h-[500px] flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/20 p-16 text-center dark:border-slate-800 dark:bg-slate-900/40">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-xl border border-border bg-muted dark:border-slate-700 dark:bg-slate-800">
            <Building2 className="h-8 w-8 text-muted-foreground" />
          </div>
          <p className="text-lg font-medium text-foreground">Select an agency</p>
          <p className="mt-2 max-w-sm text-sm text-muted-foreground">Choose an agency to see the organization hierarchy: Agency → Agents → Carriers.</p>
        </div>
      )}

      {selectedAgencyId && loading && (
        <div className="flex min-h-[500px] flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/20 p-12 dark:border-slate-800 dark:bg-slate-900/40">
          <Loader2 className="mb-4 h-12 w-12 animate-spin text-orange-500 dark:text-orange-400" />
          <p className="text-muted-foreground">Loading organization chart...</p>
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length > 0 && (
        <div className="min-h-[600px] overflow-hidden rounded-xl border-2 border-border bg-muted/10 dark:border-slate-800 dark:bg-slate-900/40" style={{ minHeight: '700px', width: '100%' }}>
          <div ref={containerRef} className="h-full min-h-[600px] w-full [&>svg]:mx-auto [&>svg]:block [&>svg]:h-auto [&>svg]:max-w-full" style={{ overflow: 'auto' }} />
        </div>
      )}

      {selectedAgencyId && !loading && chartData.length === 0 && (
        <div className="flex min-h-[500px] flex-col items-center justify-center rounded-xl border-2 border-border bg-muted/20 p-12 text-center dark:border-slate-800 dark:bg-slate-900/40">
          <Users className="mb-4 h-12 w-12 text-muted-foreground" />
          <p className="text-lg font-medium text-foreground">No agents found</p>
          <p className="mt-2 text-sm text-muted-foreground">Add agents to this agency to see the organization chart.</p>
        </div>
      )}
    </div>
  )
}
