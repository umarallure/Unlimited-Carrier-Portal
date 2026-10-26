/**
 * The deals behind one cycle's escrow.
 *
 * Pure — no Supabase, no React — so the matching can be unit tested. The page
 * fetches the three sources and passes them in.
 *
 * AN HONEST CAVEAT, WHICH THE PAGE REPEATS
 *   A percentage holdback is not attributable to particular policies. It is a
 *   slice of everything the center earned that cycle, so the right answer to
 *   "which deals are being held" is "a share of all of them".
 *
 *   Two things ARE deal-specific and are marked as such:
 *     - earlier uninvoiced commissions moved into escrow (an opening transfer),
 *       which are named policies by definition
 *     - deals parked by hand in the work chest before the software existed
 *
 *   So a deal is flagged `held` only when something actually says so. Everything
 *   else is shown as what the holdback was calculated from, not as held.
 */

export type EscrowDealSource = 'work_chest' | 'opening_transfer' | 'cycle_line'

export type EscrowPolicyLine = {
  batch_id: string
  call_center: string
  agency_carrier_id: string | null
  carrier: string | null
  policy_number: string
  gross_amount: number | string | null
  final_cc_amount: number | string | null
  latest_invoicing_status: string | null
}

export type EscrowWorkChestDeal = {
  call_center: string
  policy_number: string
  customer_name: string | null
  carrier: string | null
  commission_date: string | null
  center_amount: number | string | null
  released_batch_id: string | null
}

export type EscrowDealRow = {
  policyNumber: string
  customerName: string | null
  carrier: string | null
  commissionDate: string | null
  /** The center's 50% share for this policy. */
  centerAmount: number
  status: string | null
  /** True only when this specific deal was held, not merely part of the cycle. */
  held: boolean
  source: EscrowDealSource
}

export type EscrowCenterDetail = {
  callCenter: string
  deals: EscrowDealRow[]
  /** Deals explicitly held, and their total. */
  heldCount: number
  heldTotal: number
  /** Everything invoiced for this center in the cycle. */
  cycleTotal: number
  /**
   * True when the amount in escrow is a share of the cycle rather than a set of
   * named deals, so the page can say so instead of implying the list is the
   * holdback.
   */
  holdIsProportional: boolean
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''))
  return Number.isFinite(n) ? n : 0
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Same normalisation the rest of the app uses: uppercase, punctuation stripped,
 * and leading zeros dropped for all-numeric numbers, because the carriers pad
 * inconsistently and `0057214790` and `57214790` are one policy.
 */
export function policyMatchKey(value: unknown): string {
  const upper = String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[0-9]+$/.test(upper) ? upper.replace(/^0+/, '') || '0' : upper
}

/** The route segment for a cycle: `2026-09-30_2026-10-13`, or `unassigned`. */
export function cycleRouteKey(start: string | null, end: string | null): string {
  return start && end ? `${start}_${end}` : 'unassigned'
}

export function parseCycleRouteKey(key: string): { start: string | null; end: string | null } {
  const match = String(key ?? '').match(/^(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})$/)
  return match ? { start: match[1], end: match[2] } : { start: null, end: null }
}

/**
 * Merge the three sources into one list per center.
 *
 * A work-chest deal wins over the matching policy line, because it carries the
 * customer name and the date the carrier actually paid, which the policy line
 * does not. A work-chest deal with no matching line is still listed, so money
 * held by hand cannot vanish just because the line was never invoiced.
 */
export function buildCenterDetails(input: {
  policyLines: EscrowPolicyLine[]
  workChestDeals: EscrowWorkChestDeal[]
  /** Policy match key -> insured name, from deal_tracker. */
  namesByPolicy?: Map<string, string>
  /** Center -> the escrow that posted, so the page knows how to describe it. */
  escrowByCenter?: Map<string, { openingTransfer: number; hold: number }>
}): EscrowCenterDetail[] {
  const { policyLines, workChestDeals, namesByPolicy, escrowByCenter } = input
  const centers = new Map<string, Map<string, EscrowDealRow>>()

  const bucket = (callCenter: string) => {
    let found = centers.get(callCenter)
    if (!found) {
      found = new Map()
      centers.set(callCenter, found)
    }
    return found
  }

  for (const line of policyLines) {
    const key = policyMatchKey(line.policy_number)
    if (!key) continue
    bucket(line.call_center).set(key, {
      policyNumber: line.policy_number,
      customerName: namesByPolicy?.get(key) ?? null,
      carrier: line.carrier,
      commissionDate: null,
      centerAmount: round2(num(line.final_cc_amount)),
      status: line.latest_invoicing_status,
      held: false,
      source: 'cycle_line',
    })
  }

  for (const deal of workChestDeals) {
    const key = policyMatchKey(deal.policy_number)
    if (!key) continue
    const target = bucket(deal.call_center)
    const existing = target.get(key)
    target.set(key, {
      policyNumber: deal.policy_number,
      // The work chest recorded who the policy belongs to; a policy line does not.
      customerName: deal.customer_name ?? existing?.customerName ?? namesByPolicy?.get(key) ?? null,
      carrier: deal.carrier ?? existing?.carrier ?? null,
      commissionDate: deal.commission_date ?? null,
      centerAmount: round2(num(deal.center_amount) || existing?.centerAmount || 0),
      status: existing?.status ?? null,
      held: true,
      source: 'work_chest',
    })
  }

  return Array.from(centers.entries())
    .map(([callCenter, byPolicy]) => {
      const deals = Array.from(byPolicy.values()).sort(
        (a, b) =>
          Number(b.held) - Number(a.held) ||
          b.centerAmount - a.centerAmount ||
          a.policyNumber.localeCompare(b.policyNumber),
      )
      const heldDeals = deals.filter((d) => d.held)
      const escrow = escrowByCenter?.get(callCenter)
      return {
        callCenter,
        deals,
        heldCount: heldDeals.length,
        heldTotal: round2(heldDeals.reduce((sum, d) => sum + d.centerAmount, 0)),
        cycleTotal: round2(deals.reduce((sum, d) => sum + d.centerAmount, 0)),
        // A holdback with no deals named behind it is a share of the cycle.
        holdIsProportional: heldDeals.length === 0 && (escrow?.hold ?? 0) > 0,
      }
    })
    .sort((a, b) => b.heldTotal - a.heldTotal || a.callCenter.localeCompare(b.callCenter))
}

export const ESCROW_DETAIL_HEADERS = [
  'Cycle',
  'Call Center',
  'Policy Number',
  'Customer',
  'Carrier',
  'Commission Received',
  'Center Share',
  'Status',
  'Specifically Held',
] as const

export function centerDetailsToCsv(details: EscrowCenterDetail[], cycleLabel: string): string {
  const escape = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)
  const lines = [ESCROW_DETAIL_HEADERS.join(',')]
  for (const center of details) {
    for (const deal of center.deals) {
      lines.push(
        [
          cycleLabel,
          center.callCenter,
          deal.policyNumber,
          deal.customerName ?? '',
          deal.carrier ?? '',
          deal.commissionDate ?? '',
          deal.centerAmount.toFixed(2),
          deal.status ?? '',
          deal.held ? 'Yes' : 'No',
        ]
          .map((v) => escape(String(v)))
          .join(','),
      )
    }
  }
  return lines.join('\r\n')
}
