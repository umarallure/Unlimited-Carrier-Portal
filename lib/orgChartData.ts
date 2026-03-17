/**
 * Build flat org-chart data for d3-org-chart from agencies, agency_carriers (carriers), and agents.
 * Hierarchy: Root (org) → Agencies → Carriers & Agents (siblings under each agency).
 */
export type OrgChartNode = {
  id: string
  parentId: string
  name: string
  type: 'Organization' | 'Agency' | 'Carrier' | 'Agent'
  email?: string
  code?: string
  [key: string]: unknown
}

export function buildOrgChartData(
  rootName: string,
  agencies: { id: string; name: string }[],
  agencyCarriers: { id: string; agency_id: string; carriers: { id: string; name: string; code: string } | null }[],
  agents: { id: string; agency_id: string; name: string; email?: string }[]
): OrgChartNode[] {
  const nodes: OrgChartNode[] = []
  const rootId = 'root'
  nodes.push({
    id: rootId,
    parentId: '',
    name: rootName,
    type: 'Organization',
  })

  for (const agency of agencies) {
    nodes.push({
      id: agency.id,
      parentId: rootId,
      name: agency.name || 'Unnamed Agency',
      type: 'Agency',
    })

    const carriers = agencyCarriers.filter(ac => ac.agency_id === agency.id)
    for (const ac of carriers) {
      const carrier = ac.carriers
      if (!carrier) continue
      nodes.push({
        id: ac.id,
        parentId: agency.id,
        name: carrier.name || 'Unnamed Carrier',
        type: 'Carrier',
        code: carrier.code,
      })
    }

    const agencyAgents = agents.filter(a => a.agency_id === agency.id)
    for (const agent of agencyAgents) {
      nodes.push({
        id: agent.id,
        parentId: agency.id,
        name: agent.name || 'Unnamed Agent',
        type: 'Agent',
        email: agent.email,
      })
    }
  }

  return nodes
}
