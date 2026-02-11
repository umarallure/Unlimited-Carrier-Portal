
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing environment variables');
    process.exit(1);
}

const tableToCheck = 'policy_records';

console.log('--- DIAGNOSTIC START ---');
console.log(`Checking Project: ${supabaseUrl}`);

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkDatabase() {
    try {
        // 1. Check uploaded_files
        console.log('1. Checking uploaded_files table...');
        const { data: files, error: filesError } = await supabase
            .from('uploaded_files')
            .select('count', { count: 'exact', head: true });

        if (filesError) {
            console.log(`❌ uploaded_files table check FAILED: ${filesError.message}`);
        } else {
            console.log('✅ uploaded_files table EXISTS.');
        }

        // 2. Check policy_records
        console.log('2. Checking policy_records table...');
        const { data: policies, error: policiesError } = await supabase
            .from('policy_records')
            .select('count', { count: 'exact', head: true });

        if (policiesError) {
            console.log(`❌ policy_records table check FAILED: ${policiesError.message}`);
        } else {
            console.log('✅ policy_records table EXISTS.');
        }

    } catch (err) {
        console.error('❌ Unexpected script error:', err);
    } finally {
        console.log('--- DIAGNOSTIC END ---');
    }
}

checkDatabase();
