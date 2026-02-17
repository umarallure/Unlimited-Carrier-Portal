'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function OrgChartRedirect() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/upload-tree')
  }, [router])
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <p className="text-slate-400">Redirecting to Upload Tree...</p>
    </div>
  )
}
