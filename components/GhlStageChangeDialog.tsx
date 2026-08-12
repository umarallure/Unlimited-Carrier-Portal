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
import { GHL_STAGE_CATEGORIES, getStageColor } from '@/lib/ghlStageResolver'

/**
 * Change a policy's GHL stage and push it to the CRM.
 *
 * One dialog, several callers (AMAM Correspondence, Lapse Risk). Everything
 * caller-specific arrives as props — the context block, the prefilled note, and
 * the queue navigation — so the CRM-sync flow and its outcome reporting exist in
 * exactly one place.
 */

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

/**
 * Minimum the dialog needs from a deal_tracker row. Structural, so callers can
 * pass their own richer row types without converting.
 */
export type StageChangeDeal = {
  id: string
  ghl_stage: string | null
}

export type GhlStageChangeDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Null renders nothing. */
  policyNumber: string | null
  /** The deal_tracker row for this policy. Without one there is nothing to change. */
  deal: StageChangeDeal | null
  /**
   * Stable identity of the record being acted on. The form resets when this
   * changes — keyed on a string rather than an object so an unrelated re-render
   * cannot wipe a note the user is part-way through typing.
   */
  rowKey?: string | null
  /** Caller-supplied context block rendered above the form. */
  context?: React.ReactNode
  /** Prefilled note body. */
  defaultNote?: string
  /** One line explaining where the prefilled note came from. */
  noteHint?: string
  /** Opaque reference to the originating record; echoed back by the API. */
  sourceRef?: string | null
  onSaved: (result: StageChangeResult) => void
  /** 1-based position in the caller's action queue. */
  position?: number
  /** Size of the action queue. */
  total?: number
  /** Step through the queue by `delta` without closing the dialog. */
  onNavigate?: (delta: number) => void
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

export function GhlStageChangeDialog({
  open,
  onOpenChange,
  policyNumber,
  deal,
  rowKey,
  context,
  defaultNote = '',
  noteHint,
  sourceRef,
  onSaved,
  position,
  total,
  onNavigate,
}: GhlStageChangeDialogProps) {
  const [nextStage, setNextStage] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<StageChangeResult | null>(null)

  const resetKey = rowKey ?? policyNumber ?? ''

  useEffect(() => {
    if (!open) return
    setNextStage('')
    setNote(defaultNote)
    setError(null)
    setResult(null)
    setSaving(false)
    // defaultNote is derived from resetKey by every caller, so keying on
    // resetKey alone keeps typing safe from unrelated re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetKey])

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
    if (!policyNumber || !deal || !nextStage) return
    setSaving(true)
    setError(null)

    try {
      const res = await fetch('/api/deal-tracker/ghl-stage-change', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dealId: deal.id,
          policyNumber,
          newStage: nextStage,
          note: note.trim(),
          sourceRef: sourceRef ?? null,
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

  if (!policyNumber) return null

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
          {context && (
            <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm dark:border-slate-800 dark:bg-slate-950/40">
              {context}
            </div>
          )}

          {!deal && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="min-w-0">
                Policy {policyNumber} has no Deal Tracker row, so there is no stage to change. Upload the carrier file
                for it first.
              </p>
            </div>
          )}

          {result ? (
            /* ---- Outcome ---- */
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{result.previousStage || '(none)'}</span>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="inline-flex items-center gap-1.5 font-medium text-foreground dark:text-white">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getStageColor(result.newStage) }} />
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
                  ok={result.crm.stageUpdated ? true : 'warn'}
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
                  <Select value={nextStage} onValueChange={setNextStage} disabled={!deal}>
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
                  Note{' '}
                  <span className="font-normal text-muted-foreground">
                    — saved to Deal Tracker and CRM lead notes
                  </span>
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
                  {noteHint ?? 'Clear it to change the stage without writing a note.'}
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
                <Button type="button" onClick={handleSave} disabled={saving || !nextStage || !deal}>
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
