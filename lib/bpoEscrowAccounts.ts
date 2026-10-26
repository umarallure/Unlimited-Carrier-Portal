/**
 * BPO Escrow — settings, accounts and balances.
 *
 * This is the database half of the feature. The money logic lives in
 * `lib/bpoEscrow.ts`, which imports nothing and is unit tested on its own; this
 * module loads what that calculation needs and provides the CRUD the Escrow
 * Settings page uses. Tables are created by `bpo_escrow.sql`.
 *
 * FAILS TO OFF. `fetchEscrowContext` returns a disabled context when the read
 * errors, rather than throwing. That is the opposite of `fetchExceptionIndex` in
 * lib/policyExceptions.ts, and for the same underlying reason: choose the
 * direction that cannot move money. A missing exception list could silently
 * overwrite protected policies, so it fails closed; a missing escrow setting can
 * only ever withhold money that should have been paid, so it fails off and the
 * invoice behaves exactly as it did before escrow existed.
 */

import { supabase } from './supabaseClient'
import { normalizeCallCenterName } from './invoicing'
import {
  ESCROW_DEFAULT_CAP,
  ESCROW_DEFAULT_HOLD_RATE,
  ESCROW_DEFAULT_POST_DRAW_HOLD_RATE,
  type EscrowAccountState,
  type EscrowSettings,
} from './bpoEscrow'

export const ESCROW_SETTINGS_TABLE = 'bpo_escrow_settings'
export const ESCROW_ACCOUNTS_TABLE = 'bpo_escrow_accounts'
export const ESCROW_LEDGER_TABLE = 'bpo_escrow_ledger'
export const ESCROW_BALANCES_VIEW = 'bpo_escrow_balances'

export interface EscrowGlobalSettingsRow {
  id: number
  enabled: boolean
  cap_amount: number | string
  hold_rate: number | string
  post_draw_hold_rate: number | string
  updated_by_email: string | null
  updated_at: string
}

export interface EscrowAccountRow {
  id: string
  call_center: string
  exempt: boolean
  cap_amount_override: number | string | null
  hold_rate_override: number | string | null
  opening_balance: number | string
  pre_draw_balance: number | string | null
  /** 'preview' shows the split without withholding; 'live' actually reduces the payout. */
  mode: 'preview' | 'live'
  status: 'active' | 'ended'
  start_date: string | null
  end_date: string | null
  notes: string | null
  created_by_email: string | null
  updated_by_email: string | null
  created_at: string
  updated_at: string
}

export interface EscrowBalanceRow {
  account_id: string
  call_center: string
  opening_balance: number | string
  ledger_movement: number | string
  balance: number | string
  pre_draw_balance: number | string | null
  exempt: boolean
  status: 'active' | 'ended'
  last_entry_at: string | null
}

/** Everything the invoice screen needs to compute escrow for every center. */
export interface EscrowContext {
  enabled: boolean
  /** Why escrow is off, when it is off for a reason worth telling the user. */
  unavailableReason: string | null
  globalCapAmount: number
  globalHoldRate: number
  globalPostDrawHoldRate: number
  /** Keyed by canonical call-center name. */
  accounts: Map<string, EscrowAccountRow>
  balances: Map<string, EscrowBalanceRow>
}

export const DISABLED_ESCROW_CONTEXT: EscrowContext = {
  enabled: false,
  unavailableReason: null,
  globalCapAmount: ESCROW_DEFAULT_CAP,
  globalHoldRate: ESCROW_DEFAULT_HOLD_RATE,
  globalPostDrawHoldRate: ESCROW_DEFAULT_POST_DRAW_HOLD_RATE,
  accounts: new Map(),
  balances: new Map(),
}

function toNumber(value: unknown, fallback: number): number {
  if (value == null || value === '') return fallback
  const num = typeof value === 'number' ? value : Number.parseFloat(String(value))
  return Number.isFinite(num) ? num : fallback
}

function disabledContext(reason: string | null): EscrowContext {
  return { ...DISABLED_ESCROW_CONTEXT, unavailableReason: reason, accounts: new Map(), balances: new Map() }
}

/**
 * Load the switch, the per-center settings and the current balances in one go.
 *
 * Never throws. A missing table (the SQL has not been run yet) or an RLS problem
 * comes back as a disabled context with a reason to show the user, so invoicing
 * carries on untouched.
 */
export async function fetchEscrowContext(): Promise<EscrowContext> {
  const settingsResult = await supabase
    .from(ESCROW_SETTINGS_TABLE)
    .select('*')
    .eq('id', 1)
    .maybeSingle()

  if (settingsResult.error) {
    return disabledContext(`Escrow settings could not be read, so escrow is off: ${settingsResult.error.message}`)
  }

  const settings = settingsResult.data as EscrowGlobalSettingsRow | null
  if (!settings) {
    return disabledContext('Escrow has not been set up yet (no settings row). Run bpo_escrow.sql.')
  }

  const globalCapAmount = toNumber(settings.cap_amount, ESCROW_DEFAULT_CAP)
  const globalHoldRate = toNumber(settings.hold_rate, ESCROW_DEFAULT_HOLD_RATE)
  const globalPostDrawHoldRate = toNumber(settings.post_draw_hold_rate, ESCROW_DEFAULT_POST_DRAW_HOLD_RATE)

  if (!settings.enabled) {
    return {
      ...disabledContext(null),
      globalCapAmount,
      globalHoldRate,
      globalPostDrawHoldRate,
    }
  }

  const [accountsResult, balancesResult] = await Promise.all([
    supabase.from(ESCROW_ACCOUNTS_TABLE).select('*'),
    supabase.from(ESCROW_BALANCES_VIEW).select('*'),
  ])

  if (accountsResult.error) {
    return disabledContext(`Escrow accounts could not be read, so escrow is off: ${accountsResult.error.message}`)
  }

  const accounts = new Map<string, EscrowAccountRow>()
  for (const row of (accountsResult.data as EscrowAccountRow[]) || []) {
    accounts.set(normalizeCallCenterName(row.call_center), row)
  }

  const balances = new Map<string, EscrowBalanceRow>()
  // A balances failure is not fatal: opening_balance on the account is enough to
  // compute the cycle, and the ledger is empty in Phase 1 anyway.
  for (const row of (balancesResult.data as EscrowBalanceRow[]) || []) {
    balances.set(normalizeCallCenterName(row.call_center), row)
  }

  return {
    enabled: true,
    unavailableReason: null,
    globalCapAmount,
    globalHoldRate,
    globalPostDrawHoldRate,
    accounts,
    balances,
  }
}

/**
 * The settings to apply to one center. A center with no account row uses the
 * global defaults and is not exempt, so what the invoice shows is real rather
 * than silently opt-in.
 */
export function settingsForCallCenter(context: EscrowContext, callCenter: string): EscrowSettings {
  const key = normalizeCallCenterName(callCenter)
  const account = context.accounts.get(key)
  return {
    enabled: context.enabled,
    exempt: Boolean(account?.exempt) || account?.status === 'ended',
    capAmount: toNumber(account?.cap_amount_override, context.globalCapAmount),
    holdRate: toNumber(account?.hold_rate_override, context.globalHoldRate),
    postDrawHoldRate: context.globalPostDrawHoldRate,
  }
}

/**
 * Current escrow position for one center. Zeroes when the center has no account.
 *
 * `negativeBalance` is passed in rather than stored here on purpose. What a
 * center owes us is invoicing_call_center_ledger.ending_chargeback_amount,
 * carried forward onto the invoice screen where it can be edited; holding a
 * second copy against the escrow account would be a double count waiting to
 * happen.
 */
export function accountStateForCallCenter(
  context: EscrowContext,
  callCenter: string,
  negativeBalance = 0
): EscrowAccountState {
  const key = normalizeCallCenterName(callCenter)
  const account = context.accounts.get(key)
  const balance = context.balances.get(key)
  return {
    balance: toNumber(balance?.balance, toNumber(account?.opening_balance, 0)),
    preDrawBalance:
      account?.pre_draw_balance == null ? null : toNumber(account.pre_draw_balance, 0),
    negativeBalance: Math.max(0, negativeBalance),
  }
}

/**
 * Whether a center's holdback actually reduces what it is paid.
 *
 * A center with no account, or one still in preview, is paid in full and the
 * split is shown for checking only. Nothing goes live by accident.
 */
export function escrowModeForCallCenter(context: EscrowContext, callCenter: string): 'preview' | 'live' {
  if (!context.enabled) return 'preview'
  const account = context.accounts.get(normalizeCallCenterName(callCenter))
  if (!account || account.exempt || account.status === 'ended') return 'preview'
  return account.mode === 'live' ? 'live' : 'preview'
}

/**
 * True when a center's name is not in the canonical alias list, so it is being
 * used verbatim. Two spellings of the same center would then get two accounts,
 * two caps and twice the money held, which is worth warning about on screen.
 */
export function isUnrecognisedCallCenter(callCenter: string): boolean {
  const raw = String(callCenter ?? '').trim()
  if (!raw || raw === 'Unassigned') return false
  return normalizeCallCenterName(raw) === raw
}

// --- Management (Escrow Settings page) ---------------------------------------

export async function loadGlobalSettings(): Promise<EscrowGlobalSettingsRow | null> {
  const { data, error } = await supabase.from(ESCROW_SETTINGS_TABLE).select('*').eq('id', 1).maybeSingle()
  if (error) throw new Error(`Failed to load escrow settings: ${error.message}`)
  return (data as EscrowGlobalSettingsRow) ?? null
}

export async function saveGlobalSettings(input: {
  enabled: boolean
  capAmount: number
  holdRate: number
  postDrawHoldRate: number
}): Promise<void> {
  const { data: auth } = await supabase.auth.getUser()
  const { error } = await supabase
    .from(ESCROW_SETTINGS_TABLE)
    .update({
      enabled: input.enabled,
      cap_amount: input.capAmount,
      hold_rate: input.holdRate,
      post_draw_hold_rate: input.postDrawHoldRate,
      updated_by_email: auth?.user?.email ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', 1)
  if (error) throw new Error(`Failed to save escrow settings: ${error.message}`)
}

export async function listEscrowAccounts(): Promise<EscrowAccountRow[]> {
  const { data, error } = await supabase.from(ESCROW_ACCOUNTS_TABLE).select('*').order('call_center')
  if (error) throw new Error(`Failed to load escrow accounts: ${error.message}`)
  return (data as EscrowAccountRow[]) || []
}

export async function listEscrowBalances(): Promise<EscrowBalanceRow[]> {
  const { data, error } = await supabase.from(ESCROW_BALANCES_VIEW).select('*').order('call_center')
  if (error) throw new Error(`Failed to load escrow balances: ${error.message}`)
  return (data as EscrowBalanceRow[]) || []
}

export async function saveEscrowAccount(input: {
  callCenter: string
  exempt: boolean
  capAmountOverride: number | null
  holdRateOverride: number | null
  openingBalance: number
  mode: 'preview' | 'live'
  status: 'active' | 'ended'
  notes: string | null
}): Promise<void> {
  const callCenter = normalizeCallCenterName(input.callCenter)
  if (!callCenter || callCenter === 'Unassigned') {
    throw new Error('Pick a call center before saving an escrow account.')
  }
  const { data: auth } = await supabase.auth.getUser()
  const { error } = await supabase.from(ESCROW_ACCOUNTS_TABLE).upsert(
    {
      call_center: callCenter,
      exempt: input.exempt,
      cap_amount_override: input.capAmountOverride,
      hold_rate_override: input.holdRateOverride,
      opening_balance: input.openingBalance,
      mode: input.mode,
      status: input.status,
      notes: input.notes,
      created_by_email: auth?.user?.email ?? null,
      updated_by_email: auth?.user?.email ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'call_center' }
  )
  if (error) throw new Error(`Failed to save the escrow account for ${callCenter}: ${error.message}`)
}

export async function deleteEscrowAccount(id: string): Promise<void> {
  const { error } = await supabase.from(ESCROW_ACCOUNTS_TABLE).delete().eq('id', id)
  if (error) throw new Error(`Failed to remove the escrow account: ${error.message}`)
}
