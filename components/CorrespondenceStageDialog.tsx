'use client'

import { formatStoredDateForDisplay } from '@/lib/calendarDate'
import type { AmamCorrespondenceRow, LinkedDealTracker } from '@/lib/amamCorrespondence'
import { GhlStageChangeDialog, type StageChangeResult } from '@/components/GhlStageChangeDialog'

/**
 * AMAM Correspondence's stage-change dialog.
 *
 * A thin adapter over GhlStageChangeDialog: it supplies the correspondence memo
 * as context and prefills the note from it. The stage/CRM/lead-note flow itself
 * lives in the shared dialog, so Lapse Risk and this page cannot drift apart.
 */

export type { StageChangeResult }

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
  if (!row) return null

  return (
    <GhlStageChangeDialog
      open={open}
      onOpenChange={onOpenChange}
      policyNumber={row.policy_number}
      deal={deal}
      rowKey={row.id ?? row.policy_number}
      sourceRef={row.id ?? null}
      defaultNote={buildDefaultNote(row)}
      noteHint="Prefilled from the correspondence memo. Clear it to change the stage without writing a note."
      onSaved={onSaved}
      position={position}
      total={total}
      onNavigate={onNavigate}
      context={
        <>
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
            {row.form_code ? (
              <span className="ml-2 font-mono text-xs text-muted-foreground">{row.form_code}</span>
            ) : null}
          </p>
          {row.action_item && <p className="text-xs leading-relaxed text-muted-foreground">{row.action_item}</p>}
        </>
      }
    />
  )
}
