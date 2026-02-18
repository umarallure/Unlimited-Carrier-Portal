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
        /^POLICYNUMBER$/i, // Exact uppercase match for commission files
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
  * Parse Excel file and extract records.
 * Uses ArrayBuffer for more reliable parsing. On "Bad uncompressed size" (e.g. CSV mislabeled as .xlsx), falls back to CSV.
 */
export async function parseExcel(file: File): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onerror = () => {
            reject(new Error('Failed to read the file'));
        };

        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                if (data == null) {
                    reject(new Error('Failed to read the file'));
                    return;
                }

                let workbook: XLSX.WorkBook;
                try {
                    // Suppress XLSX library warnings temporarily
                    const originalWarn = console.warn;
                    const originalError = console.error;
                    const warnings: any[] = [];
                    
                    console.warn = (...args: any[]) => {
                        const msg = args.join(' ');
                        // Filter out XLSX "Bad uncompressed size" warnings - these are often non-fatal
                        if (!msg.includes('Bad uncompressed size') && !msg.includes('uncompressed')) {
                            warnings.push(args);
                        }
                    };
                    
                    console.error = (...args: any[]) => {
                        const msg = args.join(' ');
                        // Filter out XLSX "Bad uncompressed size" errors - these are often non-fatal
                        if (!msg.includes('Bad uncompressed size') && !msg.includes('uncompressed')) {
                            warnings.push(args);
                        }
                    };

                    try {
                        // Read as array buffer for better compatibility
                        if (data instanceof ArrayBuffer) {
                            // Try reading with different options
                            try {
                                workbook = XLSX.read(new Uint8Array(data), { 
                                    type: 'array', 
                                    cellStyles: false,
                                    cellDates: false,
                                    dense: false,
                                    WTF: false // Suppress warnings about bad files
                                });
                            } catch (err) {
                                // If array reading fails, try reading as buffer directly
                                workbook = XLSX.read(data, { 
                                    type: 'buffer', 
                                    cellStyles: false,
                                    cellDates: false,
                                    dense: false,
                                    WTF: false
                                });
                            }
                        } else if (typeof data === 'string') {
                            workbook = XLSX.read(data, { 
                                type: 'binary', 
                                cellStyles: false,
                                cellDates: false,
                                dense: false,
                                WTF: false
                            });
                        } else {
                            reject(new Error('Unexpected file data type'));
                            return;
                        }
                    } finally {
                        // Restore console methods
                        console.warn = originalWarn;
                        console.error = originalError;
                    }
                } catch (xlsxError: unknown) {
                    const msg = xlsxError instanceof Error ? xlsxError.message : String(xlsxError);
                    console.error('[File Parser] Excel parsing error:', xlsxError);
                    
                    // Handle specific Excel parsing errors
                    if (msg.includes('Bad uncompressed size') || 
                        msg.includes('uncompressed') || 
                        msg.includes('ZIP') ||
                        msg.includes('corrupt') ||
                        msg.includes('invalid')) {
                        reject(new Error(
                            'This file does not appear to be a valid Excel (.xlsx) file. ' +
                            'The file may be corrupted or not actually an Excel file. ' +
                            'Please try:\n' +
                            '1. Re-saving the file as Excel (.xlsx) from your spreadsheet application\n' +
                            '2. If it\'s a CSV file, use the .csv extension instead\n' +
                            '3. Check that the file is not corrupted or password-protected'
                        ));
                    } else {
                        reject(new Error(`Failed to parse Excel file: ${msg}`));
                    }
                    return;
                }

                // Prefer "Commission Details" sheet for commission files, otherwise use first sheet
                let targetSheetName = workbook.SheetNames[0];
                const commissionDetailsSheet = workbook.SheetNames.find(name => 
                    name.toLowerCase().includes('commission') && name.toLowerCase().includes('detail')
                );
                if (commissionDetailsSheet) {
                    targetSheetName = commissionDetailsSheet;
                }
                
                const worksheet = workbook.Sheets[targetSheetName];

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

                // Scan first 20 rows to find the header row
                // For commission files, headers might be in row 1 (after a title row)
                let headerRowIndex = -1;
                let policyColumnIndex = -1;
                let policyColumnName = '';

                for (let i = 0; i < Math.min(rows.length, 20); i++) {
                    const row = rows[i];
                    // Ensure row is an array
                    if (!Array.isArray(row)) continue;

                    const possibleHeaders = row.map(cell => String(cell).trim()).filter(h => h);
                    const detectedColumn = detectPolicyNumberColumn(possibleHeaders);

                    if (detectedColumn) {
                        headerRowIndex = i;
                        policyColumnName = detectedColumn;
                        // Find index in original row (before filtering)
                        const originalHeaders = row.map(cell => String(cell).trim());
                        policyColumnIndex = originalHeaders.indexOf(detectedColumn);
                        break;
                    }
                }

                if (headerRowIndex === -1) {
                    // Try to provide helpful error message
                    const sampleHeaders = rows.slice(0, 5).map((row, idx) => {
                        if (!Array.isArray(row)) return `Row ${idx}: (not an array)`;
                        const headers = row.map(cell => String(cell).trim()).filter(h => h).slice(0, 10);
                        return `Row ${idx}: ${headers.join(', ')}`;
                    }).join('\n');
                    
                    reject(new Error(
                        'Could not detect policy number column. Please ensure your file has a column like "Policy Number" or "POLICYNUMBER".\n\n' +
                        'Scanned first 20 rows. Sample rows:\n' + sampleHeaders
                    ));
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

        // Validate file type before reading
        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls')) {
            reject(new Error(`Invalid file type. Expected .xlsx or .xls file, got: ${file.name}`));
            return;
        }

        // Read as ArrayBuffer for better compatibility with XLSX library
        reader.readAsArrayBuffer(file);
    });
}

/**
 * RNA (Royal Neighbors of America) Excel: "Certificates By Agent" layout.
 * File has repeated blocks: [Agent row] -> [Header row] -> [Data rows] -> next agent...
 * Agent row looks like "DTX6 - AHMAD ALI KHAN". Headers: Insured Name, Owner Name, Certificate Number, etc.
 */
export async function parseRNAExcel(file: File): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target?.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                const firstSheetName = workbook.SheetNames[0];
                const worksheet = workbook.Sheets[firstSheetName];
                const rows = XLSX.utils.sheet_to_json(worksheet, {
                    header: 1,
                    defval: '',
                    raw: false,
                }) as any[][];

                if (!rows?.length) {
                    reject(new Error('The RNA Excel file appears to be empty'));
                    return;
                }

                const records: ParsedRecord[] = [];
                const agentRowPattern = /^([A-Z0-9]+)\s*-\s*(.+)$/i;

                let i = 0;
                while (i < rows.length) {
                    const row = rows[i] as any[];
                    if (!Array.isArray(row)) { i++; continue; }
                    const cells = row.map(c => String(c ?? '').trim());

                    const agentCell = cells.find(c => agentRowPattern.test(c));
                    if (agentCell) {
                        const match = agentCell.match(agentRowPattern);
                        const agentId = match ? match[1].trim() : '';
                        const agentName = match ? match[2].trim() : agentCell;
                        i++;
                        if (i >= rows.length) break;
                        const headerRow = rows[i] as any[];
                        if (!Array.isArray(headerRow)) { i++; continue; }
                        const headers = headerRow.map((h: any) => String(h ?? '').trim());
                        const certNumIdx = headers.findIndex((h: string) => /certificate\s*number/i.test(h));
                        if (certNumIdx === -1) {
                            i++;
                            continue;
                        }
                        i++;
                        while (i < rows.length) {
                            const dataRow = rows[i] as any[];
                            if (!Array.isArray(dataRow)) { i++; break; }
                            const certNum = String(dataRow[certNumIdx] ?? '').trim();
                            const firstCell = String(dataRow[0] ?? '').trim();
                            if (firstCell && agentRowPattern.test(firstCell)) break;
                            if (!certNum) { i++; continue; }
                            const rowData: Record<string, any> = {
                                Agent_ID: agentId,
                                Agent_Name: agentName,
                            };
                            headers.forEach((header: string, idx: number) => {
                                if (header && idx < dataRow.length) rowData[header] = dataRow[idx];
                            });
                            records.push({ policyNumber: certNum, data: rowData });
                            i++;
                        }
                        continue;
                    }
                    i++;
                }

                resolve({
                    records,
                    totalRecords: records.length,
                    detectedPolicyColumn: 'Certificate Number',
                });
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = () => reject(new Error('Failed to read the RNA Excel file'));
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
