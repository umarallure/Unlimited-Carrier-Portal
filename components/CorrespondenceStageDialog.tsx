'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  ArrowRight,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { adminOutlineBtn, adminSelectContent, adminSelectItem, adminSelectTrigger } from '@/lib/adminFieldClasses'
import { formatStoredDateForDisplay } from '@/lib/calendarDate'
import { GHL_STAGE_CATEGORIES, getStageColor } from '@/lib/ghlStageResolver'
import type { AmamCorrespondenceRow, LinkedDealTracker } from '@/lib/amamCorrespondence'

export type StageChangeResult = {
  ok: true
  dealId: string
  policyNumber: string
  previousStage: string | null
  newStage: string
  reviewNote: { saved: boolean; id: string | null; error: string | null }
  crm: {
    leadFound: boolean
    leadId: string | null
    matchedBy: 'policy_id' | 'tracking_id' | null
    previousStage: string | null
    stageUpdated: boolean
    stageId: number | null
    pipelineChanged: boolean
    noteSaved: boolean
    message: string | null
  }
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  row: AmamCorrespondenceRow | null
  deal: LinkedDealTracker | null
  onSaved: (result: StageChangeResult) => void
  /** 1-based position of `row` in the action queue. */
  position?: number
  /** Size of the action queue — every filtered row that has a Deal Tracker match. */
  total?: number
  /** Step through the queue by `delta` without closing the dialog. */
  onNavigate?: (delta: number) => void
}

/** Prefill the note with the memo that justifies the move, so CRM gets the why. */
function buildDefaultNote(row: AmamCorrespondenceRow): string {
  const date = row.correspondence_date ? formatStoredDateForDisplay(row.correspondence_date) : 'undated'
  const head = [row.description, row.form_code ? `(${row.form_code})` : ''].filter(Boolean).join(' ')
  const parts = [`AMAM correspondence ${date} — ${head || 'memo'}`]
  if (row.action_item) parts.push(row.action_item)
  return parts.join(': ')
}

function ResultLine({ ok, label, detail }: { ok: boolean | 'warn'; label: string; detail?: string | null }) {
  const Icon = ok === true ? CheckCircle2 : ok === 'warn' ? AlertTriangle : XCircle
  const tone =
    ok === true
      ? 'text-emerald-600 dark:text-emerald-400'
      : ok === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400'
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} />
      <div className="min-w-0">
        <p className="text-foreground dark:text-slate-100">{label}</p>
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  )
}

export function CorrespondenceStageDialog({
  open,
  onOpenChange,
  row,
  deal,
  onSaved,
  position,
  total,
  onNavigate,
}: Props) {
  const [nextStage, setNextStage] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StageChangeResult | null>(null)

  // Reset when the dialog opens and each time navigation lands on a different
  // row. Keyed on the id, not the object, so an unrelated re-render cannot wipe
  // a note the user is part-way through typing.
  useEffect(() => {
    if (!open || !row) return
    setNextStage('')
    setNote(buildDefaultNote(row))
    setError(null)
    setResult(null)
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.id])

  const currentStage = deal?.ghl_stage ?? null

  const canNavigate = onNavigate != null && position != null && total != null && total > 1
  const canPrev = canNavigate && position! > 1
  const canNext = canNavigate && position! < total!

  const navigate = (delta: number) => {
    if (saving) return
    onNavigate?.(delta)
  }

  const stageGroups = useMemo(
    () =>
      GHL_STAGE_CATEGORIES.map((cat) => ({
        ...cat,
        stages: cat.stages.filter((s) => s !== currentStage),
      })).filter((cat) => cat.stages.length > 0),
    [currentStage]
  )

  const handleSave = async () => {
    if (!row || !deal || !nextStage) return
    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/amam-correspondence/update-stage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId: deal.id,
          policyNumber: row.policy_number,
          newStage: nextStage,
          note: note.trim(),
          correspondenceId: row.id,
        }),
      })

      const payload = (await res.json().catch(() => null)) as (StageChangeResult & { error?: string }) | null

      if (!res.ok || !payload?.ok) {
        setError(payload?.error || `Stage update failed (${res.status}).`)
        return
      }

      setResult(payload)
      onSaved(payload)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Stage update failed.')
    } finally {
      setSaving(false)
    }
  }

  if (!row) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Change GHL Stage</DialogTitle>
          <DialogDescription>
            Updates the Deal Tracker, then syncs the stage and this note to the CRM lead.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Correspondence context */}
          <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm dark:border-slate-800 dark:bg-slate-950/40">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-foreground dark:text-slate-100">{row.policy_number}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-foreground dark:text-slate-100">{row.policyholder || '—'}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {row.correspondence_date ? formatStoredDateForDisplay(row.correspondence_date) : 'undated'}
              </span>
            </div>
            <p className="text-foreground dark:text-slate-100">
              {row.description || '—'}
              {row.form_code ? <span className="ml-2 font-mono text-xs text-muted-foreground">{row.form_code}</span> : null}
            </p>
            {row.action_item && (
              <p className="text-xs leading-relaxed text-muted-foreground">{row.action_item}</p>
            )}
          </div>

          {result ? (
            /* ---- Outcome ---- */
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{result.previousStage || '(none)'}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground dark:text-white">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: getStageColor(result.newStage) }}
                  />
                  {result.newStage}
                </span>
              </div>

              <div className="space-y-2 rounded-lg border border-border p-3 dark:border-slate-800">
                <ResultLine ok label="Deal Tracker stage updated" />
                {note.trim() && (
                  <ResultLine
                    ok={result.reviewNote.saved ? true : 'warn'}
                    label={result.reviewNote.saved ? 'Review note recorded' : 'Review note not recorded'}
                    detail={result.reviewNote.error}
                  />
                )}
                <ResultLine
                  ok={result.crm.stageUpdated ? true : result.crm.leadFound ? 'warn' : 'warn'}
                  label={
                    result.crm.stageUpdated
                      ? `CRM lead stage updated${result.crm.pipelineChanged ? ' (pipeline changed)' : ''}`
                      : result.crm.leadFound
                        ? 'CRM lead found, stage not changed'
                        : 'CRM lead not found'
                  }
                  detail={
                    result.crm.matchedBy === 'tracking_id'
                      ? 'Matched by tracking ID; policy number written back to the lead.'
                      : null
                  }
                />
                {note.trim() && (
                  <ResultLine
                    ok={result.crm.noteSaved ? true : 'warn'}
                    label={result.crm.noteSaved ? 'Note added to CRM lead notes' : 'Note not added to CRM lead notes'}
                  />
                )}
                {result.crm.message && (
                  <p className="pt-1 text-xs text-amber-700 dark:text-amber-400">{result.crm.message}</p>
                )}
              </div>
            </div>
          ) : (
            /* ---- Form ---- */
            <>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground dark:text-slate-100">Stage</label>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                    {currentStage ? (
                      <>
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: getStageColor(currentStage) }}
                        />
                        {currentStage}
                      </>
                    ) : (
                      '(none)'
                    )}
                  </span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <Select value={nextStage} onValueChange={setNextStage}>
                    <SelectTrigger className={cn(adminSelectTrigger, 'w-[300px]')}>
                      <SelectValue placeholder="Select new stage…" />
                    </SelectTrigger>
                    <SelectContent className={adminSelectContent}>
                      {stageGroups.map((cat) => (
                        <SelectGroup key={cat.key}>
                          <SelectLabel className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {cat.label}
                          </SelectLabel>
                          {cat.stages.map((stage) => (
                            <SelectItem key={stage} value={stage} className={adminSelectItem}>
                              <span className="inline-flex items-center gap-2">
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{ backgroundColor: getStageColor(stage) }}
                                />
                                {stage}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground dark:text-slate-100">
                  Note <span className="font-normal text-muted-foreground">— saved to Deal Tracker and CRM lead notes</span>
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Why is the stage changing?"
                  className={cn(
                    'min-h-[110px] w-full rounded-md border border-input bg-background p-3 text-sm text-foreground',
                    'placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'dark:border-slate-800 dark:bg-slate-950 dark:text-white'
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  Prefilled from the correspondence memo. Clear it to change the stage without writing a note.
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p className="min-w-0">{error}</p>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          {canNavigate ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                onClick={() => navigate(-1)}
                disabled={!canPrev || saving}
                title="Previous policy in this queue"
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Previous
              </Button>
              <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                {position} of {total}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={adminOutlineBtn}
                onClick={() => navigate(1)}
                disabled={!canNext || saving}
                title="Next policy in this queue"
              >
                Next
                <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            </div>
          ) : (
            <div />
          )}

          <div className="flex items-center gap-2">
            {result ? (
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className={adminOutlineBtn}
                  onClick={() => onOpenChange(false)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="button" onClick={handleSave} disabled={saving || !nextStage}>
                  {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {saving ? 'Updating…' : 'Update stage'}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
