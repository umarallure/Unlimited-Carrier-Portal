'use client'

import { OrganizationChart } from '@/components/OrganizationChart'

export default function OrgChartPage() {
  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-50 mb-2">Organization Chart</h1>
        <p className="text-slate-400">Visual hierarchy: Agency → Agents → Carriers. Assign carriers to agents in the Agents page.</p>
      </div>
      <OrganizationChart />
    </div>
  )
}
