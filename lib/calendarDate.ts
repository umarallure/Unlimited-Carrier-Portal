/**
 * Calendar dates from Postgres (`date`, `timestamptz`) should display and edit as the stored
 * calendar day — avoid `new Date(x).toISOString().slice(0,10)` and `toLocaleDateString()`, which
 * shift the day for many users when the value is date-only or midnight UTC.
 */

/** First YYYY-MM-DD in the string, or empty if none. */
export function extractYmdFromDbValue(value: unknown): string {
  if (value == null) return ''
  const s = String(value).trim()
  if (!s) return ''
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/)
  return m ? m[1] : ''
}

/**
 * Value for `<input type="date" />`: prefer literal YMD from API; otherwise local calendar YMD
 * (no UTC conversion).
 */
export function toYmdForDateInput(value: unknown): string {
  const direct = extractYmdFromDbValue(value)
  if (direct) return direct
  const s = String(value ?? '').trim()
  if (!s) return ''

  // Common UI/export format: MM/DD/YYYY (optionally with time suffix)
  // e.g. "3/2/2026" or "03/02/2026 00:00:00"
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\b|[\sT].*)?$/)
  if (us) {
    const m = String(parseInt(us[1], 10)).padStart(2, '0')
    const d = String(parseInt(us[2], 10)).padStart(2, '0')
    return `${us[3]}-${m}-${d}`
  }

  const d = new Date(s.includes('T') ? s : `${s}T12:00:00`)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const mo = d.getMonth() + 1
  const day = d.getDate()
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Table cell: show stored calendar date, usually `YYYY-MM-DD`. */
export function formatStoredDateForDisplay(value: unknown): string {
  const y = extractYmdFromDbValue(value)
  if (y) return y
  const s = String(value ?? '').trim()
  return s
}

/**
 * ACTIVE - 3 Months + uses only `deal_tracker.effective_date`: if a row already exists and the
 * column is empty, do not use DDF/issue fallbacks for that rule. New rows use the proposed
 * `effective_date` being saved.
 */
export function effectiveDateForThreeMonthRuleFromPreview(
  existing: { effective_date?: string | null } | null | undefined,
  proposedEffectiveDate: string | null
): string | null {
  if (existing) {
    const e = existing.effective_date
    if (e != null && String(e).trim() !== '') return String(e).trim()
    return null
  }
  if (proposedEffectiveDate != null && String(proposedEffectiveDate).trim() !== '')
    return String(proposedEffectiveDate).trim()
  return null
}

/** Non-empty trimmed string or null. */
export function nonEmptyStringOrNull(value: unknown): string | null {
  if (value == null) return null
  const t = String(value).trim()
  return t === '' ? null : t
}

/**
 * Deal tracker `effective_date`: keep the value already stored on the row; if empty, use DDF
 * `draft_date`; then optional fallbacks (policy/commission dates). Does not overwrite a stored date.
 */
export function mergeEffectiveDate(
  existingEffective: unknown,
  draftDateFromDdf: unknown,
  ...fallbacks: unknown[]
): string | null {
  const existing = nonEmptyStringOrNull(existingEffective)
  if (existing) return existing
  const ddf = nonEmptyStringOrNull(draftDateFromDdf)
  if (ddf) return ddf
  for (const f of fallbacks) {
    const x = nonEmptyStringOrNull(f)
    if (x) return x
  }
  return null
}
