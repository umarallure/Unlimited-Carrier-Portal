import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

function getAdminClient() {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}

export async function GET() {
  const supabase = getAdminClient()
  const { data, error } = await supabase.auth.admin.listUsers()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data.users)
}

export async function PATCH(request: NextRequest) {
  const body = await request.json()
  const { userId, action, value } = body

  if (!userId || !action) {
    return NextResponse.json({ error: 'Missing userId or action' }, { status: 400 })
  }

  const supabase = getAdminClient()

  switch (action) {
    case 'ban': {
      const { data, error } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: value || '876000h',
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json(data.user)
    }

    case 'unban': {
      const { data, error } = await supabase.auth.admin.updateUserById(userId, {
        ban_duration: '0h',
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json(data.user)
    }

    case 'set-role': {
      const { data, error } = await supabase.auth.admin.updateUserById(userId, {
        app_metadata: { role: value || 'user' },
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json(data.user)
    }

    case 'set-password': {
      if (!value || value.length < 6) {
        return NextResponse.json({ error: 'Password must be at least 6 characters' }, { status: 400 })
      }
      const { data, error } = await supabase.auth.admin.updateUserById(userId, {
        password: value,
      })
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      return NextResponse.json(data.user)
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
  }
}
