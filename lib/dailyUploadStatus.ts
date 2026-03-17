import { supabase } from './supabaseClient'

export type DailyStatus = 'uploaded' | 'no_update'

function nextDay(ymd: string): string {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/**
 * Get start/end of a calendar day in local timezone as ISO strings (for Supabase query).
 * Use this so "today" means the user's current day, not UTC day.
 */
export function getLocalDayRange(dateYmd: string): { start: string; end: string } {
  // dateYmd is YYYY-MM-DD; interpret as local date
  const startLocal = new Date(dateYmd + 'T00:00:00')
  const endLocal = new Date(startLocal.getTime() + 24 * 60 * 60 * 1000)
  return {
    start: startLocal.toISOString(),
    end: endLocal.toISOString(),
  }
}

/**
 * Fetch status for (upload_date, agency_carrier_ids).
 * "uploaded" = BOTH Policy and Commission files exist for that date.
 * "no_update" = from daily_carrier_upload_status when user explicitly marked it.
 * Uses local calendar day (start/end) so uploads "today" in user's timezone count.
 */
export async function fetchDailyStatus(
  uploadDate: string,
  agencyCarrierIds: string[],
  options?: { startISO?: string; endISO?: string }
): Promise<Record<string, DailyStatus>> {
  if (agencyCarrierIds.length === 0) return {}
  const map: Record<string, DailyStatus> = {}

  const start = options?.startISO ?? `${uploadDate}T00:00:00.000Z`
  const end = options?.endISO ?? `${nextDay(uploadDate)}T00:00:00.000Z`

  // 1. Derive "uploaded" from files table: both Policy and Commission uploaded on this date
  const { data: filesData, error: filesError } = await supabase
    .from('files')
    .select('agency_carrier_id, file_type')
    .in('agency_carrier_id', agencyCarrierIds)
    .gte('created_at', start)
    .lt('created_at', end)

  if (!filesError && filesData) {
    const byAc = new Map<string, Set<string>>()
    filesData.forEach((row: { agency_carrier_id: string; file_type: string }) => {
      if (!byAc.has(row.agency_carrier_id)) byAc.set(row.agency_carrier_id, new Set())
      byAc.get(row.agency_carrier_id)!.add(row.file_type)
    })
    byAc.forEach((types, acId) => {
      if (types.has('Policy') && types.has('Commission')) {
        map[acId] = 'uploaded'
      }
    })
  }

  // 2. "no_update" from daily_carrier_upload_status (user explicitly marked)
  const { data: statusData, error: statusError } = await supabase
    .from('daily_carrier_upload_status')
    .select('agency_carrier_id, status')
    .eq('upload_date', uploadDate)
    .in('agency_carrier_id', agencyCarrierIds)

  if (!statusError && statusData) {
    statusData.forEach((row: { agency_carrier_id: string; status: DailyStatus }) => {
      if (row.status === 'no_update') {
        map[row.agency_carrier_id] = 'no_update'
      }
    })
  }

  return map
}

/** Map: agency_carrier_id -> Set of file_type that have been uploaded for this date (Policy, Commission). Uses local day range when startISO/endISO provided. */
export async function fetchDailyFileTypes(
  uploadDate: string,
  agencyCarrierIds: string[],
  options?: { startISO?: string; endISO?: string }
): Promise<Record<string, Set<string>>> {
  if (agencyCarrierIds.length === 0) return {}
  const start = options?.startISO ?? `${uploadDate}T00:00:00.000Z`
  const end = options?.endISO ?? `${nextDay(uploadDate)}T00:00:00.000Z`
  const { data: filesData, error } = await supabase
    .from('files')
    .select('agency_carrier_id, file_type')
    .in('agency_carrier_id', agencyCarrierIds)
    .gte('created_at', start)
    .lt('created_at', end)

  const result: Record<string, Set<string>> = {}
  if (!error && filesData) {
    filesData.forEach((row: { agency_carrier_id: string; file_type: string }) => {
      if (!result[row.agency_carrier_id]) result[row.agency_carrier_id] = new Set()
      result[row.agency_carrier_id].add(row.file_type)
    })
  }
  return result
}

/**
 * Set status for a carrier on a date (uploaded or no_update).
 */
export async function setDailyStatus(
  uploadDate: string,
  agencyCarrierId: string,
  status: DailyStatus
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from('daily_carrier_upload_status')
    .upsert(
      { upload_date: uploadDate, agency_carrier_id: agencyCarrierId, status },
      { onConflict: 'upload_date,agency_carrier_id' }
    )
  if (error) {
    console.error('setDailyStatus error:', error)
    return { ok: false, error: error.message }
  }
  return { ok: true }
}
