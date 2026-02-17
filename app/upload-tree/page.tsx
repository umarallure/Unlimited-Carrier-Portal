'use client'

import { UploadTreeOrgChart } from '@/components/UploadTreeOrgChart'
import { Upload } from 'lucide-react'

export default function UploadTreePage() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center space-x-4">
        <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
          <Upload className="w-6 h-6 text-orange-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white">Upload Tree</h1>
          <p className="text-gray-400">Upload files from the org chart: select agency, then click Policy (P) or Commission (C) to upload</p>
        </div>
      </div>

      <UploadTreeOrgChart />
    </div>
  )
}
