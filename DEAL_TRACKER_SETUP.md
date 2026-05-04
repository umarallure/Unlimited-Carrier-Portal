# Deal Tracker Setup Guide

This guide explains how to set up the Deal Tracker system for standardizing deals across all carriers.

## Overview

The Deal Tracker system creates a standardized view of all deals from different carriers by:
1. Mapping carrier-specific data to a common format
2. Fetching additional information from the `daily_deal_flow` table in an external Supabase database
3. Providing a verification interface for human review before saving

## Prerequisitesh

1. Run the database migration: `supabase_deal_tracker.sql`
2. Set up external Supabase credentials for `daily_deal_flow` access
3. Load carrier status mappings from CSV

## Step 1: Run Database Migration

Execute the SQL migration file to create the necessary tables:

```sql
-- Run this file in your Supabase SQL editor
supabase_deal_tracker.sql
```

This creates:
- `deal_tracker` table - Main table for standardized deals
- `carrier_status_mapping` table - Maps carrier-specific statuses to standardized statuses

**Important**: The `carrier_status_mapping` table uses `carrier_code` (e.g., "AETNA") for matching with your app's carrier codes, not the carrier name. This ensures reliable matching regardless of how the carrier name is formatted in the CSV.

## Step 2: Configure External Supabase Credentials

The Deal Tracker needs to access the `daily_deal_flow` table from another Supabase database to fetch call center and phone number information.

Add these environment variables to your `.env.local` file:

```env
NEXT_PUBLIC_EXTERNAL_SUPABASE_URL=https://your-external-supabase-url.supabase.co
NEXT_PUBLIC_EXTERNAL_SUPABASE_ANON_KEY=your-external-supabase-anon-key
```

**Note:** You mentioned you have the credentials for the other Supabase. Please add them to your `.env.local` file.

## Step 3: Load Status Mappings

Load the carrier status mappings from the CSV file:

```bash
node scripts/load-status-mappings.js
```

Or manually insert the mappings using the SQL in `supabase_deal_tracker.sql` (Aetna mappings are already included).

## Step 4: Test the System

1. Upload an Aetna Policy file through the upload interface
2. After upload, a verification dialog should appear showing all deal tracker entries
3. Review the entries and click "Confirm & Save" to write them to the database

## How It Works

### When Uploading Aetna Policy Files

1. **File Upload**: The file is uploaded and processed as usual into `aetna_policies` table
2. **Deal Tracker Processing**: 
   - Fetches policies from the uploaded file
   - Matches with commissions from `aetna_commissions` table by policy number
   - Maps policy status using `carrier_status_mapping` table
   - Fetches call center and phone number from external `daily_deal_flow` table (only once per policy)
   - Calculates deal value and CC value
3. **Verification Dialog**: Shows all entries for human review
4. **Save**: After confirmation, entries are saved to `deal_tracker` table

### Data Mapping (Aetna)

| Deal Tracker Column | Source |
|---------------------|--------|
| Name | `aetna_policies.insuredname` |
| Policy Status | `aetna_policies.statusdisplaytext` → mapped via `carrier_status_mapping` using `carrier.code` (e.g., "AETNA") |
| Deal Creation Date | `aetna_policies.issuedate` |
| Policy Number | `aetna_policies.policy_number` |
| Carrier | From `carriers` table (AETNA) |
| Deal Value | `aetna_commissions.commissionamount` (matched by policy_number) |
| CC Value | Deal Value / 2 |
| Sales Agent | `aetna_commissions.writingagentname` |
| Writing # | `aetna_commissions.writingagentnumber` |
| Call Center | `daily_deal_flow.lead_vendor` (external DB, matched by insured_name + carrier name) |
| Phone Number | `daily_deal_flow.client_phone_number` (external DB, matched by insured_name + carrier name) |

**Note**: Status mapping uses `carrier.code` (e.g., "AETNA") for reliable matching, while daily_deal_flow lookup uses `carrier.name` since that table stores carrier names.

### Daily Deal Flow Lookup

The system searches the external `daily_deal_flow` table using:
- `insured_name` (from policy) - case-insensitive partial match
- `carrier` - exact match

It fetches:
- `lead_vendor` → Call Center
- `client_phone_number` → Phone Number

**Important**: This lookup happens only once per policy. Once fetched, the `daily_deal_flow_fetched` flag is set to `true` and the data is stored in the `deal_tracker` table.

## Importing existing Aetna deals from CSV

If you have a CSV export of Aetna deals (e.g. from GHL or a spreadsheet) with columns matching the deal tracker (Name, Policy Number, Carrier, Deal Value, Sales Agent, Call Center, etc.), you can bulk-import into `deal_tracker`:

1. **Prerequisites**: `.env.local` with Supabase credentials. At least one **Aetna** agency_carrier must exist (create it in the app if needed).

2. **Run the import script** from the `admin-dashboard` folder:
   ```bash
   node scripts/import-aetna-deals-csv.js "D:\path\to\deals_aetna.xlsx.csv"
   ```

3. **If you have multiple Aetna agency_carriers**, the script will list their IDs and exit. Set the one you want and run again:
   ```bash
   set AGENCY_CARRIER_ID=<uuid-from-list>
   node scripts/import-aetna-deals-csv.js "D:\path\to\deals_aetna.xlsx.csv"
   ```
   (On macOS/Linux use `export AGENCY_CARRIER_ID=...`.)

4. Rows are **upserted** by `(agency_carrier_id, policy_number)`, so re-running with the same CSV updates existing rows. Rows without a Policy Number are skipped.

## Viewing Deal Tracker Entries

Navigate to `/deal-tracker` to view all standardized deals with filtering and search capabilities.

## Adding More Carriers

To add support for other carriers:

1. Add status mappings to `carrier_status_mapping` table
2. Create a processing function similar to `processAetnaFilesForDealTracker` in `lib/dealTracker.ts`
3. Update `processDealTrackerAfterUpload` in `lib/dealTrackerUpload.ts` to handle the new carrier
4. Update the upload flow to trigger deal tracker processing for the new carrier

## Troubleshooting

### Verification Dialog Not Appearing

- Check that you're uploading an Aetna Policy file (not Commission)
- Check browser console for errors
- Verify external Supabase credentials are set correctly

### Daily Deal Flow Lookup Failing

- Verify external Supabase credentials in `.env.local`
- Check that the external database has the `daily_deal_flow` table
- Verify network connectivity to external Supabase

### Status Mapping Not Working

- Run `scripts/load-status-mappings.js` to ensure all mappings are loaded
- Check `carrier_status_mapping` table for the carrier and status combination
- If no mapping exists, the original carrier status will be used

## Database Schema

See `supabase_deal_tracker.sql` for the complete schema definition.

Key tables:
- `deal_tracker` - Main standardized deals table
- `carrier_status_mapping` - Maps carrier statuses to standardized statuses
