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

export type DealTrackerPolicyForm = {
  id?: string
  agency_carrier_id: string
  policy_number: string
  name: string
  policy_status: string
  deal_value: string
  sales_agent: string
  writing_number: string
  call_center: string
  phone_number: string
  deal_creation_date: string
  effective_date: string
  ghl_stage: string
  notes: string
}

export type AgencyCarrierOption = {
  id: string
  agencyName: string
  carrierName: string
  carrierId: string | null
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  saving?: boolean
  mode: 'create' | 'edit'
  initialValue?: Partial<DealTrackerPolicyForm>
  agencyCarrierOptions: AgencyCarrierOption[]
  onSave: (value: DealTrackerPolicyForm) => Promise<void>
}

const emptyForm: DealTrackerPolicyForm = {
  agency_carrier_id: '',
  policy_number: '',
  name: '',
  policy_status: '',
  deal_value: '',
  sales_agent: '',
  writing_number: '',
  call_center: '',
  phone_number: '',
  deal_creation_date: '',
  effective_date: '',
  ghl_stage: '',
  notes: '',
}

export function DealTrackerPolicyDialog({
  open,
  onOpenChange,
  saving = false,
  mode,
  initialValue,
  agencyCarrierOptions,
  onSave,
}: Props) {
  const [form, setForm] = useState<DealTrackerPolicyForm>(() => ({
    ...emptyForm,
    ...initialValue,
    id: initialValue?.id,
    agency_carrier_id: initialValue?.agency_carrier_id || '',
    policy_number: initialValue?.policy_number || '',
    name: initialValue?.name || '',
    policy_status: initialValue?.policy_status || '',
    deal_value: initialValue?.deal_value || '',
    sales_agent: initialValue?.sales_agent || '',
    writing_number: initialValue?.writing_number || '',
    call_center: initialValue?.call_center || '',
    phone_number: initialValue?.phone_number || '',
    deal_creation_date: initialValue?.deal_creation_date || '',
    effective_date: initialValue?.effective_date || '',
    ghl_stage: initialValue?.ghl_stage || '',
    notes: initialValue?.notes || '',
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
    setError(null)
    await onSave({ ...form, policy_number: form.policy_number.trim() })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'edit' ? 'Edit policy' : 'Add policy'}</DialogTitle>
          <DialogDescription>
            Update a Deal Tracker policy directly from the report.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Agency + Carrier</label>
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
            <label className="mb-1 block text-xs text-muted-foreground">Name</label>
            <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Policy Status</label>
            <Input
              value={form.policy_status}
              onChange={(e) => setForm((prev) => ({ ...prev, policy_status: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">GHL Stage</label>
            <Input
              value={form.ghl_stage}
              onChange={(e) => setForm((prev) => ({ ...prev, ghl_stage: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Deal Value</label>
            <Input
              type="number"
              step="0.01"
              value={form.deal_value}
              onChange={(e) => setForm((prev) => ({ ...prev, deal_value: e.target.value }))}
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
            <label className="mb-1 block text-xs text-muted-foreground">Writing Number</label>
            <Input
              value={form.writing_number}
              onChange={(e) => setForm((prev) => ({ ...prev, writing_number: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Call Center</label>
            <Input
              value={form.call_center}
              onChange={(e) => setForm((prev) => ({ ...prev, call_center: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Phone Number</label>
            <Input
              value={form.phone_number}
              onChange={(e) => setForm((prev) => ({ ...prev, phone_number: e.target.value }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Deal Creation Date</label>
            <Input
              type="date"
              value={form.deal_creation_date}
              onChange={(e) => setForm((prev) => ({ ...prev, deal_creation_date: e.target.value }))}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Effective Date</label>
            <Input
              type="date"
              value={form.effective_date}
              onChange={(e) => setForm((prev) => ({ ...prev, effective_date: e.target.value }))}
            />
          </div>

          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-muted-foreground">Notes</label>
            <Input value={form.notes} onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))} />
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
              'Add policy'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
