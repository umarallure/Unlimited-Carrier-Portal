'use client'

import { UploadTreeFlow } from '@/components/UploadTreeFlow'
import { Network } from 'lucide-react'

export default function UploadTreePage() {
  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div className="flex items-center space-x-4">
        <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
          <Network className="w-6 h-6 text-orange-400" />
        </div>
        <div>
          <h1 className="text-3xl font-bold text-white">Upload Tree</h1>
          <p className="text-gray-400">Upload files directly from the organization tree</p>
        </div>
      </div>

      <UploadTreeFlow />
    </div>
  )
}
