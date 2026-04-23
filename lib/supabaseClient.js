
import { createBrowserClient } from '@supabase/ssr'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

let client = globalThis.__legacySupabaseClient

if (!client) {
  client = createBrowserClient(supabaseUrl, supabaseAnonKey)
  globalThis.__legacySupabaseClient = client
}

export const supabase = client
