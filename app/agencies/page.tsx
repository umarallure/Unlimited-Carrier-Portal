
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { Pencil, Trash2, Plus, Building2, Search } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/PageHeader'
import { Card, CardContent } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
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
        <div className="admin-page animate-in space-y-6 fade-in duration-500">
            <PageHeader
                title="Agencies"
                description="Manage all your agencies"
                icon={<Building2 className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
                action={
                    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                        <DialogTrigger asChild>
                            <Button onClick={() => openDialog()} className="bg-orange-600 text-white shadow-sm hover:bg-orange-700">
                                <Plus className="mr-2 h-4 w-4" /> Add Agency
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-md" aria-describedby="agency-dialog-desc">
                            <DialogHeader>
                                <DialogTitle>{editingAgency ? 'Edit Agency' : 'Add New Agency'}</DialogTitle>
                                <DialogDescription id="agency-dialog-desc" className="sr-only">
                                    {editingAgency ? 'Edit agency name.' : 'Create a new agency.'}
                                </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                    <Label className="text-foreground">Agency Name</Label>
                                    <Input
                                        value={newAgencyName}
                                        onChange={(e) => setNewAgencyName(e.target.value)}
                                        placeholder="Enter agency name"
                                        className={adminInput}
                                    />
                                </div>
                                <Button
                                    onClick={editingAgency ? handleUpdateAgency : handleAddAgency}
                                    className="w-full bg-gradient-to-r from-purple-500 to-pink-600 text-white hover:from-purple-600 hover:to-pink-700"
                                >
                                    {editingAgency ? 'Update Agency' : 'Create Agency'}
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
                                placeholder="Search agencies..."
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
                        Showing {filteredAgencies.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredAgencies.length)} of {filteredAgencies.length} agencies
                    </div>
                </CardContent>
            </Card>

            <Card className="overflow-hidden">
                <CardContent className="p-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-border hover:bg-transparent dark:border-white/10">
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Agency Name</TableHead>
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Created Date</TableHead>
                            <TableHead className={cn(adminThPlain, 'text-right font-semibold')}>Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={3} className="py-8 text-center">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-purple-500"></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-blue-500" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-pink-500" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredAgencies.length === 0 ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                                    {searchTerm ? 'No agencies found matching your search' : 'No agencies found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedAgencies.map((agency) => (
                                <TableRow key={agency.id} className={adminTableRowInteractive}>
                                    <TableCell className={cn(adminTdStrong, 'font-medium')}>{agency.name}</TableCell>
                                    <TableCell className={adminTdMuted}>{new Date(agency.created_at).toLocaleDateString()}</TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end space-x-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openDialog(agency)}
                                                className="text-foreground hover:bg-muted dark:text-slate-200 dark:hover:bg-slate-800"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="text-destructive hover:bg-destructive/10 dark:hover:bg-red-900/40 dark:text-red-300"
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
                {filteredAgencies.length > 0 && (
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
