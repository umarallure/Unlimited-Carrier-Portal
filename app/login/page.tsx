'use client'

import { Suspense, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Shield } from 'lucide-react'

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const next = searchParams.get('next') || '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const supabase = createClient()
      const { error: err } = await supabase.auth.signInWithPassword({ email, password })
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      router.push(next)
      router.refresh()
    } catch {
      setError('Something went wrong')
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-sm border-slate-700 bg-slate-900/95 shadow-xl">
      <CardHeader className="space-y-3 text-center pb-2">
        <div className="mx-auto w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center border border-slate-700">
          <Shield className="w-7 h-7 text-blue-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-slate-50">Unlimited Insurance Admin</h1>
          <p className="text-sm text-slate-400 mt-1">Sign in to continue</p>
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email" className="text-slate-300">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@unlimitedinsurance.io"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="bg-slate-950 border-slate-700 text-slate-100"
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password" className="text-slate-300">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-slate-950 border-slate-700 text-slate-100"
              autoComplete="current-password"
            />
          </div>
          {error && (
            <p className="text-sm text-red-400">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={loading}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <Card className="w-full max-w-sm border-slate-700 bg-slate-900/95 shadow-xl">
        <CardHeader className="space-y-3 text-center pb-2">
          <div className="mx-auto w-12 h-12 rounded-xl bg-slate-800 flex items-center justify-center border border-slate-700 animate-pulse" />
          <div className="h-6 bg-slate-800 rounded w-3/4 mx-auto animate-pulse" />
          <div className="h-4 bg-slate-800 rounded w-1/2 mx-auto animate-pulse" />
        </CardHeader>
        <CardContent className="px-6 pb-6 space-y-4">
          <div className="h-10 bg-slate-800 rounded animate-pulse" />
          <div className="h-10 bg-slate-800 rounded animate-pulse" />
          <div className="h-10 bg-slate-800 rounded animate-pulse" />
        </CardContent>
      </Card>
    }>
      <LoginForm />
    </Suspense>
  )
}
