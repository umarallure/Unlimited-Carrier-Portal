'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Shield, Ban, CheckCircle, KeyRound, Search, Loader2, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import {
  adminInput,
  adminOutlineBtn,
  adminPaginationBar,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'

type AuthUser = {
  id: string
  email: string
  created_at: string
  banned_until: string | null
  role: string
  app_metadata: Record<string, any>
  user_metadata: Record<string, any>
}

export default function UsersPage() {
  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [passwordDialogUser, setPasswordDialogUser] = useState<AuthUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [savingPassword, setSavingPassword] = useState(false)
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    fetchUsers()
  }, [])

  const fetchUsers = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/users')
      if (!res.ok) throw new Error('Failed to fetch users')
      const data = await res.json()
      setUsers(data)
    } catch (err) {
      console.error('Error fetching users:', err)
      setUsers([])
    } finally {
      setLoading(false)
    }
  }

  const toggleBan = async (user: AuthUser) => {
    setBusyIds((prev) => new Set(prev).add(user.id))
    try {
      const isBanned = !!user.banned_until
      await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, action: isBanned ? 'unban' : 'ban' }),
      })
      await fetchUsers()
    } catch (err) {
      console.error('Error toggling ban:', err)
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(user.id); return next })
    }
  }

  const changeRole = async (userId: string, role: string) => {
    setBusyIds((prev) => new Set(prev).add(userId))
    try {
      await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, action: 'set-role', value: role }),
      })
      await fetchUsers()
    } catch (err) {
      console.error('Error changing role:', err)
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(userId); return next })
    }
  }

  const handleSavePassword = async () => {
    if (!passwordDialogUser || !newPassword.trim()) return
    if (newPassword.length < 6) return
    setSavingPassword(true)
    try {
      await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: passwordDialogUser.id, action: 'set-password', value: newPassword }),
      })
      setPasswordDialogUser(null)
      setNewPassword('')
    } catch (err) {
      console.error('Error changing password:', err)
    } finally {
      setSavingPassword(false)
    }
  }

  const filtered = users.filter((u) => {
    if (!searchTerm.trim()) return true
    const q = searchTerm.toLowerCase()
    return (
      u.email?.toLowerCase().includes(q) ||
      u.id?.toLowerCase().includes(q)
    )
  })

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const startIndex = (currentPage - 1) * pageSize
  const paginated = filtered.slice(startIndex, startIndex + pageSize)

  useEffect(() => {
    setCurrentPage(1)
  }, [searchTerm, pageSize])

  const formatDate = (iso: string) => {
    if (!iso) return '-'
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  }

  const getUserRole = (user: AuthUser): string => {
    return user.app_metadata?.role || 'user'
  }

  return (
    <div className="admin-page animate-in space-y-6 fade-in duration-500">
      <PageHeader
        title="User Management"
        description="Manage Supabase Auth users — ban/unban, change roles, reset passwords."
        icon={<Shield className="h-7 w-7 text-orange-500" />}
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1 max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 transform text-muted-foreground" />
          <Input
            placeholder="Search by email or ID…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className={cn(adminInput, 'pl-8')}
          />
        </div>
        <Button variant="outline" size="sm" onClick={fetchUsers} className={adminOutlineBtn}>
          <Loader2 className={cn('mr-1 h-4 w-4', loading && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-b border-border hover:bg-transparent odd:bg-transparent even:bg-transparent dark:border-slate-800">
                  <TableHead className={adminThPlain}>Email</TableHead>
                  <TableHead className={adminThPlain}>Created</TableHead>
                  <TableHead className={adminThPlain}>Status</TableHead>
                  <TableHead className={adminThPlain}>Role</TableHead>
                  <TableHead className={cn(adminThPlain, 'text-right')}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center">
                      <Loader2 className="mx-auto h-8 w-8 animate-spin text-orange-400" />
                    </TableCell>
                  </TableRow>
                ) : paginated.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-12 text-center text-muted-foreground">
                      {searchTerm ? 'No users match your search.' : 'No users found.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  paginated.map((user) => {
                    const isBanned = !!user.banned_until
                    const role = getUserRole(user)
                    const isBusy = busyIds.has(user.id)

                    return (
                      <TableRow key={user.id} className={adminTableRowInteractive}>
                        <TableCell className={adminTdStrong}>
                          <div className="flex flex-col">
                            <span>{user.email}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">{user.id.slice(0, 8)}…</span>
                          </div>
                        </TableCell>
                        <TableCell className={adminTdMuted}>{formatDate(user.created_at)}</TableCell>
                        <TableCell>
                          {isBanned ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-950/30 dark:text-red-400">
                              <Ban className="h-3 w-3" />
                              Banned
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400">
                              <CheckCircle className="h-3 w-3" />
                              Active
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Select
                            value={role}
                            onValueChange={(v) => changeRole(user.id, v)}
                            disabled={isBusy}
                          >
                            <SelectTrigger className={cn(adminSelectTrigger, 'h-8 w-[130px] text-xs')}>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent className={adminSelectContent}>
                              <SelectItem value="admin" className={adminSelectItem}>Admin</SelectItem>
                              <SelectItem value="user" className={adminSelectItem}>User</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => toggleBan(user)}
                              disabled={isBusy}
                              className={cn(
                                adminOutlineBtn,
                                'h-8 px-2 text-xs',
                                isBanned
                                  ? 'text-emerald-600 hover:text-emerald-500 dark:text-emerald-400'
                                  : 'text-red-600 hover:text-red-500 dark:text-red-400',
                              )}
                            >
                              {isBusy ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : isBanned ? (
                                <CheckCircle className="h-3.5 w-3.5" />
                              ) : (
                                <Ban className="h-3.5 w-3.5" />
                              )}
                              <span className="ml-1">{isBanned ? 'Unban' : 'Ban'}</span>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => { setPasswordDialogUser(user); setNewPassword('') }}
                              className={cn(adminOutlineBtn, 'h-8 px-2 text-xs')}
                            >
                              <KeyRound className="h-3.5 w-3.5" />
                              <span className="ml-1">Password</span>
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {filtered.length > 0 && (
            <div className={cn(adminPaginationBar, 'flex flex-wrap items-center justify-between gap-4 border-t px-4 py-3')}>
              <div className="text-sm text-muted-foreground">
                {filtered.length === 0 ? 0 : startIndex + 1}–{Math.min(startIndex + pageSize, filtered.length)} of {filtered.length}
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>Per page:</span>
                  <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                    <SelectTrigger className={cn(adminSelectTrigger, 'h-8 w-24 text-xs')}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className={adminSelectContent}>
                      <SelectItem value="10" className={adminSelectItem}>10</SelectItem>
                      <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
                      <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</span>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>First</Button>
                    <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>Prev</Button>
                    <Button variant="outline" size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>Next</Button>
                    <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>Last</Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!passwordDialogUser} onOpenChange={(open) => { if (!open) setPasswordDialogUser(null) }}>
        <DialogContent className="sm:max-w-[400px]">
          <DialogHeader>
            <DialogTitle>Change Password</DialogTitle>
            <DialogDescription>
              Set a new password for <strong>{passwordDialogUser?.email}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 pt-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-foreground">New Password</label>
              <Input
                type="password"
                placeholder="Min 6 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={adminInput}
              />
              {newPassword.length > 0 && newPassword.length < 6 && (
                <p className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  Password must be at least 6 characters
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPasswordDialogUser(null)} className={adminOutlineBtn}>Cancel</Button>
              <Button
                onClick={handleSavePassword}
                disabled={savingPassword || newPassword.length < 6}
                className="bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingPassword ? 'Saving...' : 'Save Password'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
