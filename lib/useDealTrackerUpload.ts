/**
 * Hook for handling deal tracker processing after file uploads
 */

import { useState } from 'react'
import { processDealTrackerAfterUpload, saveDealTrackerAfterConfirmation } from './dealTrackerUpload'
import type { DealTrackerPreviewEntry } from './dealTracker'

export function useDealTrackerUpload() {
  const [verificationEntries, setVerificationEntries] = useState<DealTrackerPreviewEntry[]>([])
  const [showVerification, setShowVerification] = useState(false)
  const [processing, setProcessing] = useState(false)

  /**
   * Process deal tracker after upload if needed
   * Returns true if verification dialog should be shown
   */
  const processAfterUpload = async (
    agencyCarrierId: string,
    fileId: string,
    carrierCode: string,
    fileType: string
  ): Promise<boolean> => {
    console.log('[Deal Tracker Hook] processAfterUpload called', {
      agencyCarrierId,
      fileId,
      carrierCode,
      fileType,
    })

    // Only process Aetna Policy and Commission files
    if (carrierCode !== 'AETNA' || (fileType !== 'Policy' && fileType !== 'Commission')) {
      console.log('[Deal Tracker Hook] Skipping - conditions not met:', {
        carrierCode,
        fileType,
        shouldProcess: carrierCode === 'AETNA' && (fileType === 'Policy' || fileType === 'Commission'),
      })
      return false
    }

    setProcessing(true)
    try {
      console.log('[Deal Tracker Hook] Calling processDealTrackerAfterUpload...')
      const result = await processDealTrackerAfterUpload(
        agencyCarrierId,
        fileId,
        carrierCode,
        fileType
      )

      console.log('[Deal Tracker Hook] Result:', {
        success: result.success,
        entryCount: result.previewEntries?.length || 0,
        error: result.error,
      })

      if (result.success && result.previewEntries && result.previewEntries.length > 0) {
        // Show verification dialog for user to review and confirm before saving
        console.log('[Deal Tracker Hook] Setting verification entries and showing dialog')
        setVerificationEntries(result.previewEntries)
        setShowVerification(true)
        return true
      } else {
        console.log('[Deal Tracker Hook] No entries to process:', {
          success: result.success,
          hasEntries: !!(result.previewEntries && result.previewEntries.length > 0),
          error: result.error,
        })
      }
    } catch (error) {
      console.error('[Deal Tracker Hook] Error processing deal tracker:', error)
      console.error('[Deal Tracker Hook] Error stack:', error instanceof Error ? error.stack : 'No stack')
    } finally {
      setProcessing(false)
    }

    return false
  }

  /**
   * Save deal tracker entries after user confirmation
   */
  const confirmAndSave = async (): Promise<void> => {
    if (verificationEntries.length === 0) {
      return
    }

    setProcessing(true)
    try {
      const result = await saveDealTrackerAfterConfirmation(verificationEntries)

      if (!result.success) {
        throw new Error(result.error || 'Failed to save deal tracker entries')
      }

      // Clear verification entries and close dialog
      setVerificationEntries([])
      setShowVerification(false)
    } catch (error) {
      console.error('Error saving deal tracker entries:', error)
      throw error
    } finally {
      setProcessing(false)
    }
  }

  /**
   * Cancel verification and clear entries
   */
  const cancelVerification = () => {
    setVerificationEntries([])
    setShowVerification(false)
  }

  return {
    verificationEntries,
    showVerification,
    processing,
    processAfterUpload,
    confirmAndSave,
    cancelVerification,
    setShowVerification,
  }
}
