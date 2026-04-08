/**
 * Hook for handling deal tracker processing after file uploads
 */

import { useState } from 'react'
import { processDealTrackerAfterUpload, saveDealTrackerAfterConfirmation } from './dealTrackerUpload'
import type { DealTrackerPreviewEntry } from './dealTracker'
import type { PendingRowsPayload } from './dealTrackerUpload'
import { supabase } from './supabaseClient'

export function useDealTrackerUpload() {
  const [verificationEntries, setVerificationEntries] = useState<DealTrackerPreviewEntry[]>([])
  const [showVerification, setShowVerification] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [previewLoadingMessage, setPreviewLoadingMessage] = useState<string | null>(null)
  const [pendingRows, setPendingRows] = useState<PendingRowsPayload | null>(null)
  const [saveProgressLogs, setSaveProgressLogs] = useState<string[]>([])

  const createEmptyManualEntry = (agencyCarrierId: string, carrierCode: string): DealTrackerPreviewEntry => ({
    agency_carrier_id: agencyCarrierId,
    name: null,
    tasks: null,
    ghl_name: null,
    ghl_stage: null,
    policy_status: null,
    deal_creation_date: null,
    commission_date: null,
    policy_number: '',
    carrier: carrierCode,
    carrier_id: null,
    deal_value: null,
    cc_value: null,
    charge_back: null,
    notes: null,
    status: null,
    last_updated: new Date().toISOString(),
    sales_agent: null,
    writing_number: null,
    commission_type: null,
    effective_date: null,
    call_center: null,
    phone_number: null,
    cc_pmt_ws: null,
    cc_cb_ws: null,
    carrier_status: null,
    policy_type: null,
    daily_deal_flow_fetched: false,
    daily_deal_flow_fetched_at: null,
    source_policy_table: null,
    source_policy_id: null,
    source_commission_table: null,
    source_commission_id: null,
    isNew: true,
    isUpdated: false,
  })

  /**
   * Process deal tracker after upload if needed
   * Returns true if verification dialog should be shown.
   * Pass pendingRows when upload deferred policy/commission write (AMAM/Aetna deal-tracker files).
   */
  const processAfterUpload = async (
    agencyCarrierId: string,
    fileId: string,
    carrierCode: string,
    fileType: string,
    pendingRowsPayload?: PendingRowsPayload
  ): Promise<boolean> => {
    console.log('[Deal Tracker Hook] processAfterUpload called', {
      agencyCarrierId,
      fileId,
      carrierCode,
      fileType,
      hasPendingRows: !!pendingRowsPayload,
    })

    const upperCode = (carrierCode || '').toUpperCase()
    // Only process supported carriers for Policy and Commission files
    const shouldProcess =
      (upperCode === 'AETNA' ||
        upperCode === 'AMAM' ||
        upperCode === 'MOH' ||
        upperCode === 'RNA' ||
        upperCode === 'TRANSAMERICA' ||
        upperCode === 'LIBERTY' ||
        upperCode === 'COREBRIDGE' ||
        upperCode === 'AFLAC' ||
        upperCode === 'SENTINEL' ||
        upperCode === 'AHL') &&
      (fileType === 'Policy' || fileType === 'Commission')
    if (!shouldProcess) {
      console.log('[Deal Tracker Hook] Skipping - conditions not met:', {
        carrierCode,
        fileType,
        shouldProcess,
      })
      return false
    }

    setPendingRows(pendingRowsPayload ?? null)
    setProcessing(true)
    const rowCount = pendingRowsPayload?.rows?.length ?? 0
    if (rowCount > 0) {
      setPreviewLoadingMessage(`Looking up call center/phone for ${rowCount.toLocaleString()} policies… (15–60s for large files)`)
      setShowVerification(true)
      setVerificationEntries([])
    }
    try {
      console.log('[Deal Tracker Hook] Calling processDealTrackerAfterUpload...')
      const result = await processDealTrackerAfterUpload(
        agencyCarrierId,
        fileId,
        carrierCode,
        fileType,
        pendingRowsPayload
      )

      console.log('[Deal Tracker Hook] Result:', {
        success: result.success,
        entryCount: result.previewEntries?.length || 0,
        error: result.error,
      })

      setPreviewLoadingMessage(null)
        // Show verification dialog for user to review and confirm before saving
        // Show verification dialog for user to review and confirm before saving
      if (result.success && result.previewEntries && result.previewEntries.length > 0) {
        console.log('[Deal Tracker Hook] Setting verification entries and showing dialog')
        setVerificationEntries(result.previewEntries)
        setShowVerification(true)
        return true
      } else if (result.success && upperCode === 'RNA' && fileType === 'Commission') {
        // No ADVANCE section found in RNA commission statement; keep flow editable
        // by opening deal tracker with a blank row users can fill manually.
        setVerificationEntries([createEmptyManualEntry(agencyCarrierId, upperCode)])
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
      setPreviewLoadingMessage(null)
      console.error('[Deal Tracker Hook] Error processing deal tracker:', error)
      console.error('[Deal Tracker Hook] Error stack:', error instanceof Error ? error.stack : 'No stack')
    } finally {
      setProcessing(false)
    }

    return false
  }

  /**
   * Save deal tracker entries after user confirmation.
   * Pass edited entries from the verification dialog so user edits are persisted.
   * When pendingRows was set (deferred write), policy/commission rows are written first, then deal_tracker.
   */
  const confirmAndSave = async (entriesToSave?: DealTrackerPreviewEntry[]): Promise<void> => {
    const toSave = entriesToSave ?? verificationEntries
    if (toSave.length === 0) {
      return
    }

    setProcessing(true)
    setSaveProgressLogs([])
    const onProgress = (msg: string) => {
      setSaveProgressLogs(prev => [...prev, msg])
    }
    try {
      const result = await saveDealTrackerAfterConfirmation(toSave, {
        pendingRows: pendingRows ?? undefined,
        onProgress,
      })

      if (!result.success) {
        throw new Error(result.error || 'Failed to save deal tracker entries')
      }

      setVerificationEntries([])
      setShowVerification(false)
      setPendingRows(null)
      setSaveProgressLogs([])
    } catch (error) {
      console.error('Error saving deal tracker entries:', error)
      throw error
    } finally {
      setProcessing(false)
    }
  }

  /**
   * Cancel verification and clear entries.
   * When there was a deferred write, deletes the file row so policy/commission data is never written.
   */
  const cancelVerification = async () => {
    const hadPending = pendingRows != null
    if (hadPending && pendingRows.fileId) {
      try {
        await supabase.from('files').delete().eq('id', pendingRows.fileId)
        console.log('[Deal Tracker Hook] Cancelled: deleted file row', pendingRows.fileId)
      } catch (e) {
        console.error('[Deal Tracker Hook] Failed to delete file row on cancel:', e)
      }
    }
    setVerificationEntries([])
    setShowVerification(false)
    setPendingRows(null)
    setPreviewLoadingMessage(null)
  }

  return {
    verificationEntries,
    showVerification,
    processing,
    previewLoadingMessage,
    saveProgressLogs,
    processAfterUpload,
    confirmAndSave,
    cancelVerification,
    setShowVerification,
  }
}
