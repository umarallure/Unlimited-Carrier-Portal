'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import {
    Home,
    Briefcase,
    FileText,
    Upload,
    Users,
    Shield,
    LogOut,
    TrendingUp,
    History,
    LayoutGrid,
    FileSearch,
    ChevronLeft,
    ChevronRight,
    Sun,
    Moon,
    ClipboardCheck,
    AlertTriangle,
    type LucideIcon,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTheme } from '@/components/ThemeProvider'
import type { User, AuthChangeEvent, Session } from '@supabase/supabase-js'

function NavRow({
  href,
  label,
  icon: Icon,
  active,
  collapsed,
}: {
  href: string
  label: string
  icon: LucideIcon
  active: boolean
  collapsed: boolean
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      className={cn(
        'group flex items-center gap-3 rounded-xl py-2.5 transition-all duration-200',
        collapsed ? 'justify-center px-2' : 'px-3',
        active
          ? 'border border-orange-500/25 bg-gradient-to-r from-orange-500/12 via-orange-500/5 to-transparent text-foreground shadow-[inset_0_1px_0_0_rgba(0,0,0,0.04)] dark:text-white dark:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)]'
          : 'border border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground dark:text-slate-300 dark:hover:border-slate-700/80 dark:hover:bg-slate-900/80 dark:hover:text-white'
      )}
    >
      <div
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors',
            active
              ? 'bg-orange-500/20 text-orange-700 dark:bg-orange-500/15 dark:text-orange-200'
              : 'bg-slate-200 text-slate-700 group-hover:bg-slate-300 dark:bg-slate-900 dark:text-slate-200 dark:group-hover:bg-slate-800'
        )}
      >
        <Icon size={18} strokeWidth={active ? 2.25 : 2} />
      </div>
      {!collapsed && (
        <span className={cn('min-w-0 truncate text-sm font-medium', active && 'text-foreground dark:text-white')}>
          {label}
        </span>
      )}
    </Link>
  )
}

type SidebarProps = {
  collapsed: boolean
  onToggleCollapsed: () => void
}

const Sidebar = ({ collapsed, onToggleCollapsed }: SidebarProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const { theme, toggleTheme } = useTheme()
  const [user, setUser] = useState<User | null>(null)
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getUser().then((res: { data: { user: User | null } }) => setUser(res.data.user ?? null))
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => setUser(session?.user ?? null))
    return () => subscription.unsubscribe()
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  const navActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)

  return (
    <aside
      className={cn(
        'flex h-screen shrink-0 flex-col border-r border-slate-200 bg-slate-50 text-slate-900 shadow-sm transition-[width] duration-200 ease-out dark:border-slate-800/90 dark:bg-[rgb(10,16,28)] dark:text-white dark:shadow-[4px_0_24px_rgba(0,0,0,0.35)]',
        collapsed ? 'w-[4.5rem]' : 'w-[17.5rem]'
      )}
    >
      <div className={cn('border-b border-slate-200 dark:border-slate-800/90', collapsed ? 'p-3' : 'p-5')}>
        <div className={cn('flex items-center gap-2', collapsed ? 'flex-col' : 'justify-between gap-3')}>
          <div className={cn('flex min-w-0 items-center gap-3', collapsed && 'justify-center')}>
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200/90 shadow-md dark:border-white/[0.06] dark:from-slate-800 dark:to-slate-900 dark:shadow-lg">
              <Shield className="h-5 w-5 text-orange-500 dark:text-orange-400" />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <h1 className="font-display truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
                  Admin
                </h1>
                <p className="truncate text-xs text-slate-500 dark:text-slate-500">Unlimited Insurance</p>
              </div>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onToggleCollapsed}
            className={cn(
              'h-8 w-8 shrink-0 text-slate-500 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white',
              collapsed && 'mt-2'
            )}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden p-2">
        <NavRow href="/" label="Dashboard" icon={Home} active={navActive('/')} collapsed={collapsed} />
        <NavRow href="/agencies" label="Agencies" icon={Briefcase} active={navActive('/agencies')} collapsed={collapsed} />
        <NavRow href="/carriers" label="Carriers" icon={FileText} active={navActive('/carriers')} collapsed={collapsed} />
        <NavRow href="/agents" label="Agents" icon={Users} active={navActive('/agents')} collapsed={collapsed} />
        <NavRow href="/records" label="Records" icon={FileText} active={navActive('/records')} collapsed={collapsed} />
        <NavRow href="/deal-tracker" label="Deal Tracker" icon={TrendingUp} active={navActive('/deal-tracker')} collapsed={collapsed} />
        <NavRow
          href="/review-policies"
          label="Review Policies"
          icon={ClipboardCheck}
          active={navActive('/review-policies')}
          collapsed={collapsed}
        />
        <NavRow
          href="/policy-audit"
          label="Policy Audit"
          icon={AlertTriangle}
          active={navActive('/policy-audit')}
          collapsed={collapsed}
        />
        <NavRow
          href="/deal-tracker-compare"
          label="Deal Tracker Compare"
          icon={FileText}
          active={navActive('/deal-tracker-compare')}
          collapsed={collapsed}
        />
        <NavRow href="/ghl-stages" label="GHL Stages" icon={LayoutGrid} active={navActive('/ghl-stages')} collapsed={collapsed} />
        <NavRow
          href="/commission-report"
          label="Commission Report"
          icon={FileText}
          active={navActive('/commission-report')}
          collapsed={collapsed}
        />
        <NavRow
          href="/invoicing"
          label="Invoicing"
          icon={FileText}
          active={navActive('/invoicing')}
          collapsed={collapsed}
        />
        <NavRow
          href="/invoicing-audit"
          label="Invoicing Audit"
          icon={FileSearch}
          active={navActive('/invoicing-audit')}
          collapsed={collapsed}
        />
        <NavRow href="/upload-tree" label="Org tree upload" icon={Upload} active={navActive('/upload-tree')} collapsed={collapsed} />
        <NavRow href="/upload-history" label="Upload History" icon={History} active={navActive('/upload-history')} collapsed={collapsed} />
        <NavRow href="/org-chart" label="Organization Chart" icon={Users} active={navActive('/org-chart')} collapsed={collapsed} />
      </nav>

      <div className={cn('space-y-2 border-t border-slate-200 dark:border-slate-800/90', collapsed ? 'p-2' : 'p-4')}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
          className={cn(
            'text-slate-600 hover:bg-slate-200 hover:text-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-slate-100',
            collapsed ? 'h-9 w-full justify-center px-0' : 'w-full justify-start'
          )}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className={cn('h-4 w-4', !collapsed && 'mr-2')} /> : <Moon className={cn('h-4 w-4', !collapsed && 'mr-2')} />}
          {!collapsed && (theme === 'dark' ? 'Light mode' : 'Dark mode')}
        </Button>
        {user?.email && !collapsed && (
          <p className="truncate px-1 text-xs text-slate-500 dark:text-slate-400" title={user.email}>
            {user.email}
          </p>
        )}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100',
            collapsed ? 'h-9 w-full justify-center px-0' : 'w-full justify-start'
          )}
          onClick={handleSignOut}
          title="Sign out"
        >
          <LogOut className={cn('h-4 w-4', !collapsed && 'mr-2')} />
          {!collapsed && 'Sign out'}
        </Button>
        {!collapsed && (
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Unlimited Insurance Admin</p>
            <p className="mt-1 text-sm font-medium text-slate-800 dark:text-slate-200">v2.0</p>
          </div>
        )}
      </div>
    </aside>
  )
}

export default Sidebar
