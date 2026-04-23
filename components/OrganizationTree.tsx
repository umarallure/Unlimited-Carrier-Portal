'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Tree, TreeNode } from './Tree'
import { Building2, FileText, Users, Loader2, RefreshCw } from 'lucide-react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'

export function OrganizationTree() {
  const [treeNodes, setTreeNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set())

  useEffect(() => {
    loadTreeData()
  }, [])

  const loadTreeData = async () => {
    setLoading(true)
    try {
      // First, fetch agencies to ensure they load even if nested queries fail
      const { data: agencies, error: agenciesError } = await supabase
        .from('agencies')
        .select('id, name')
        .order('name')

      if (agenciesError) {
        console.error('Error fetching agencies:', agenciesError)
        throw agenciesError
      }

      if (!agencies || agencies.length === 0) {
        console.log('No agencies found in database')
        setTreeNodes([])
        setLoading(false)
        return
      }

      console.log(`Found ${agencies.length} agencies`)
      const agencyRows = (agencies || []) as Array<{ id: string; name: string }>

      // Now fetch nested data for each agency
      const nodes: TreeNode[] = await Promise.all(
        agencyRows.map(async (agency) => {
          // Fetch carriers for this agency
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

          // Fetch agents for this agency
          const { data: agents } = await supabase
            .from('agents')
            .select('id, name, email')
            .eq('agency_id', agency.id)

          const agencyId = `agency-${agency.id}`
          
          const agentNodes: TreeNode[] = (agents || []).map((agent: any) => ({
            id: `agent-${agent.id}`,
            label: agent.name || 'Unknown Agent',
            icon: <Users className="w-4 h-4" />,
            badge: agent.email ? undefined : 'No email',
            onClick: () => {
              window.location.href = `/agents`
            },
            data: { type: 'agent', ...agent },
          }))

          const carrierNodes: TreeNode[] = (agencyCarriers || [])
            .map((ac: any) => {
              const carrier = ac.carriers
              if (!carrier) return null

              return {
                id: `carrier-${ac.id}`,
                label: carrier.name || 'Unknown Carrier',
                icon: <FileText className="w-4 h-4" />,
                onClick: () => {
                  window.location.href = `/carriers/${carrier.id}`
                },
                data: { type: 'carrier', ...carrier },
              } as TreeNode
            })
            .filter(Boolean) as TreeNode[]

          // Combine carriers and agents as children
          const children: TreeNode[] = []
          if (carrierNodes.length > 0) children.push(...carrierNodes)
          if (agentNodes.length > 0) children.push(...agentNodes)

          return {
            id: agencyId,
            label: agency.name,
            icon: <Building2 className="w-4 h-4" />,
            badge: (agents || []).length > 0 ? (agents || []).length : undefined,
            children: children.length > 0 ? children : undefined,
            onClick: () => {
              window.location.href = `/agencies`
            },
            data: { type: 'agency', ...agency },
          } as TreeNode
        })
      )

      console.log(`Built ${nodes.length} tree nodes`)
      setTreeNodes(nodes)
      // Auto-expand first agency
      if (nodes.length > 0) {
        setExpandedNodes(new Set([nodes[0].id]))
      }
    } catch (error) {
      console.error('Error loading tree data:', error)
    } finally {
      setLoading(false)
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
            <p className="text-sm text-slate-400">Create an agency to start building your organization tree.</p>
          </div>
          <Link
            href="/agencies"
            className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Building2 className="w-4 h-4" />
            Create Agency
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-50">Organization Tree</h2>
          <p className="text-sm text-slate-400">Browse agencies, carriers, and agents</p>
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
      <Tree nodes={treeNodes} defaultExpanded={Array.from(expandedNodes)} />
    </div>
  )
}
