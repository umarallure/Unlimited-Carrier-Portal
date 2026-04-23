/**
 * Create a Carrier portal user in Supabase Auth (same project as admin-dashboard).
 *
 * Usage (prefer env so the password is not in shell history as argv):
 *   cd Carrier/admin-dashboard
 *   CARRIER_USER_EMAIL='you@example.com' CARRIER_USER_PASSWORD='your-password' node scripts/create-user.js
 *
 * Or: node scripts/create-user.js you@example.com
 * (password will be prompted if not set — not implemented; use env)
 *
 * Requires .env.local with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
const { createClient } = require('@supabase/supabase-js')
const path = require('path')

require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') })
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  require('dotenv').config({ path: path.join(process.cwd(), '.env.local') })
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

const emailFromEnv = process.env.CARRIER_USER_EMAIL
const passwordFromEnv = process.env.CARRIER_USER_PASSWORD

const emailArg = process.argv[2]
const passwordArg = process.argv[3]

const email = (emailFromEnv || emailArg || '').trim()
const password = passwordFromEnv != null ? String(passwordFromEnv) : passwordArg != null ? String(passwordArg) : ''

async function main() {
  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
    process.exit(1)
  }
  if (!email || !password) {
    console.error(
      'Set CARRIER_USER_EMAIL and CARRIER_USER_PASSWORD, or run: node scripts/create-user.js <email> <password>'
    )
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (error) {
    if (error.message && /already been registered|already exists|User already registered/i.test(error.message)) {
      console.log('User already exists:', email)
      process.exit(0)
    }
    console.error('Error creating user:', error.message)
    process.exit(1)
  }
  console.log('User created:', data.user?.email || email, '| id:', data.user?.id)
}

main()
