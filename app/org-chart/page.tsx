'use client'

import { OrganizationChart } from '@/components/OrganizationChart'
import { PageHeader } from '@/components/PageHeader'
import { Network } from 'lucide-react'

export default function OrgChartPage() {
  return (
    <div className="admin-page space-y-6 p-6">
      <PageHeader
        title="Organization Chart"
        description="Visual hierarchy: Agency → Agents → Carriers. Assign carriers to agents on the Agents page."
        icon={<Network className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
      />
      <OrganizationChart />
    </div>
  )
}
