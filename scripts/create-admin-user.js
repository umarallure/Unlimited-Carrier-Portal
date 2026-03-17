/**
 * One-time script to create the admin user in Supabase Auth.
 * Run from project root: node scripts/create-admin-user.js
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

// Load .env.local (dotenv handles BOM, quotes, and edge cases)
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const email = 'admin@unlimitedinsurance.io';
const password = 'Asdf@123';

async function main() {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) {
    if (error.message && error.message.includes('already been registered')) {
      console.log('User', email, 'already exists. You can reset the password in Supabase Dashboard if needed.');
      return;
    }
    console.error('Error creating user:', error.message);
    process.exit(1);
  }
  console.log('Admin user created:', data.user?.email || email);
}

main();
