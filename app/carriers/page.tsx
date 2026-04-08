
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Pencil, Trash2, Plus, FileText, Search } from 'lucide-react'
import { Label } from "@/components/ui/label"
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import {
  adminInput,
  adminOutlineBtn,
  adminPaginationBar,
  adminSelectContent,
  adminSelectItem,
  adminSelectTrigger,
  adminTableRowInteractive,
  adminTdMuted,
  adminTdStrong,
  adminThPlain,
} from '@/lib/adminFieldClasses'

export default function CarriersPage() {
    const [carriers, setCarriers] = useState<any[]>([])
    const [agencies, setAgencies] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [newCarrierName, setNewCarrierName] = useState('')
    const [newCarrierCode, setNewCarrierCode] = useState('')
    const [selectedAgencyIds, setSelectedAgencyIds] = useState<string[]>([])
    const [editingCarrier, setEditingCarrier] = useState<any>(null)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')

    useEffect(() => {
        fetchCarriers()
        fetchAgencies()
    }, [])

    const fetchAgencies = async () => {
        const { data } = await supabase.from('agencies').select('id, name').order('name')
        setAgencies(data || [])
    }

    const fetchCarriers = async () => {
        setLoading(true)
        const { data, error } = await supabase
            .from('carriers')
            .select(`
        *,
        agency_carriers (
          id,
          agencies (
            id,
            name
          )
        )
      `)
            .order('name')

        if (error) console.error('Error fetching carriers:', error)
        else setCarriers(data || [])
        setLoading(false)
    }

    const handleAddCarrier = async () => {
        const code = newCarrierCode.trim()
        if (!newCarrierName.trim() || !code || selectedAgencyIds.length === 0) return

        // First create the carrier (code is required by DB)
        const { data: carrier, error: carrierError } = await supabase
            .from('carriers')
            .insert([{ name: newCarrierName.trim(), code }])
            .select()
            .single()

        if (carrierError) {
            alert('Error adding carrier: ' + carrierError.message)
            return
        }

        // Then link to selected agencies
        const links = selectedAgencyIds.map(agencyId => ({
            carrier_id: carrier.id,
            agency_id: agencyId
        }))

        const { error: linkError } = await supabase
            .from('agency_carriers')
            .insert(links)

        if (linkError) {
            alert('Error linking carrier to agencies: ' + linkError.message)
        } else {
            setNewCarrierName('')
            setNewCarrierCode('')
            setSelectedAgencyIds([])
            setIsDialogOpen(false)
            fetchCarriers()
        }
    }

    const handleUpdateCarrier = async () => {
        const code = newCarrierCode.trim()
        if (!editingCarrier || !newCarrierName.trim() || !code || selectedAgencyIds.length === 0) return

        // Update carrier name and code
        const { error: updateError } = await supabase
            .from('carriers')
            .update({ name: newCarrierName.trim(), code })
            .eq('id', editingCarrier.id)

        if (updateError) {
            alert('Error updating carrier: ' + updateError.message)
            return
        }

        // Delete old links
        await supabase
            .from('agency_carriers')
            .delete()
            .eq('carrier_id', editingCarrier.id)

        // Create new links
        const links = selectedAgencyIds.map(agencyId => ({
            carrier_id: editingCarrier.id,
            agency_id: agencyId
        }))

        const { error: linkError } = await supabase
            .from('agency_carriers')
            .insert(links)

        if (linkError) {
            alert('Error updating links: ' + linkError.message)
        } else {
            setEditingCarrier(null)
            setNewCarrierName('')
            setNewCarrierCode('')
            setSelectedAgencyIds([])
            setIsDialogOpen(false)
            fetchCarriers()
        }
    }

    const handleDeleteCarrier = async (id: string) => {
        if (!confirm('Are you sure? This will delete all associated files.')) return

        const { error } = await supabase
            .from('carriers')
            .delete()
            .eq('id', id)

        if (error) {
            alert('Error deleting carrier: ' + error.message)
        } else {
            fetchCarriers()
        }
    }

    const openDialog = (carrier?: any) => {
        if (carrier) {
            setEditingCarrier(carrier)
            setNewCarrierName(carrier.name)
            setNewCarrierCode(carrier.code ?? '')
            const agencyIds = carrier.agency_carriers.map((ac: any) => ac.agencies.id)
            setSelectedAgencyIds(agencyIds)
        } else {
            setEditingCarrier(null)
            setNewCarrierName('')
            setNewCarrierCode('')
            setSelectedAgencyIds([])
        }
        setIsDialogOpen(true)
    }

    const toggleAgencySelection = (agencyId: string) => {
        setSelectedAgencyIds(prev =>
            prev.includes(agencyId)
                ? prev.filter(id => id !== agencyId)
                : [...prev, agencyId]
        )
    }

    const filteredCarriers = carriers.filter(carrier =>
        carrier.name.toLowerCase().includes(searchTerm.toLowerCase())
    )

    // Pagination
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)
    const totalPages = Math.ceil(filteredCarriers.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedCarriers = filteredCarriers.slice(startIndex, endIndex)

    useEffect(() => {
        setCurrentPage(1) // Reset to page 1 when search changes
    }, [searchTerm])

    return (
        <div className="admin-page animate-in space-y-6 fade-in duration-500">
            <PageHeader
                title="Carriers"
                description="Manage carriers across agencies"
                icon={<FileText className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
                action={
                    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                        <DialogTrigger asChild>
                            <Button onClick={() => openDialog()} className="bg-orange-600 text-white shadow-sm hover:bg-orange-700">
                                <Plus className="mr-2 h-4 w-4" /> Add Carrier
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-lg" aria-describedby="carrier-dialog-desc">
                            <DialogHeader>
                                <DialogTitle>{editingCarrier ? 'Edit Carrier' : 'Add New Carrier'}</DialogTitle>
                                <DialogDescription id="carrier-dialog-desc" className="sr-only">
                                    {editingCarrier ? 'Edit carrier and agency assignments.' : 'Add a new carrier and assign agencies.'}
                                </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                    <Label className="text-foreground">Carrier Name</Label>
                                    <Input
                                        value={newCarrierName}
                                        onChange={(e) => setNewCarrierName(e.target.value)}
                                        placeholder="e.g. Transamerica"
                                        className={adminInput}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-foreground">Carrier Code (required)</Label>
                                    <Input
                                        value={newCarrierCode}
                                        onChange={(e) => setNewCarrierCode(e.target.value)}
                                        placeholder="e.g. TRANSAMERICA"
                                        className={adminInput}
                                    />
                                    <p className="text-xs text-muted-foreground">Short code used in uploads (e.g. TRANSAMERICA, AETNA).</p>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-foreground">Select Agencies (can select multiple)</Label>
                                    <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto rounded-lg border border-border bg-muted/30 p-2 dark:bg-slate-800/40">
                                        {agencies.map(agency => (
                                            <label
                                                key={agency.id}
                                                className={cn(
                                                    'flex cursor-pointer items-center space-x-3 rounded-lg border p-3 transition-colors',
                                                    selectedAgencyIds.includes(agency.id)
                                                        ? 'border-blue-500/50 bg-blue-500/10 dark:bg-blue-500/20'
                                                        : 'border-border bg-background hover:bg-muted/80 dark:border-slate-700 dark:bg-slate-800/60 dark:hover:bg-slate-800'
                                                )}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={selectedAgencyIds.includes(agency.id)}
                                                    onChange={() => toggleAgencySelection(agency.id)}
                                                    className="h-4 w-4 text-blue-600"
                                                />
                                                <span className="text-foreground">{agency.name}</span>
                                            </label>
                                        ))}
                                    </div>
                                    {selectedAgencyIds.length > 0 && (
                                        <p className="mt-2 text-xs text-blue-700 dark:text-blue-400">
                                            {selectedAgencyIds.length} agency(ies) selected
                                        </p>
                                    )}
                                </div>
                                <Button
                                    onClick={editingCarrier ? handleUpdateCarrier : handleAddCarrier}
                                    className="w-full bg-gradient-to-r from-blue-500 to-cyan-600 text-white hover:from-blue-600 hover:to-cyan-700"
                                    disabled={!newCarrierName.trim() || !newCarrierCode.trim() || selectedAgencyIds.length === 0}
                                >
                                    {editingCarrier ? 'Update Carrier' : 'Create Carrier'}
                                </Button>
                            </div>
                        </DialogContent>
                    </Dialog>
                }
            />

            <Card>
                <CardContent className="space-y-3 pt-6">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-4">
                        <div className="relative min-w-[200px] flex-1">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                placeholder="Search carriers..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className={cn(adminInput, 'pl-10')}
                            />
                        </div>
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-muted-foreground">Rows per page:</span>
                            <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                                <SelectTrigger className={cn('h-8 w-20 text-xs', adminSelectTrigger)}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className={adminSelectContent}>
                                    <SelectItem value="25" className={adminSelectItem}>25</SelectItem>
                                    <SelectItem value="50" className={adminSelectItem}>50</SelectItem>
                                    <SelectItem value="100" className={adminSelectItem}>100</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                    <div className="text-sm text-muted-foreground">
                        Showing {filteredCarriers.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredCarriers.length)} of {filteredCarriers.length} carriers
                    </div>
                </CardContent>
            </Card>

            <Card className="overflow-hidden">
                <CardContent className="p-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-border hover:bg-transparent dark:border-white/10">
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Carrier Name</TableHead>
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Agencies</TableHead>
                            <TableHead className={cn(adminThPlain, 'text-right font-semibold')}>Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={3} className="py-8 text-center">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500"></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-cyan-500" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-teal-500" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredCarriers.length === 0 ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                                    {searchTerm ? 'No carriers found matching your search' : 'No carriers found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedCarriers.map((carrier) => (
                                <TableRow key={carrier.id} className={adminTableRowInteractive}>
                                    <TableCell className={cn(adminTdStrong, 'font-medium')}>
                                        {carrier.name}
                                    </TableCell>
                                    <TableCell className={adminTdMuted}>
                                        <div className="flex flex-wrap gap-2">
                                            {carrier.agency_carriers.map((ac: any) => (
                                                <span
                                                    key={ac.id}
                                                    className="rounded-full border border-border bg-muted px-3 py-1 text-sm text-foreground dark:bg-slate-800 dark:text-slate-200"
                                                >
                                                    {ac.agencies.name}
                                                </span>
                                            ))}
                                        </div>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end space-x-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    openDialog(carrier)
                                                }}
                                                className="text-foreground hover:bg-muted dark:text-slate-200 dark:hover:bg-slate-800"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="text-destructive hover:bg-destructive/10 dark:hover:bg-red-900/40 dark:text-red-300"
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    handleDeleteCarrier(carrier.id)
                                                }}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
                {filteredCarriers.length > 0 && (
                    <div className={cn('flex items-center justify-between border-t border-border px-4 py-3 dark:border-slate-800', adminPaginationBar)}>
                        <div className="text-sm text-muted-foreground">
                            Page {currentPage} of {totalPages}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>
                                First
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>
                                Previous
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                                Next
                            </Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>
                                Last
                            </Button>
                        </div>
                    </div>
                )}
                </CardContent>
            </Card>
        </div>
    )
}
