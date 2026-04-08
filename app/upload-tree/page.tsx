'use client'

import { UploadTreeOrgChart } from '@/components/UploadTreeOrgChart'
import { Upload } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'

export default function UploadTreePage() {
  return (
    <div className="admin-page animate-in space-y-6 fade-in duration-500">
      <PageHeader
        title="Upload Tree"
        description="Upload files from the org chart: select agency, then click Policy (P) or Commission (C) to upload."
        icon={<Upload className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
      />

      <UploadTreeOrgChart />
    </div>
  )
}
