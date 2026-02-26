
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { Pencil, Trash2, Plus, Building2, Search } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

export default function AgenciesPage() {
    const [agencies, setAgencies] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [newAgencyName, setNewAgencyName] = useState('')
    const [editingAgency, setEditingAgency] = useState<any>(null)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)

    useEffect(() => {
        fetchAgencies()
    }, [])

    const fetchAgencies = async () => {
        setLoading(true)
        const { data, error } = await supabase
            .from('agencies')
            .select('*')
            .order('name')

        if (error) console.error('Error fetching agencies:', error)
        else setAgencies(data || [])
        setLoading(false)
    }

    const handleAddAgency = async () => {
        if (!newAgencyName.trim()) return

        const { error } = await supabase
            .from('agencies')
            .insert([{ name: newAgencyName }])

        if (error) {
            alert('Error adding agency: ' + error.message)
        } else {
            setNewAgencyName('')
            setIsDialogOpen(false)
            fetchAgencies()
        }
    }

    const handleUpdateAgency = async () => {
        if (!editingAgency || !newAgencyName.trim()) return

        const { error } = await supabase
            .from('agencies')
            .update({ name: newAgencyName })
            .eq('id', editingAgency.id)

        if (error) {
            alert('Error updating agency: ' + error.message)
        } else {
            setEditingAgency(null)
            setNewAgencyName('')
            setIsDialogOpen(false)
            fetchAgencies()
        }
    }

    const handleDeleteAgency = async (id: string) => {
        if (!confirm('Are you sure? This will delete all associated carriers, agents, and files.')) return

        const { error } = await supabase
            .from('agencies')
            .delete()
            .eq('id', id)

        if (error) {
            alert('Error deleting agency: ' + error.message)
        } else {
            fetchAgencies()
        }
    }

    const openDialog = (agency?: any) => {
        if (agency) {
            setEditingAgency(agency)
            setNewAgencyName(agency.name)
        } else {
            setEditingAgency(null)
            setNewAgencyName('')
        }
        setIsDialogOpen(true)
    }

    const filteredAgencies = agencies.filter(agency =>
        agency.name.toLowerCase().includes(searchTerm.toLowerCase())
    )

    // Pagination
    const totalPages = Math.ceil(filteredAgencies.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedAgencies = filteredAgencies.slice(startIndex, endIndex)

    useEffect(() => {
        setCurrentPage(1) // Reset to page 1 when search changes
    }, [searchTerm])

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                        <Building2 className="w-6 h-6 text-orange-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-white">Agencies</h1>
                        <p className="text-gray-400">Manage all your agencies</p>
                    </div>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button onClick={() => openDialog()} className="bg-orange-600 hover:bg-orange-700 text-white shadow-sm">
                            <Plus className="mr-2 h-4 w-4" /> Add Agency
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="bg-slate-900 border-slate-700" aria-describedby="agency-dialog-desc">
                        <DialogHeader>
                            <DialogTitle className="text-white">{editingAgency ? 'Edit Agency' : 'Add New Agency'}</DialogTitle>
                            <DialogDescription id="agency-dialog-desc" className="sr-only text-slate-400">
                                {editingAgency ? 'Edit agency name.' : 'Create a new agency.'}
                            </DialogDescription>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-300">Agency Name</label>
                                <Input
                                    value={newAgencyName}
                                    onChange={(e) => setNewAgencyName(e.target.value)}
                                    placeholder="Enter agency name"
                                    className="bg-slate-800 border-slate-700 text-white placeholder:text-gray-500"
                                />
                            </div>
                            <Button
                                onClick={editingAgency ? handleUpdateAgency : handleAddAgency}
                                className="w-full bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700"
                            >
                                {editingAgency ? 'Update Agency' : 'Create Agency'}
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
                            placeholder="Search agencies..."
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
                    Showing {filteredAgencies.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredAgencies.length)} of {filteredAgencies.length} agencies
                </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-white/10 hover:bg-transparent">
                            <TableHead className="text-gray-300 font-semibold">Agency Name</TableHead>
                            <TableHead className="text-gray-300 font-semibold">Created Date</TableHead>
                            <TableHead className="text-right text-gray-300 font-semibold">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={3} className="text-center py-8">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce"></div>
                                        <div className="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="w-2 h-2 bg-pink-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredAgencies.length === 0 ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={3} className="text-center py-8 text-gray-400">
                                    {searchTerm ? 'No agencies found matching your search' : 'No agencies found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedAgencies.map((agency) => (
                                <TableRow key={agency.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors">
                                    <TableCell className="font-medium text-slate-100">{agency.name}</TableCell>
                                    <TableCell className="text-slate-400">{new Date(agency.created_at).toLocaleDateString()}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end space-x-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openDialog(agency)}
                                                className="hover:bg-slate-800 text-slate-200"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="hover:bg-red-900/40 text-red-300"
                                                onClick={() => handleDeleteAgency(agency.id)}
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
                {filteredAgencies.length > 0 && (
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
