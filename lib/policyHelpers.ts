import { supabase } from './supabaseClient';

interface PolicyRecord {
    policyNumber: string;
    data: Record<string, any>;
}

interface UpsertResult {
    inserted: number;
    updated: number;
    failed: number;
}

/**
 * Upsert policy records into the database
 * Updates existing records based on (agency_carrier_id, policy_number) unique constraint
 */
export async function upsertPolicyRecords(
    agencyCarrierId: string,
    fileType: 'Policy' | 'Commission',
    records: PolicyRecord[],
    uploadedFileId?: string
): Promise<UpsertResult> {
    let inserted = 0;
    let updated = 0;
    let failed = 0;

    for (const record of records) {
        try {
            const { error } = await supabase
                .from('policy_records')
                .upsert(
                    {
                        agency_carrier_id: agencyCarrierId,
                        file_id: uploadedFileId || null,
                        policy_number: record.policyNumber,
                        file_type: fileType,
                        raw_data: record.data,
                        updated_at: new Date().toISOString(),
                    },
                    {
                        onConflict: 'agency_carrier_id,policy_number',
                    }
                );

            if (error) {
                console.error('Error upserting record:', error);
                failed++;
            } else {
                // Check if this was an insert or update by querying
                const { data: existing } = await supabase
                    .from('policy_records')
                    .select('created_at, updated_at')
                    .eq('agency_carrier_id', agencyCarrierId)
                    .eq('policy_number', record.policyNumber)
                    .single();

                if (existing && existing.created_at !== existing.updated_at) {
                    updated++;
                } else {
                    inserted++;
                }
            }
        } catch (err) {
            console.error('Exception upserting record:', err);
            failed++;
        }
    }

    return { inserted, updated, failed };
}

/**
 * Fetch policy records for a specific carrier
 */
export async function fetchPolicyRecords(
    agencyCarrierId: string,
    fileType?: 'Policy' | 'Commission'
) {
    let query = supabase
        .from('policy_records')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .order('created_at', { ascending: false });

    if (fileType) {
        query = query.eq('file_type', fileType);
    }

    const { data, error } = await query;

    if (error) {
        // Avoid breaking the carrier page when the table/migration
        // is missing; just log and return an empty list.
        console.warn('fetchPolicyRecords error:', error);
        return [];
    }

    return data || [];
}

/**
 * Create uploaded file record
 */
export async function createUploadedFileRecord(
    agencyCarrierId: string,
    filename: string,
    fileType: 'Policy' | 'Commission'
) {
    const { data, error } = await supabase
        .from('uploaded_files')
        .insert({
            agency_carrier_id: agencyCarrierId,
            original_filename: filename,
            file_type: fileType,
            status: 'processing',
        })
        .select()
        .single();

    if (error) {
        throw error;
    }

    return data;
}

/**
 * Update uploaded file record status
 */
export async function updateUploadedFileStatus(
    fileId: string,
    status: 'processing' | 'completed' | 'failed',
    recordCount?: number,
    errorMessage?: string
) {
    const { error } = await supabase
        .from('uploaded_files')
        .update({
            status,
            record_count: recordCount,
            error_message: errorMessage,
        })
        .eq('id', fileId);

    if (error) {
        throw error;
    }
}

/**
 * Get upload history for a carrier
 */
export async function getUploadHistory(agencyCarrierId: string) {
    const { data, error } = await supabase
        .from('uploaded_files')
        .select('*')
        .eq('agency_carrier_id', agencyCarrierId)
        .order('uploaded_at', { ascending: false });

    if (error) {
        throw error;
    }

    return data || [];
}
