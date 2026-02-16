
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Pencil, Trash2, Plus, FileText, Search } from 'lucide-react'
import { Label } from "@/components/ui/label"

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
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                        <FileText className="w-6 h-6 text-orange-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-white">Carriers</h1>
                        <p className="text-gray-400">Manage carriers across agencies</p>
                    </div>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button onClick={() => openDialog()} className="bg-orange-600 hover:bg-orange-700 text-white shadow-sm">
                            <Plus className="mr-2 h-4 w-4" /> Add Carrier
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="bg-slate-900 border-slate-700">
                        <DialogHeader>
                            <DialogTitle className="text-white">{editingCarrier ? 'Edit Carrier' : 'Add New Carrier'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <Label className="text-gray-300">Carrier Name</Label>
                                <Input
                                    value={newCarrierName}
                                    onChange={(e) => setNewCarrierName(e.target.value)}
                                    placeholder="e.g. Transamerica"
                                    className="bg-slate-800 border-slate-700 text-white placeholder:text-gray-500"
                                />
                            </div>
                            <div className="space-y-2">
                                <Label className="text-gray-300">Carrier Code (required)</Label>
                                <Input
                                    value={newCarrierCode}
                                    onChange={(e) => setNewCarrierCode(e.target.value)}
                                    placeholder="e.g. TRANSAMERICA"
                                    className="bg-slate-800 border-slate-700 text-white placeholder:text-gray-500"
                                />
                                <p className="text-xs text-slate-500">Short code used in uploads (e.g. TRANSAMERICA, AETNA).</p>
                            </div>
                            <div className="space-y-2">
                                <Label className="text-gray-300">Select Agencies (can select multiple)</Label>
                                <div className="grid grid-cols-1 gap-2 max-h-48 overflow-y-auto p-2 bg-slate-800/50 rounded-lg border border-slate-700">
                                    {agencies.map(agency => (
                                        <label
                                            key={agency.id}
                                            className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-colors ${selectedAgencyIds.includes(agency.id)
                                                ? 'bg-blue-500/20 border border-blue-500/50'
                                                : 'bg-slate-800 border border-slate-700 hover:bg-slate-750'
                                                }`}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={selectedAgencyIds.includes(agency.id)}
                                                onChange={() => toggleAgencySelection(agency.id)}
                                                className="w-4 h-4 text-blue-500"
                                            />
                                            <span className="text-white">{agency.name}</span>
                                        </label>
                                    ))}
                                </div>
                                {selectedAgencyIds.length > 0 && (
                                    <p className="text-xs text-blue-400 mt-2">
                                        {selectedAgencyIds.length} agency(ies) selected
                                    </p>
                                )}
                            </div>
                            <Button
                                onClick={editingCarrier ? handleUpdateCarrier : handleAddCarrier}
                                className="w-full bg-gradient-to-r from-blue-500 to-cyan-600 hover:from-blue-600 hover:to-cyan-700"
                                disabled={!newCarrierName.trim() || !newCarrierCode.trim() || selectedAgencyIds.length === 0}
                            >
                                {editingCarrier ? 'Update Carrier' : 'Create Carrier'}
                            </Button>
                        </div>
                    </DialogContent>
                </Dialog>
            </div>

            <div className="bg-slate-900 p-4 rounded-xl border border-slate-800">
                <div className="flex items-center justify-between gap-4 mb-3">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-5 h-5" />
                        <Input
                            placeholder="Search carriers..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-10 bg-slate-950 border-slate-800 text-white placeholder:text-slate-500"
                        />
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-slate-400">Rows per page:</span>
                        <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setCurrentPage(1) }}>
                            <SelectTrigger className="h-8 w-20 bg-slate-950 border-slate-800 text-white text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="bg-slate-800 border-slate-700">
                                <SelectItem value="25" className="text-white">25</SelectItem>
                                <SelectItem value="50" className="text-white">50</SelectItem>
                                <SelectItem value="100" className="text-white">100</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <div className="text-sm text-slate-400">
                    Showing {filteredCarriers.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredCarriers.length)} of {filteredCarriers.length} carriers
                </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-white/10 hover:bg-transparent">
                            <TableHead className="text-gray-300 font-semibold">Carrier Name</TableHead>
                            <TableHead className="text-gray-300 font-semibold">Agencies</TableHead>
                            <TableHead className="text-right text-gray-300 font-semibold">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={3} className="text-center py-8">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce"></div>
                                        <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="w-2 h-2 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredCarriers.length === 0 ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={3} className="text-center py-8 text-gray-400">
                                    {searchTerm ? 'No carriers found matching your search' : 'No carriers found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedCarriers.map((carrier) => (
                                <TableRow key={carrier.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors cursor-pointer"
                                    onClick={() => window.location.href = `/carriers/${carrier.id}`}>
                                    <TableCell className="font-medium text-slate-100 hover:text-orange-400 transition-colors">
                                        {carrier.name}
                                    </TableCell>
                                    <TableCell className="text-slate-400">
                                        <div className="flex flex-wrap gap-2">
                                            {carrier.agency_carriers.map((ac: any) => (
                                                <span key={ac.id} className="px-3 py-1 rounded-full bg-slate-800 text-slate-200 text-sm">
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
                                                onClick={() => openDialog(carrier)}
                                                className="hover:bg-slate-800 text-slate-200"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="hover:bg-red-900/40 text-red-300"
                                                onClick={() => handleDeleteCarrier(carrier.id)}
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
                {/* Pagination Controls */}
                {filteredCarriers.length > 0 && (
                    <div className="flex items-center justify-between px-4 py-3 border-t border-slate-800 bg-slate-900/50">
                        <div className="text-sm text-slate-400">
                            Page {currentPage} of {totalPages}
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(1)}
                                disabled={currentPage === 1}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                First
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={currentPage === 1}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Previous
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                disabled={currentPage === totalPages}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Next
                            </Button>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setCurrentPage(totalPages)}
                                disabled={currentPage === totalPages}
                                className="bg-slate-950 border-slate-800 text-slate-200 hover:bg-slate-800 disabled:opacity-40"
                            >
                                Last
                            </Button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
