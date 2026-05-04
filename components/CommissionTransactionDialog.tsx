'use client'

import { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import type { AgencyCarrierOption } from '@/components/DealTrackerPolicyDialog'

export type CommissionTransactionForm = {
  id?: string
  agency_carrier_id: string
  policy_number: string
  name: string
  sales_agent: string
  date: string
  commission_rate: string
  advance_amount: string
  charge_back_amount: string
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  saving?: boolean
  mode: 'create' | 'edit'
  initialValue?: Partial<CommissionTransactionForm>
  agencyCarrierOptions: AgencyCarrierOption[]
  onSave: (value: CommissionTransactionForm) => Promise<void>
}

const emptyForm: CommissionTransactionForm = {
  agency_carrier_id: '',
  policy_number: '',
  name: '',
  sales_agent: '',
  date: '',
  commission_rate: '',
  advance_amount: '',
  charge_back_amount: '',
}

export function CommissionTransactionDialog({
  open,
  onOpenChange,
  saving = false,
  mode,
  initialValue,
  agencyCarrierOptions,
  onSave,
}: Props) {
  const [form, setForm] = useState<CommissionTransactionForm>(() => ({
    ...emptyForm,
    ...initialValue,
    id: initialValue?.id,
    agency_carrier_id: initialValue?.agency_carrier_id || '',
    policy_number: initialValue?.policy_number || '',
    name: initialValue?.name || '',
    sales_agent: initialValue?.sales_agent || '',
    date: initialValue?.date || '',
    commission_rate: initialValue?.commission_rate || '',
    advance_amount: initialValue?.advance_amount || '',
    charge_back_amount: initialValue?.charge_back_amount || '',
  }))
  const [error, setError] = useState<string | null>(null)

  const selectedAgencyCarrier = useMemo(
    () => agencyCarrierOptions.find((o) => o.id === form.agency_carrier_id),
    [agencyCarrierOptions, form.agency_carrier_id]
  )

  const handleSave = async () => {
    if (!form.agency_carrier_id) {
      setError('Agency and carrier are required.')
      return
    }
    if (!form.policy_number.trim()) {
      setError('Policy number is required.')
      return
    }
    if (!form.date.trim()) {
      setError('Date is required.')
      return
    }
    const adv = form.advance_amount.trim()
    const cb = form.charge_back_amount.trim()
    if (adv !== '' && Number.isNaN(Number.parseFloat(adv))) {
      setError('Advance amount must be a valid number.')
      return
    }
    if (cb !== '' && Number.isNaN(Number.parseFloat(cb))) {
      setError('Charge back amount must be a valid number.')
      return
    }
    setError(null)
    await onSave({
      ...form,
      policy_number: form.policy_number.trim(),
      name: form.name.trim(),
      sales_agent: form.sales_agent.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit commission' : 'Add commission'}</DialogTitle>
          <DialogDescription>
            Record a commission transaction directly in the commission tracker.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Agency + Carrier *</label>
            <Select
              value={form.agency_carrier_id || undefined}
              onValueChange={(v) => setForm((prev) => ({ ...prev, agency_carrier_id: v }))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select agency + carrier" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {agencyCarrierOptions.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    {opt.agencyName} - {opt.carrierName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Policy Number *</label>
            <Input
              value={form.policy_number}
              onChange={(e) => setForm((prev) => ({ ...prev, policy_number: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Date *</label>
            <Input
              type="date"
              value={form.date}
              onChange={(e) => setForm((prev) => ({ ...prev, date: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Name</label>
            <Input
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Sales Agent</label>
            <Input
              value={form.sales_agent}
              onChange={(e) => setForm((prev) => ({ ...prev, sales_agent: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Commission Rate</label>
            <Input
              type="number"
              step="0.01"
              value={form.commission_rate}
              onChange={(e) => setForm((prev) => ({ ...prev, commission_rate: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Advance</label>
            <Input
              type="number"
              step="0.01"
              value={form.advance_amount}
              onChange={(e) => setForm((prev) => ({ ...prev, advance_amount: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Charge Back</label>
            <Input
              type="number"
              step="0.01"
              value={form.charge_back_amount}
              onChange={(e) => setForm((prev) => ({ ...prev, charge_back_amount: e.target.value }))}
            />
          </div>
        </div>

        {selectedAgencyCarrier && (
          <p className="text-xs text-muted-foreground">
            Saving to: <span className="font-medium text-foreground">{selectedAgencyCarrier.agencyName}</span> /{' '}
            <span className="font-medium text-foreground">{selectedAgencyCarrier.carrierName}</span>
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving} className="bg-orange-600 text-white hover:bg-orange-700">
            {saving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : mode === 'edit' ? (
              'Save changes'
            ) : (
              'Add commission'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
