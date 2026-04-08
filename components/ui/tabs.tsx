import * as React from "react"
import { cn } from "@/lib/utils"

type TabsContextValue = {
  value: string
  setValue: (value: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)

type TabsProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
} & React.HTMLAttributes<HTMLDivElement>

const Tabs: React.FC<TabsProps> = ({
  value: controlledValue,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}) => {
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue ?? "")
  const isControlled = controlledValue !== undefined
  const value = isControlled ? controlledValue! : uncontrolled

  const setValue = (next: string) => {
    if (!isControlled) setUncontrolled(next)
    onValueChange?.(next)
  }

  return (
    <TabsContext.Provider value={{ value, setValue }}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

const TabsList = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-muted p-1 text-muted-foreground dark:bg-slate-900 dark:text-slate-400",
        className
      )}
      {...props}
    />
  )
)
TabsList.displayName = "TabsList"

type TabsTriggerProps = {
  value: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>

const TabsTrigger = React.forwardRef<HTMLButtonElement, TabsTriggerProps>(
  ({ className, value, children, ...props }, ref) => {
    const ctx = React.useContext(TabsContext)
    if (!ctx) throw new Error("TabsTrigger must be used within Tabs")
    const isActive = ctx.value === value

    return (
      <button
        ref={ref}
        type="button"
        data-state={isActive ? "active" : "inactive"}
        className={cn(
          "inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium",
          "ring-offset-background transition-all dark:ring-offset-slate-900",
          isActive
            ? "bg-background text-foreground shadow-sm dark:bg-slate-800 dark:text-white"
            : "text-muted-foreground hover:text-foreground dark:text-slate-400 dark:hover:text-slate-200",
          className
        )}
        onClick={() => ctx.setValue(value)}
        {...props}
      >
        {children}
      </button>
    )
  }
)
TabsTrigger.displayName = "TabsTrigger"

type TabsContentProps = {
  value: string
} & React.HTMLAttributes<HTMLDivElement>

const TabsContent = React.forwardRef<HTMLDivElement, TabsContentProps>(
  ({ className, value, children, ...props }, ref) => {
    const ctx = React.useContext(TabsContext)
    if (!ctx) throw new Error("TabsContent must be used within Tabs")
    const isActive = ctx.value === value

    if (!isActive) return null

    return (
      <div
        ref={ref}
        className={cn(
          "mt-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:focus-visible:ring-offset-slate-900",
          className
        )}
        {...props}
      >
        {children}
      </div>
    )
  }
)
TabsContent.displayName = "TabsContent"

export { Tabs, TabsList, TabsTrigger, TabsContent }


