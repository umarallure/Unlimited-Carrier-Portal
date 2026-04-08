import { cn } from '@/lib/utils'

type PageHeaderProps = {
  title: string
  description?: React.ReactNode
  icon?: React.ReactNode
  action?: React.ReactNode
  className?: string
}

/** Consistent page title block for admin screens. */
export function PageHeader({ title, description, icon, action, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-6 pb-2 sm:flex-row sm:items-start sm:justify-between',
        className
      )}
    >
      <div className="flex min-w-0 gap-4">
        {icon ? (
          <div
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-border bg-gradient-to-br from-slate-100 to-slate-200/90 shadow-md dark:border-white/[0.06] dark:from-slate-800/90 dark:to-slate-900 dark:shadow-black/30"
            aria-hidden
          >
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 space-y-1.5">
          <h1 className="font-display text-2xl font-bold tracking-tight text-foreground sm:text-3xl">
            {title}
          </h1>
          {description ? (
            <div className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</div>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}
