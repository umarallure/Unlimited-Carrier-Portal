/**
 * Deal Tracker Upload Integration
 * Integrates deal tracker processing into the upload flow
 */

import {
  processAetnaFilesForDealTracker,
  processAetnaCommissionsForDealTracker,
  processAmamFilesForDealTracker,
  processAmamCommissionsForDealTracker,
  processAmamFilesForDealTrackerFromRows,
  processAmamCommissionsForDealTrackerFromRows,
  saveDealTrackerEntries,
  isInvalidGhlStageForSave,
  type DealTrackerPreviewEntry,
} from './dealTracker'
import {
  processMohFilesForDealTracker,
  processMohCommissionsForDealTracker,
} from './dealTracker.moh'
import {
  processRNAFilesForDealTracker,
  processRNACommissionsForDealTracker,
} from './dealTracker.rna'
import { processTransamericaFilesForDealTracker, processTransamericaCommissionsForDealTracker } from './dealTracker.transamerica'
import { processLibertyFilesForDealTracker } from './dealTracker.liberty'
import { processCorebridgeCommissionsForDealTracker, processCorebridgeFilesForDealTracker } from './dealTracker.corebridge'
import { processSentinelFilesForDealTracker, processSentinelCommissionsForDealTracker } from './dealTracker.sentinel'
import { processAflacFilesForDealTracker, processAflacCommissionsForDealTracker } from './dealTracker.aflac'
import { processAhlFilesForDealTracker, processAhlCommissionsForDealTracker } from './dealTracker.ahl'
import { supabase } from './supabaseClient'

/** In-memory commission/policy rows + target table + file id when DB insert is deferred until Commission Report Save. */
export interface PendingRowsPayload {
  fileId: string
  targetTable: string
  rows: Record<string, unknown>[]
}

export interface DealTrackerUploadResult {
  success: boolean
  previewEntries?: DealTrackerPreviewEntry[]
  error?: string
}

/**
 * Process deal tracker entries after Aetna or AMAM file upload
 * Returns preview entries for user verification.
 * When pendingRows is provided (deferred write), builds preview from in-memory rows instead of DB.
 */
export async function processDealTrackerAfterUpload(
  agencyCarrierId: string,
  fileId: string,
  carrierCode: string,
  fileType?: 'Policy' | 'Commission',
  pendingRows?: PendingRowsPayload
): Promise<DealTrackerUploadResult> {
  console.log('[Deal Tracker] processDealTrackerAfterUpload called', {
    agencyCarrierId,
    fileId,
    carrierCode,
    fileType,
    hasPendingRows: !!pendingRows,
  })

  const upperCode = (carrierCode || '').toUpperCase()
  const isAetna = upperCode === 'AETNA'
  const isAmam = upperCode === 'AMAM'
  const isMoh = upperCode === 'MOH'
  const isRNA = upperCode === 'RNA'
  const isTransamerica = upperCode === 'TRANSAMERICA'
  const isLiberty = upperCode === 'LIBERTY'
  const isCorebridge = upperCode === 'COREBRIDGE'
  const isAflac = upperCode === 'AFLAC'
  const isSentinel = upperCode === 'SENTINEL'
  const isAhl = upperCode === 'AHL'
  if (!isAetna && !isAmam && !isMoh && !isRNA && !isTransamerica && !isLiberty && !isCorebridge && !isAflac && !isSentinel && !isAhl) {
    console.log('[Deal Tracker] Skipping - carrier not supported for deal tracker:', carrierCode)
    return { success: true }
  }

  if (fileType !== 'Policy' && fileType !== 'Commission') {
    return { success: true }
  }

  try {
    let previewEntries: DealTrackerPreviewEntry[] = []

    if (isAetna) {
      if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing Aetna commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processAetnaCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processAetnaCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      } else {
        console.log('[Deal Tracker] Processing Aetna policy file for deal tracker...')
        previewEntries = await processAetnaFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isAmam) {
      if (pendingRows?.rows?.length) {
        if (fileType === 'Commission') {
          console.log('[Deal Tracker] Processing AMAM commission from pending rows (deferred write)...')
          previewEntries = await processAmamCommissionsForDealTrackerFromRows(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          console.log('[Deal Tracker] Processing AMAM policy from pending rows (deferred write)...')
          previewEntries = await processAmamFilesForDealTrackerFromRows(agencyCarrierId, fileId, pendingRows.rows)
        }
      } else {
        if (fileType === 'Commission') {
          console.log('[Deal Tracker] Processing AMAM commission file for deal tracker...')
          previewEntries = await processAmamCommissionsForDealTracker(agencyCarrierId, fileId)
        } else {
          console.log('[Deal Tracker] Processing AMAM policy file for deal tracker...')
          previewEntries = await processAmamFilesForDealTracker(agencyCarrierId, fileId)
        }
      }
    } else if (isMoh) {
      if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing MOH commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processMohCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processMohCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      } else {
        console.log('[Deal Tracker] Processing MOH policy file for deal tracker...')
        previewEntries = await processMohFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isRNA) {
      if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing RNA commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processRNACommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processRNACommissionsForDealTracker(agencyCarrierId, fileId)
        }
      } else {
        console.log('[Deal Tracker] Processing RNA policy file for deal tracker...')
        previewEntries = await processRNAFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isTransamerica) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Transamerica policy file for deal tracker...')
        previewEntries = await processTransamericaFilesForDealTracker(agencyCarrierId, fileId)
      } else if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing Transamerica commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processTransamericaCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processTransamericaCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      }
    } else if (isLiberty) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Liberty policy file for deal tracker...')
        previewEntries = await processLibertyFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isCorebridge) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Corebridge policy file for deal tracker...')
        previewEntries = await processCorebridgeFilesForDealTracker(agencyCarrierId, fileId)
      } else if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing Corebridge commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processCorebridgeCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processCorebridgeCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      }
    } else if (isAflac) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing AFLAC policy file for deal tracker...')
        previewEntries = await processAflacFilesForDealTracker(agencyCarrierId, fileId)
      } else if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing AFLAC commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processAflacCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processAflacCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      }
    } else if (isSentinel) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Sentinel policy file for deal tracker...')
        previewEntries = await processSentinelFilesForDealTracker(agencyCarrierId, fileId)
      } else if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing Sentinel commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processSentinelCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processSentinelCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      }
    } else if (isAhl) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing AHL policy file for deal tracker...')
        previewEntries = await processAhlFilesForDealTracker(agencyCarrierId, fileId)
      } else if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing AHL commission file for deal tracker...')
        if (pendingRows?.rows?.length) {
          previewEntries = await processAhlCommissionsForDealTracker(agencyCarrierId, fileId, pendingRows.rows)
        } else {
          previewEntries = await processAhlCommissionsForDealTracker(agencyCarrierId, fileId)
        }
      }
    }

    console.log('[Deal Tracker] Processing complete', {
      entryCount: previewEntries.length,
      previewEntries: previewEntries.slice(0, 3), // Log first 3 entries
    })

    return {
      success: true,
      previewEntries,
    }
  } catch (error: any) {
    console.error('[Deal Tracker] Error processing deal tracker:', error)
    console.error('[Deal Tracker] Error stack:', error.stack)
    return {
      success: false,
      error: error.message || 'Failed to process deal tracker entries',
    }
  }
}

export interface SaveDealTrackerAfterConfirmationOptions {
  pendingRows?: PendingRowsPayload
  onProgress?: (message: string) => void
  /**
   * Persist deal_tracker only (used when user clicks Next before the Commission Report step).
   * Skips inserting deferred commission/policy rows and skips commission_tracker sync — those run on full confirm after Commission Report Save.
   */
  dealTrackerOnly?: boolean
  /** File that triggered this save; stamped onto every deal_tracker row for version_history attribution. */
  triggerFileId?: string | null
}

async function syncEditedEntriesToCommissionTracker(
  entries: DealTrackerPreviewEntry[],
  onProgress?: (message: string) => void,
): Promise<void> {
  const now = new Date().toISOString()
  const editable = entries.filter(
    (e) => e.source_commission_table && e.source_commission_id,
  )
  if (!editable.length) return
  onProgress?.('Syncing edited commission metadata to commission tracker...')
  for (const entry of editable) {
    const sourceTable = String(entry.source_commission_table)
    const sourceRowId = String(entry.source_commission_id)
    // Keep financial transaction amounts in commission_tracker sourced from
    // carrier commission tables only. deal_tracker values are policy-level
    // aggregates and can otherwise duplicate advance on chargeback rows.
    const payload: Record<string, unknown> = {
      policy_number: entry.policy_number,
      carrier: entry.carrier,
      name: entry.name ?? null,
      sales_agent: entry.sales_agent ?? null,
      updated_at: now,
    }
    if (entry.commission_date && String(entry.commission_date).trim() !== '') {
      payload.date = String(entry.commission_date).trim()
    }
    const { error } = await supabase
      .from('commission_tracker')
      .update(payload)
      .eq('source_table', sourceTable)
      .eq('source_row_id', sourceRowId)
    if (error) {
      throw new Error(`Failed to sync commission_tracker for ${entry.policy_number}: ${error.message}`)
    }
  }
}

/**
 * Save deal tracker entries after user confirmation.
 * If options.pendingRows is provided, writes policy/commission rows to DB first, then saves deal_tracker with resolved source ids.
 */
export async function saveDealTrackerAfterConfirmation(
  entries: DealTrackerPreviewEntry[],
  options?: SaveDealTrackerAfterConfirmationOptions
): Promise<{ success: boolean; inserted: number; updated: number; failed: number; error?: string }> {
  const onProgress = options?.onProgress
  try {
    const badGhl = entries.find((e) => isInvalidGhlStageForSave(e.ghl_stage))
    if (badGhl) {
      return {
        success: false,
        inserted: 0,
        updated: 0,
        failed: entries.length,
        error:
          'GHL Stage cannot be empty or "-" for any row. Use the Incomplete tab in the verification dialog to fix rows before saving.',
      }
    }

    const triggerFileId = options?.triggerFileId ?? options?.pendingRows?.fileId ?? null

    if (options?.dealTrackerOnly) {
      try {
        const result = await saveDealTrackerEntries(entries, { onProgress, triggerFileId })
        return {
          success: true,
          ...result,
        }
      } catch (error: any) {
        console.error('Error saving deal tracker entries (dealTrackerOnly):', error)
        return {
          success: false,
          inserted: 0,
          updated: 0,
          failed: entries.length,
          error: error.message || 'Failed to save deal tracker entries',
        }
      }
    }

    let entriesToSave = entries
    if (options?.pendingRows?.rows?.length) {
      const { targetTable, rows, fileId: pendingFileId } = options.pendingRows
      const agencyCarrierId = entries[0]?.agency_carrier_id
      const isCommissionTable = targetTable.endsWith('_commissions')

      // HARD GUARD:
      // Commission rows must be written only by Commission Report Save.
      // Deal tracker confirm must never insert commission table rows.
      if (isCommissionTable) {
        if (!agencyCarrierId || !pendingFileId) {
          throw new Error('Missing commission context while linking deal tracker to saved commission rows.')
        }
        onProgress?.('Linking deal tracker to saved commission rows...')
        const { data: existingRows, error: linkErr } = await supabase
          .from(targetTable)
          .select('id, policy_number')
          .eq('agency_carrier_id', agencyCarrierId)
          .eq('file_id', pendingFileId)
          .order('row_number', { ascending: true })
        if (linkErr) throw new Error(`Failed to load ${targetTable} for linking: ${linkErr.message}`)
        if (!existingRows || existingRows.length === 0) {
          throw new Error(
            'Commission rows are not saved yet. Please save the Commission Report first, then confirm deal tracker.'
          )
        }
        const policyNumberToId = new Map<string, string>()
        for (const r of existingRows) {
          const pn = String((r as { policy_number?: string }).policy_number ?? '')
          if (pn && !policyNumberToId.has(pn)) {
            policyNumberToId.set(pn, String((r as { id: string }).id))
          }
        }
        entriesToSave = entries.map(entry => {
          const id = policyNumberToId.get(entry.policy_number)
          if (!id) return entry
          const out = { ...entry }
          ;(out as any).source_commission_id = id
          ;(out as any).source_commission_table = targetTable
          return out
        })
      } else {
        onProgress?.('Writing policy/commission rows to database...')
        const BATCH_SIZE = 500
        const now = new Date().toISOString()
        const policyNumberToId = new Map<string, string>()
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
          const chunk = rows.slice(i, i + BATCH_SIZE).map((r: any) => {
            const row = { ...r, updated_at: now }
            delete (row as any).id
            delete (row as any).created_at
            return row
          })
          const { data: inserted, error } = await supabase
            .from(targetTable)
            .upsert(chunk, { onConflict: 'agency_carrier_id,policy_number', ignoreDuplicates: false })
            .select('id, policy_number')
          if (error) throw new Error(`Failed to write ${targetTable}: ${error.message}`)
          if (inserted) inserted.forEach((row: { id: string; policy_number: string }) => policyNumberToId.set(row.policy_number, row.id))
        }
        entriesToSave = entries.map(entry => {
          const id = policyNumberToId.get(entry.policy_number)
          if (!id) return entry
          const out = { ...entry }
          if (targetTable.endsWith('_policies')) (out as any).source_policy_id = id
          if (targetTable.endsWith('_commissions')) {
            ;(out as any).source_commission_id = id
            ;(out as any).source_commission_table = targetTable
          }
          return out
        })
      }
    }
    const result = await saveDealTrackerEntries(entriesToSave, { onProgress, triggerFileId })
    const pendingTarget = options?.pendingRows?.targetTable ?? ''
    const isCommissionPendingFlow = pendingTarget.endsWith('_commissions')
    // Commission uploads: commission_tracker must be written only by Commission Report Save.
    if (!isCommissionPendingFlow) {
      await syncEditedEntriesToCommissionTracker(entriesToSave, onProgress)
    }
    return {
      success: true,
      ...result,
    }
  } catch (error: any) {
    console.error('Error saving deal tracker entries:', error)
    return {
      success: false,
      inserted: 0,
      updated: 0,
      failed: entries.length,
      error: error.message || 'Failed to save deal tracker entries',
    }
  }
}
