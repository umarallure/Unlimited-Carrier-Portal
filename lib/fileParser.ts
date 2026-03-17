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
 * Normalize Excel-style "formula" wrappers that appear in CSV exports, e.g.:
 *   ="0001129844" or =("0001129844")
 * so downstream logic just sees the plain textual value.
 */
function normalizeExcelWrappedString(value: any): any {
    if (typeof value !== 'string') return value;
    let s = value.trim();

    // Pattern 1: ="0001129844"
    if (s.startsWith('="') && s.endsWith('"')) {
        return s.slice(2, -1);
    }

    // Pattern 2: =("0001129844")
    if (s.startsWith('=("') && s.endsWith('")')) {
        return s.slice(3, -2);
    }

    return s;
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

                        const policyNumber = String(
                            normalizeExcelWrappedString(row[policyColumnIndex] || '')
                        ).trim();

                        if (policyNumber) {
                            // Map row data to header names
                            const rowData: Record<string, any> = {};
                            headers.forEach((header, index) => {
                                if (index < row.length) {
                                    let value = row[index];
                                    // Remove Excel-style wrappers like ="000" or =("000")
                                    value = normalizeExcelWrappedString(value);
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

                // Prefer a "Details" / "Commission Details" style sheet when present, otherwise use first sheet
                let targetSheetName = workbook.SheetNames[0];
                const lowerNames = workbook.SheetNames.map(name => name.toLowerCase());

                // 1) Exact / strong matches like "Commission Details"
                const strongIndex = lowerNames.findIndex(name =>
                    name.includes('commission') && name.includes('detail')
                );
                // 2) Any sheet that mentions "detail" / "details" (e.g. MOH "DETAILS" tab)
                const detailsIndex = lowerNames.findIndex(name =>
                    name.includes('detail')
                );

                if (strongIndex >= 0) {
                    targetSheetName = workbook.SheetNames[strongIndex];
                } else if (detailsIndex >= 0) {
                    targetSheetName = workbook.SheetNames[detailsIndex];
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
 * Parse RNA (Royal Neighbors of America) Commission Statement CSV.
 * File has sections: "ADVANCE Commission Statement" and "Earned Commission Statement" with different column layouts.
 * Each section has a header row then data rows until "Subtotals" or "Commission Summary".
 */
export async function parseRNACommissionCSV(file: File): Promise<ParseResult> {
    return new Promise((resolve, reject) => {
        Papa.parse(file, {
            header: false,
            skipEmptyLines: false,
            complete: (results: any) => {
                try {
                    const rows = results.data as string[][];
                    if (!rows?.length) {
                        reject(new Error('RNA commission file is empty'));
                        return;
                    }

                    const records: ParsedRecord[] = [];
                    let currentAgentName = '';
                    let currentAgentId = '';

                    function cellStr(row: any[], idx: number): string {
                        if (!row || idx >= row.length) return '';
                        return String(row[idx] ?? '').trim();
                    }

                    function findCellIndex(row: any[], pred: (v: string) => boolean): number {
                        if (!row) return -1;
                        for (let i = 0; i < row.length; i++) {
                            if (pred(cellStr(row, i))) return i;
                        }
                        return -1;
                    }

                    function parseCurrency(val: string): number | null {
                        if (val == null || String(val).trim() === '') return null;
                        const s = String(val).replace(/\$|,/g, '').trim();
                        const neg = /^\(.*\)$/.test(s);
                        const num = parseFloat(s.replace(/[()]/g, ''));
                        if (Number.isNaN(num)) return null;
                        return neg ? -num : num;
                    }

                    let i = 0;
                    while (i < rows.length) {
                        const row = rows[i];
                        const rowText = Array.isArray(row) ? row.map(c => String(c ?? '')).join(',') : '';

                        if (/Agent Earning Commission/i.test(rowText)) {
                            i++;
                            while (i < rows.length) {
                                const nextRow = rows[i];
                                if (!Array.isArray(nextRow)) { i++; continue; }
                                const first = cellStr(nextRow, 0);
                                const second = cellStr(nextRow, 1);
                                if (first && !/Commission Statement|Summary|Balance|Payment|Run Date|Period Ending/i.test(first)) {
                                    currentAgentName = first;
                                    currentAgentId = second || currentAgentId;
                                    i++;
                                    break;
                                }
                                i++;
                            }
                            continue;
                        }

                        if (/ADVANCE Commission Statement/i.test(rowText)) {
                            i++;
                            let headerRow: any[] | null = null;
                            while (i < rows.length) {
                                const r = rows[i];
                                if (Array.isArray(r) && r.some((c: any) => String(c ?? '').trim().length > 0)) {
                                    headerRow = r;
                                    i++;
                                    break;
                                }
                                i++;
                            }
                            if (!headerRow) continue;
                            const headers = headerRow.map((h: any) => String(h ?? '').trim());
                            const certIdx = headers.findIndex((h: string) => /^Certificate$/i.test(h));
                            const insuredIdx = headers.findIndex((h: string) => /Insured'?s? Name/i.test(h));
                            const prodIdx = headers.findIndex((h: string) => /Product ID/i.test(h));
                            const issueIdx = headers.findIndex((h: string) => /Issue Date/i.test(h));
                            const effIdx = headers.findIndex((h: string) => /Effective Date/i.test(h));
                            const modeIdx = headers.findIndex((h: string) => /^Mode$/i.test(h));
                            const descIdx = headers.findIndex((h: string) => /Description/i.test(h));
                            const premIdx = headers.findIndex((h: string) => /^Premium$/i.test(h));
                            const commPctIdx = headers.findIndex((h: string) => /Comm%|Comm %/i.test(h));
                            const advIdx = headers.findIndex((h: string) => /Advance Amount/i.test(h));

                            while (i < rows.length) {
                                const dataRow = rows[i];
                                if (!Array.isArray(dataRow)) { i++; break; }
                                const firstCell = cellStr(dataRow, 0);
                                if (/Subtotals|Commission Summary|ADVANCE Commission|Earned Commission|Agent Earning/i.test(firstCell)) break;
                                const rowHasSubtotals = dataRow.some((c: any) => /Subtotals for Agent/i.test(String(c ?? '')));
                                if (rowHasSubtotals) { i++; continue; }
                                const cert = certIdx >= 0 ? cellStr(dataRow, certIdx) : '';
                                if (!cert) { i++; continue; }

                                const rowData: Record<string, any> = {};
                                headers.forEach((h, idx) => { if (h && idx < dataRow.length) rowData[h] = dataRow[idx]; });
                                rowData['Agent_Name'] = currentAgentName;
                                rowData['Agent_ID'] = currentAgentId;
                                if (insuredIdx >= 0) rowData["Insured's Name"] = cellStr(dataRow, insuredIdx);
                                if (prodIdx >= 0) rowData['Product ID'] = cellStr(dataRow, prodIdx);
                                if (issueIdx >= 0) rowData['Issue Date'] = cellStr(dataRow, issueIdx);
                                if (effIdx >= 0) rowData['Effective Date'] = cellStr(dataRow, effIdx);
                                if (modeIdx >= 0) rowData['Mode'] = cellStr(dataRow, modeIdx);
                                if (descIdx >= 0) rowData['Description'] = cellStr(dataRow, descIdx);
                                const premVal = premIdx >= 0 ? cellStr(dataRow, premIdx) : '';
                                rowData['Premium'] = premVal ? parseCurrency(premVal) : null;
                                const commVal = commPctIdx >= 0 ? cellStr(dataRow, commPctIdx) : '';
                                rowData['Comm%'] = commVal ? parseCurrency(commVal) : null;
                                const advVal = advIdx >= 0 ? cellStr(dataRow, advIdx) : '';
                                rowData['Advance Amount'] = advVal ? parseCurrency(advVal) : null;
                                rowData['Earned'] = null;

                                records.push({ policyNumber: cert, data: rowData });
                                i++;
                            }
                            continue;
                        }

                        if (/Earned Commission Statement/i.test(rowText)) {
                            i++;
                            let headerRow: any[] | null = null;
                            while (i < rows.length) {
                                const r = rows[i];
                                if (Array.isArray(r) && r.some((c: any) => String(c ?? '').trim().length > 0)) {
                                    headerRow = r;
                                    i++;
                                    break;
                                }
                                i++;
                            }
                            if (!headerRow) continue;
                            const headers = headerRow.map((h: any) => String(h ?? '').trim());
                            const certIdx = headers.findIndex((h: string) => /^Certificate$/i.test(h));
                            const insuredIdx = headers.findIndex((h: string) => /Insured'?s? Name/i.test(h));
                            const prodIdx = headers.findIndex((h: string) => /Prod ID|Product ID/i.test(h));
                            const issueIdx = headers.findIndex((h: string) => /Issue Date/i.test(h));
                            const modeIdx = headers.findIndex((h: string) => /^Mode$/i.test(h));
                            const paidToIdx = headers.findIndex((h: string) => /Paid To Date/i.test(h));
                            const yrRnwlIdx = headers.findIndex((h: string) => /1st Yr Rnwl|1st Yr/i.test(h));
                            const splitIdx = headers.findIndex((h: string) => /Split %/i.test(h));
                            const premIdx = headers.findIndex((h: string) => /^Prem$/i.test(h));
                            const commPctIdx = headers.findIndex((h: string) => /Comm%|Comm %/i.test(h));
                            const earnedIdx = headers.findIndex((h: string) => /^Earned$/i.test(h));
                            const commentIdx = headers.findIndex((h: string) => /Comment/i.test(h));

                            while (i < rows.length) {
                                const dataRow = rows[i];
                                if (!Array.isArray(dataRow)) { i++; break; }
                                const firstCell = cellStr(dataRow, 0);
                                if (/Subtotals|Commission Summary|EARNED Commission|ADVANCE Commission|Agent Earning/i.test(firstCell)) break;
                                const rowHasSubtotals = dataRow.some((c: any) => /Subtotals for Agent/i.test(String(c ?? '')));
                                if (rowHasSubtotals) { i++; continue; }
                                const cert = certIdx >= 0 ? cellStr(dataRow, certIdx) : '';
                                if (!cert) { i++; continue; }

                                const rowData: Record<string, any> = {};
                                headers.forEach((h, idx) => { if (h && idx < dataRow.length) rowData[h] = dataRow[idx]; });
                                rowData['Agent_Name'] = currentAgentName;
                                rowData['Agent_ID'] = currentAgentId;
                                if (insuredIdx >= 0) rowData["Insured's Name"] = cellStr(dataRow, insuredIdx);
                                if (prodIdx >= 0) rowData['Product ID'] = cellStr(dataRow, prodIdx);
                                if (issueIdx >= 0) rowData['Issue Date'] = cellStr(dataRow, issueIdx);
                                if (modeIdx >= 0) rowData['Mode'] = cellStr(dataRow, modeIdx);
                                if (paidToIdx >= 0) rowData['Paid To Date'] = cellStr(dataRow, paidToIdx);
                                if (yrRnwlIdx >= 0) rowData['1st Yr Rnwl'] = cellStr(dataRow, yrRnwlIdx);
                                const splitVal = splitIdx >= 0 ? cellStr(dataRow, splitIdx) : '';
                                rowData['Split %'] = splitVal ? parseCurrency(splitVal) : null;
                                const premVal = premIdx >= 0 ? cellStr(dataRow, premIdx) : '';
                                rowData['Premium'] = premVal ? parseCurrency(premVal) : null;
                                const commVal = commPctIdx >= 0 ? cellStr(dataRow, commPctIdx) : '';
                                rowData['Comm%'] = commVal ? parseCurrency(commVal) : null;
                                const earnedVal = earnedIdx >= 0 ? cellStr(dataRow, earnedIdx) : '';
                                rowData['Earned'] = earnedVal ? parseCurrency(earnedVal) : null;
                                rowData['Advance Amount'] = null;
                                if (commentIdx >= 0) rowData['Comment'] = cellStr(dataRow, commentIdx);

                                records.push({ policyNumber: cert, data: rowData });
                                i++;
                            }
                            continue;
                        }

                        i++;
                    }

                    resolve({
                        records,
                        totalRecords: records.length,
                        detectedPolicyColumn: 'Certificate',
                    });
                } catch (err) {
                    reject(err);
                }
            },
            error: (err: any) => reject(err),
        });
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
