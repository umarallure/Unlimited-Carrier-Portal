/**
 * Tailwind classes for filter forms that respond to `html.light` / `html.dark`.
 */
export const adminInput =
  'h-9 border-input bg-background text-foreground placeholder:text-muted-foreground sm:h-10 dark:border-slate-800 dark:bg-slate-950 dark:text-white dark:placeholder:text-slate-500'

export const adminInputSm = adminInput + ' text-sm'

export const adminDateInput =
  'h-9 w-[150px] border-input bg-background text-foreground text-sm [color-scheme:light] dark:border-slate-800 dark:bg-slate-950 dark:text-white dark:[color-scheme:dark]'

export const adminSelectTrigger =
  'border-input bg-background text-foreground dark:border-slate-800 dark:bg-slate-950 dark:text-white'

export const adminSelectItem = 'text-foreground dark:text-white dark:focus:bg-slate-700'

export const adminSelectContent =
  'max-h-72 border-border bg-popover text-popover-foreground dark:border-slate-700 dark:bg-slate-800'

export const adminCardHeaderBar = 'border-b border-border dark:border-slate-800/80'

export const adminMutedRow = 'text-muted-foreground dark:text-slate-400'

export const adminPaginationBar =
  'border-border bg-muted/40 backdrop-blur-sm dark:border-slate-800/80 dark:bg-slate-950/30'

export const adminOutlineBtn =
  'border-border bg-background text-foreground hover:bg-muted dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800'

export const adminCardTitle =
  'font-display text-base font-semibold text-foreground dark:text-white'

/** Date picker row (clickable div wrapping native date input) */
export const adminDatePickerRow =
  'flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/50 dark:border-slate-800 dark:bg-slate-950 dark:text-white dark:hover:border-slate-600 dark:hover:bg-slate-900'

export const adminDatePickerInput =
  'min-w-0 flex-1 cursor-pointer border-none bg-transparent text-sm text-foreground outline-none dark:text-white [color-scheme:light] dark:[color-scheme:dark]'

export const adminFilterWell =
  'space-y-3 rounded-lg border border-border bg-muted/25 p-3 dark:border-slate-800 dark:bg-slate-950/40'

export const adminDataGroupBar =
  'border-b border-border bg-muted/50 px-4 py-2 text-sm font-medium text-foreground dark:border-slate-800 dark:bg-slate-800/40 dark:text-slate-200'

export const adminNestedTableShell =
  'overflow-x-auto rounded-md border border-border bg-muted/30 dark:border-slate-800 dark:bg-slate-950/80'

export const adminExpandRowBg =
  'border-b border-border bg-muted/30 dark:border-slate-900 dark:bg-slate-950/60'

export const adminTableRowInteractive =
  'border-b border-border transition-colors hover:bg-muted/60 dark:border-slate-800 dark:hover:bg-slate-800/40 dark:hover:bg-slate-800/50'

export const adminPaginationShell =
  'flex flex-col gap-4 rounded-2xl border border-border bg-card/80 px-4 py-4 shadow-sm backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between dark:border-slate-800/80 dark:bg-slate-900/45 dark:shadow-lg dark:shadow-black/30'

export const adminTypeTabsWrap =
  'flex w-fit gap-1 rounded-2xl border border-border bg-muted/40 p-1 ring-1 ring-black/[0.03] dark:border-slate-800/80 dark:bg-slate-900/50 dark:ring-white/[0.03]'

export const adminTypeTabActive =
  'border border-orange-500/35 bg-gradient-to-b from-orange-500/20 to-orange-600/10 text-foreground shadow-sm dark:from-orange-500/25 dark:to-orange-600/10 dark:text-white'

export const adminTypeTabIdle =
  'border border-transparent text-muted-foreground hover:bg-muted/80 hover:text-foreground dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-200'

/** Commission / dense tables — header cells that override uppercase TableHead */
export const adminThPlain =
  'normal-case tracking-normal text-foreground dark:text-slate-200'

export const adminTdMuted = 'text-muted-foreground dark:text-slate-300'

export const adminTdStrong = 'text-foreground dark:text-slate-100'
