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
    <Card className="w-full max-w-sm shadow-xl">
      <CardHeader className="space-y-3 pb-2 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-muted dark:border-slate-700 dark:bg-slate-800">
          <Shield className="h-7 w-7 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-foreground">Unlimited Insurance Admin</h1>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to continue</p>
        </div>
      </CardHeader>
      <CardContent className="px-6 pb-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="admin@unlimitedinsurance.io"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
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
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="space-y-3 pb-2 text-center">
          <div className="mx-auto h-12 w-12 animate-pulse rounded-xl border border-border bg-muted dark:bg-slate-800" />
          <div className="mx-auto h-6 w-3/4 animate-pulse rounded bg-muted dark:bg-slate-800" />
          <div className="mx-auto h-4 w-1/2 animate-pulse rounded bg-muted dark:bg-slate-800" />
        </CardHeader>
        <CardContent className="space-y-4 px-6 pb-6">
          <div className="h-10 animate-pulse rounded bg-muted dark:bg-slate-800" />
          <div className="h-10 animate-pulse rounded bg-muted dark:bg-slate-800" />
          <div className="h-10 animate-pulse rounded bg-muted dark:bg-slate-800" />
        </CardContent>
      </Card>
    }>
      <LoginForm />
    </Suspense>
  )
}
