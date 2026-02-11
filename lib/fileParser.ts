import * as XLSX from 'xlsx';
import Papa from 'papaparse';

interface ParsedRecord {
    policyNumber: string;
    data: Record<string, any>;
}

interface ParseResult {
    records: ParsedRecord[];
    totalRecords: number;
    detectedPolicyColumn: string | null;
}

/**
 * Detect which column likely contains the policy number
 * Looks for common patterns in column names
 */
export function detectPolicyNumberColumn(headers: string[]): string | null {
    const policyPatterns = [
        /^policy[\s_-]?number$/i,
        /^policy[\s_-]?num$/i,
        /^policy[\s_-]?no$/i,
        /^policy$/i,
        /^number$/i,
        /^policy_number$/i,
        /^policynumber$/i,
        /^policy #$/i,
        /^pol no$/i,
    ];

    // First try exact matches
    for (const header of headers) {
        if (!header) continue; // Skip empty headers
        for (const pattern of policyPatterns) {
            if (pattern.test(header.trim())) {
                return header;
            }
        }
    }

    // If no exact match, look for partial matches
    for (const header of headers) {
        if (!header) continue;
        if (header.toLowerCase().includes('policy') &&
            (header.toLowerCase().includes('number') ||
                header.toLowerCase().includes('num') ||
                header.toLowerCase().includes('no'))) {
            return header;
        }
    }

    return null;
}

/**
 * Parse CSV file and extract records
 */
export async function parseCSV(file: File): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: false, // Parse as arrays first to find header row
            skipEmptyLines: true,
            complete: (results: any) => {
                try {
                    const rows = results.data as string[][];
                    if (rows.length === 0) {
                        reject(new Error('File is empty'));
                        return;
                    }

                    // Scan first 20 rows to find the header
                    let headerRowIndex = -1;
                    let policyColumnIndex = -1;
                    let policyColumnName = '';

                    for (let i = 0; i < Math.min(rows.length, 20); i++) {
                        const row = rows[i];
                        // Check if this row looks like headers (has a policy number column)
                        // We cast row to string[] because PapaParse might return different types with header:false
                        const possibleHeaders = row.map(cell => String(cell));
                        const detectedColumn = detectPolicyNumberColumn(possibleHeaders);

                        if (detectedColumn) {
                            headerRowIndex = i;
                            policyColumnName = detectedColumn;
                            policyColumnIndex = possibleHeaders.indexOf(detectedColumn);
                            break;
                        }
                    }

                    if (headerRowIndex === -1) {
                        reject(new Error('Could not detect policy number column. Please ensure your file has a column like "Policy Number", "Policy #", or "PolicyNumber".'));
                        return;
                    }

                    const headers = rows[headerRowIndex].map(h => String(h).trim());
                    const records: ParsedRecord[] = [];

                    // Process data rows (start after header row)
                    for (let i = headerRowIndex + 1; i < rows.length; i++) {
                        const row = rows[i];
                        // Skip empty rows or rows that don't have enough columns
                        if (!row || row.length <= policyColumnIndex) continue;

                        const policyNumber = String(row[policyColumnIndex] || '').trim();

                        if (policyNumber) {
                            // Map row data to header names
                            const rowData: Record<string, any> = {};
                            headers.forEach((header, index) => {
                                if (index < row.length) {
                                    let value = row[index];
                                    // Remove Excel formula indicators
                                    if (typeof value === 'string' && value.startsWith('="') && value.endsWith('"')) {
                                        value = value.slice(2, -1);
                                    }
                                    if (header) { // Only add if header is not empty
                                        rowData[header] = value;
                                    }
                                }
                            });

                            records.push({
                                policyNumber,
                                data: rowData,
                            });
                        }
                    }

                    resolve({
                        records,
                        totalRecords: records.length,
                        detectedPolicyColumn: policyColumnName,
                    });
                } catch (error) {
                    reject(error);
                }
            },
            error: (error: any) => {
                reject(error);
            },
        });
    });
}

/**
 * Parse Excel file and extract records
 */
export async function parseExcel(file: File): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                const workbook = XLSX.read(data, { type: 'binary' });

                // Get the first sheet
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];

                // Convert to JSON with header: 1 to get array of arrays
                const rows = XLSX.utils.sheet_to_json(worksheet, {
                    header: 1,
                    defval: '',
                    raw: false
                }) as any[][];

                if (rows.length === 0) {
                    reject(new Error('The Excel file appears to be empty'));
                    return;
                }

                // Scan first 20 rows to find the header
                let headerRowIndex = -1;
                let policyColumnIndex = -1;
                let policyColumnName = '';

                for (let i = 0; i < Math.min(rows.length, 20); i++) {
                    const row = rows[i];
                    // Ensure row is an array
                    if (!Array.isArray(row)) continue;

                    const possibleHeaders = row.map(cell => String(cell));
                    const detectedColumn = detectPolicyNumberColumn(possibleHeaders);

                    if (detectedColumn) {
                        headerRowIndex = i;
                        policyColumnName = detectedColumn;
                        policyColumnIndex = possibleHeaders.indexOf(detectedColumn);
                        break;
                    }
                }

                if (headerRowIndex === -1) {
                    reject(new Error('Could not detect policy number column. Please ensure your file has a column like "Policy Number". (Scanned first 20 rows)'));
                    return;
                }

                const headers = (rows[headerRowIndex] as any[]).map(h => String(h).trim());
                const records: ParsedRecord[] = [];

                // Process data rows
                for (let i = headerRowIndex + 1; i < rows.length; i++) {
                    const row = rows[i] as any[];
                    if (!row || !Array.isArray(row)) continue;

                    const policyNumber = String(row[policyColumnIndex] || '').trim();

                    if (policyNumber) {
                        const rowData: Record<string, any> = {};
                        headers.forEach((header, index) => {
                            if (header && index < row.length) {
                                rowData[header] = row[index];
                            }
                        });

                        records.push({
                            policyNumber,
                            data: rowData,
                        });
                    }
                }

                resolve({
                    records,
                    totalRecords: records.length,
                    detectedPolicyColumn: policyColumnName,
                });
            } catch (error) {
                reject(error);
            }
        };

        reader.onerror = () => {
            reject(new Error('Failed to read the Excel file'));
        };

        reader.readAsBinaryString(file);
    });
}

/**
 * Parse any supported file type (CSV or Excel)
 */
export async function parseFile(file: File): Promise<ParseResult> {
    const fileName = file.name.toLowerCase();

    if (fileName.endsWith('.csv')) {
        return parseCSV(file);
    } else if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls')) {
        return parseExcel(file);
    } else {
        throw new Error('Unsupported file type. Please upload a CSV or Excel file.');
    }
}
