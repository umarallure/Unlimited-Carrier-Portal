/**
 * Deal Tracker Upload Integration
 * Integrates deal tracker processing into the upload flow
 */

import { processAetnaFilesForDealTracker, processAetnaCommissionsForDealTracker, saveDealTrackerEntries, type DealTrackerPreviewEntry } from './dealTracker'

export interface DealTrackerUploadResult {
  success: boolean
  previewEntries?: DealTrackerPreviewEntry[]
  error?: string
}

/**
 * Process deal tracker entries after Aetna file upload
 * Returns preview entries for user verification
 */
export async function processDealTrackerAfterUpload(
  agencyCarrierId: string,
  fileId: string,
  carrierCode: string,
  fileType?: 'Policy' | 'Commission'
): Promise<DealTrackerUploadResult> {
  console.log('[Deal Tracker] processDealTrackerAfterUpload called', {
    agencyCarrierId,
    fileId,
    carrierCode,
    fileType,
  })

  // Only process Aetna files for now
  if (carrierCode !== 'AETNA') {
    console.log('[Deal Tracker] Skipping - not AETNA carrier:', carrierCode)
    return { success: true } // Skip for other carriers
  }

  try {
    let previewEntries: DealTrackerPreviewEntry[] = []

    if (fileType === 'Commission') {
      console.log('[Deal Tracker] Processing Aetna commission file for deal tracker...')
      previewEntries = await processAetnaCommissionsForDealTracker(
        agencyCarrierId,
        fileId
      )
    } else {
      // Default to Policy file processing
      console.log('[Deal Tracker] Processing Aetna policy file for deal tracker...')
      previewEntries = await processAetnaFilesForDealTracker(
        agencyCarrierId,
        fileId
      )
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

/**
 * Save deal tracker entries after user confirmation
 */
export async function saveDealTrackerAfterConfirmation(
  entries: DealTrackerPreviewEntry[]
): Promise<{ success: boolean; inserted: number; updated: number; failed: number; error?: string }> {
  try {
    const result = await saveDealTrackerEntries(entries)
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
