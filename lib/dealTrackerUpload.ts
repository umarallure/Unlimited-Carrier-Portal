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
import { processTransamericaFilesForDealTracker } from './dealTracker.transamerica'
import { processLibertyFilesForDealTracker } from './dealTracker.liberty'
import { processCorebridgeFilesForDealTracker } from './dealTracker.corebridge'
import { supabase } from './supabaseClient'

/** Payload for deferred deal-tracker flow (in-memory rows + target table + file id). Not used in current upload workflow. */
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

  const isAetna = carrierCode === 'AETNA'
  const isAmam = carrierCode === 'AMAM'
  const isMoh = carrierCode === 'MOH'
  const isRNA = carrierCode === 'RNA'
  const isTransamerica = carrierCode === 'TRANSAMERICA'
  const isLiberty = carrierCode === 'LIBERTY'
  const isCorebridge = carrierCode === 'COREBRIDGE'
  if (!isAetna && !isAmam && !isMoh && !isRNA && !isTransamerica && !isLiberty && !isCorebridge) {
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
        previewEntries = await processAetnaCommissionsForDealTracker(agencyCarrierId, fileId)
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
        previewEntries = await processMohCommissionsForDealTracker(agencyCarrierId, fileId)
      } else {
        console.log('[Deal Tracker] Processing MOH policy file for deal tracker...')
        previewEntries = await processMohFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isRNA) {
      if (fileType === 'Commission') {
        console.log('[Deal Tracker] Processing RNA commission file for deal tracker...')
        previewEntries = await processRNACommissionsForDealTracker(agencyCarrierId, fileId)
      } else {
        console.log('[Deal Tracker] Processing RNA policy file for deal tracker...')
        previewEntries = await processRNAFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isTransamerica) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Transamerica policy file for deal tracker...')
        previewEntries = await processTransamericaFilesForDealTracker(agencyCarrierId, fileId)
      }
      // Transamerica commission upload is not supported yet
    } else if (isLiberty) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Liberty policy file for deal tracker...')
        previewEntries = await processLibertyFilesForDealTracker(agencyCarrierId, fileId)
      }
    } else if (isCorebridge) {
      if (fileType === 'Policy') {
        console.log('[Deal Tracker] Processing Corebridge policy file for deal tracker...')
        previewEntries = await processCorebridgeFilesForDealTracker(agencyCarrierId, fileId)
      }
      // Corebridge commission not wired for deal tracker yet
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
    let entriesToSave = entries
    if (options?.pendingRows?.rows?.length) {
      onProgress?.('Writing policy/commission rows to database...')
      const { targetTable, rows } = options.pendingRows
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
        if (targetTable === 'amam_policies' || targetTable === 'aetna_policies') (out as any).source_policy_id = id
        if (targetTable === 'amam_commissions' || targetTable === 'aetna_commissions') (out as any).source_commission_id = id
        return out
      })
    }
    const result = await saveDealTrackerEntries(entriesToSave, { onProgress })
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
