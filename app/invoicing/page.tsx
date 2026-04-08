'use client'

import { useState } from 'react'
import { Calendar, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/PageHeader'
import { createClient } from '@/lib/supabase/client'
import {
  buildInvoiceDraft,
  getPreviousChargebackByCallCenter,
  markInvoiceBatchPaid,
  type InvoiceDraftResult,
} from '@/lib/invoicing'

function formatMoney(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function InvoicingPage() {
  const supabase = createClient()
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState<InvoiceDraftResult | null>(null)
  const [overridesByPolicyKey, setOverridesByPolicyKey] = useState<Record<string, string>>({})
  const [previousChargebackByCallCenter, setPreviousChargebackByCallCenter] = useState<Record<string, string>>({})

  const groupBaseTotalAfterPreviousChargeback = (callCenter: string, baseTotal: number): number => {
    const raw = previousChargebackByCallCenter[callCenter] ?? '0'
    const previousChargeback = Number.parseFloat(raw)
    const deduction = Number.isNaN(previousChargeback) ? 0 : previousChargeback
    return baseTotal - deduction
  }

  const generateInvoice = async () => {
    if (!dateFrom || !dateTo) {
      alert('Please select both From and To dates.')
      return
    }
    if (new Date(dateFrom).getTime() > new Date(dateTo).getTime()) {
      alert('From date must be before or equal to To date.')
      return
    }

    setLoading(true)
    try {
      const result = await buildInvoiceDraft(dateFrom, dateTo)
      const previous = await getPreviousChargebackByCallCenter(result.groups.map((g) => g.callCenter))
      const previousText: Record<string, string> = {}
      for (const [k, v] of Object.entries(previous)) previousText[k] = String(v || 0)
      setDraft(result)
      setOverridesByPolicyKey({})
      setPreviousChargebackByCallCenter(previousText)
    } catch (error: any) {
      alert(error?.message || 'Failed to generate invoice draft.')
    } finally {
      setLoading(false)
    }
  }

  const markPaid = async () => {
    if (!draft || draft.groups.length === 0) return
    setSaving(true)
    try {
      const { data } = await supabase.auth.getUser()
      const numericOverrides: Record<string, number> = {}
      for (const [key, raw] of Object.entries(overridesByPolicyKey)) {
        if (!raw || raw.trim() === '') continue
        const parsed = Number.parseFloat(raw)
        if (!Number.isNaN(parsed)) numericOverrides[key] = parsed
      }
      const previousChargebacks: Record<string, number> = {}
      for (const [center, raw] of Object.entries(previousChargebackByCallCenter)) {
        const parsed = Number.parseFloat(raw)
        previousChargebacks[center] = Number.isNaN(parsed) ? 0 : parsed
      }

      const { batchId } = await markInvoiceBatchPaid({
        startDate: draft.startDate,
        endDate: draft.endDate,
        groups: draft.groups,
        overridesByPolicyKey: numericOverrides,
        previousChargebackByCallCenter: previousChargebacks,
        paidByEmail: data.user?.email || null,
      })
      alert(`Invoice batch marked as paid. Batch ID: ${batchId}`)
      setDraft(null)
      setOverridesByPolicyKey({})
      setPreviousChargebackByCallCenter({})
    } catch (error: any) {
      alert(error?.message || 'Failed to mark invoice as paid.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="admin-page space-y-6">
      <PageHeader
        title="Invoicing"
        description="Generate editable call-center invoice drafts from payment transactions, then persist invoicing status history on Paid."
        icon={<span className="text-xl font-bold text-orange-400">$</span>}
      />

      <Card>
        <CardHeader>
          <CardTitle>Invoice range</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-9 w-[180px]" />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</span>
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 shrink-0 text-orange-500" />
                <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-9 w-[180px]" />
              </div>
            </div>
            <Button onClick={generateInvoice} disabled={loading} className="bg-orange-500 text-black hover:bg-orange-400">
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                'Generate Invoice'
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {draft && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>
                Invoice draft ({draft.startDate} to {draft.endDate})
              </CardTitle>
            </CardHeader>
          </Card>

          {draft.groups.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-sm text-muted-foreground">No commission transactions found in this date range.</CardContent>
            </Card>
          ) : (
            draft.groups.map((group) => (
              <Card key={group.callCenter}>
                <CardHeader className="flex flex-row items-center justify-between">
                  <CardTitle>{group.callCenter}</CardTitle>
                  <div className="text-sm text-muted-foreground">
                    Policies: {group.policyCount} | Base total: ${formatMoney(groupBaseTotalAfterPreviousChargeback(group.callCenter, group.ccInvoiceTotal))}
                  </div>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="flex flex-wrap items-center justify-end gap-3 px-6 pb-3 pt-1">
                    <span className="text-xs text-muted-foreground">Previous chargeback amount</span>
                    <Input
                      value={previousChargebackByCallCenter[group.callCenter] ?? '0'}
                      onChange={(e) =>
                        setPreviousChargebackByCallCenter((prev) => ({
                          ...prev,
                          [group.callCenter]: e.target.value,
                        }))
                      }
                      className="h-9 w-[160px] text-right"
                    />
                  </div>
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Policy Name</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead>Commission Date</TableHead>
                          <TableHead>Latest Invoicing Status</TableHead>
                          <TableHead className="text-right">Base CC 50%</TableHead>
                          <TableHead className="text-right">Invoice Amount (Editable)</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {group.policies.map((policy) => (
                          <TableRow key={policy.policyKey}>
                            <TableCell>{policy.policyName}</TableCell>
                            <TableCell>{policy.carrier}</TableCell>
                            <TableCell>{policy.latestCommissionDate}</TableCell>
                            <TableCell>{policy.latestInvoicingStatus}</TableCell>
                            <TableCell className="text-right">${formatMoney(policy.ccNet)}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex justify-end">
                                <Input
                                  value={overridesByPolicyKey[policy.policyKey] ?? ''}
                                  placeholder={formatMoney(policy.ccNet)}
                                  onChange={(e) =>
                                    setOverridesByPolicyKey((prev) => ({
                                      ...prev,
                                      [policy.policyKey]: e.target.value,
                                    }))
                                  }
                                  className="h-9 w-[140px] text-right"
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            ))
          )}

          {draft.groups.length > 0 && (
            <div className="flex justify-end">
              <Button onClick={markPaid} disabled={saving} className="bg-green-600 text-white hover:bg-green-700">
                {saving ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  'Paid'
                )}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
