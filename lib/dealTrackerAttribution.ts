/**
 * Attribution helpers for deal_tracker writes.
 *
 * Every write path stamps these four columns so version_history snapshots
 * (captured by the BEFORE UPDATE trigger as `to_jsonb(OLD)`) include the
 * file + user that produced each row state.
 */

import { supabase } from './supabaseClient'

export interface DealTrackerAttribution {
  last_changed_by_file_id: string | null
  last_changed_by_file_name: string | null
  last_changed_by_user_id: string | null
  last_changed_by_user_email: string | null
}

const fileNameCache = new Map<string, string | null>()

async function resolveFileName(fileId: string | null | undefined): Promise<string | null> {
  if (!fileId) return null
  if (fileNameCache.has(fileId)) return fileNameCache.get(fileId) ?? null
  const { data, error } = await supabase
    .from('files')
    .select('original_filename')
    .eq('id', fileId)
    .single()
  const name = error || !data ? null : (data as { original_filename?: string | null }).original_filename ?? null
  fileNameCache.set(fileId, name)
  return name
}

async function resolveCurrentUser(): Promise<{ id: string | null; email: string | null }> {
  const { data } = await supabase.auth.getUser()
  return {
    id: data.user?.id ?? null,
    email: data.user?.email ?? null,
  }
}

/**
 * Build the attribution object for the current write.
 * Pass `fileId` for upload-driven changes; omit for manual edits.
 */
export async function buildDealTrackerAttribution(
  fileId?: string | null
): Promise<DealTrackerAttribution> {
  const [fileName, user] = await Promise.all([
    resolveFileName(fileId ?? null),
    resolveCurrentUser(),
  ])
  return {
    last_changed_by_file_id: fileId ?? null,
    last_changed_by_file_name: fileName,
    last_changed_by_user_id: user.id,
    last_changed_by_user_email: user.email,
  }
}
