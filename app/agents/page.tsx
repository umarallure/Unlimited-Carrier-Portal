
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Pencil, Trash2, Plus, Users, Mail, Search } from 'lucide-react'

export default function AgentsPage() {
    const [agents, setAgents] = useState<any[]>([])
    const [agencies, setAgencies] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [newAgentName, setNewAgentName] = useState('')
    const [newAgentEmail, setNewAgentEmail] = useState('')
    const [selectedAgencyId, setSelectedAgencyId] = useState('')
    const [editingAgent, setEditingAgent] = useState<any>(null)
    const [isDialogOpen, setIsDialogOpen] = useState(false)
    const [searchTerm, setSearchTerm] = useState('')

    useEffect(() => {
        fetchAgents()
        fetchAgencies()
    }, [])

    const fetchAgencies = async () => {
        const { data } = await supabase.from('agencies').select('id, name').order('name')
        setAgencies(data || [])
    }

    const fetchAgents = async () => {
        setLoading(true)
        const { data, error } = await supabase
            .from('agents')
            .select('*, agencies(name)')
            .order('name')

        if (error) {
            console.error('Error fetching agents:', error.message, error.code, error.details)
        } else {
            setAgents(data || [])
        }
        setLoading(false)
    }

    const handleAddAgent = async () => {
        if (!newAgentName.trim() || !selectedAgencyId) return

        const { error } = await supabase
            .from('agents')
            .insert([{ name: newAgentName, email: newAgentEmail, agency_id: selectedAgencyId }])

        if (error) {
            alert('Error adding agent: ' + error.message)
        } else {
            setNewAgentName('')
            setNewAgentEmail('')
            setSelectedAgencyId('')
            setIsDialogOpen(false)
            fetchAgents()
        }
    }

    const handleUpdateAgent = async () => {
        if (!editingAgent || !newAgentName.trim() || !selectedAgencyId) return

        const { error } = await supabase
            .from('agents')
            .update({ name: newAgentName, email: newAgentEmail, agency_id: selectedAgencyId })
            .eq('id', editingAgent.id)

        if (error) {
            alert('Error updating agent: ' + error.message)
        } else {
            setEditingAgent(null)
            setNewAgentName('')
            setNewAgentEmail('')
            setSelectedAgencyId('')
            setIsDialogOpen(false)
            fetchAgents()
        }
    }

    const handleDeleteAgent = async (id: string) => {
        if (!confirm('Are you sure?')) return

        const { error } = await supabase
            .from('agents')
            .delete()
            .eq('id', id)

        if (error) {
            alert('Error deleting agent: ' + error.message)
        } else {
            fetchAgents()
        }
    }

    const openDialog = (agent?: any) => {
        if (agent) {
            setEditingAgent(agent)
            setNewAgentName(agent.name)
            setNewAgentEmail(agent.email || '')
            setSelectedAgencyId(agent.agency_id)
        } else {
            setEditingAgent(null)
            setNewAgentName('')
            setNewAgentEmail('')
            setSelectedAgencyId('')
        }
        setIsDialogOpen(true)
    }

    const filteredAgents = agents.filter(agent =>
        agent.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        agent.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        agent.agencies?.name.toLowerCase().includes(searchTerm.toLowerCase())
    )

    // Pagination
    const [currentPage, setCurrentPage] = useState(1)
    const [pageSize, setPageSize] = useState(25)
    const totalPages = Math.ceil(filteredAgents.length / pageSize)
    const startIndex = (currentPage - 1) * pageSize
    const endIndex = startIndex + pageSize
    const paginatedAgents = filteredAgents.slice(startIndex, endIndex)

    useEffect(() => {
        setCurrentPage(1) // Reset to page 1 when search changes
    }, [searchTerm])

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-xl bg-slate-900 flex items-center justify-center border border-slate-800">
                        <Users className="w-6 h-6 text-orange-400" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold text-white">Agents</h1>
                        <p className="text-gray-400">Manage all your agents</p>
                    </div>
                </div>
                <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                        <Button onClick={() => openDialog()} className="bg-orange-600 hover:bg-orange-700 text-white shadow-sm">
                            <Plus className="mr-2 h-4 w-4" /> Add Agent
                        </Button>
                    </DialogTrigger>
                    <DialogContent className="bg-slate-900 border-slate-700">
                        <DialogHeader>
                            <DialogTitle className="text-white">{editingAgent ? 'Edit Agent' : 'Add New Agent'}</DialogTitle>
                        </DialogHeader>
                        <div className="space-y-4 py-4">
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-300">Agency</label>
                                <Select value={selectedAgencyId} onValueChange={setSelectedAgencyId}>
                                    <SelectTrigger className="bg-slate-800 border-slate-700 text-white">
                                        <SelectValue placeholder="Select Agency" />
                                    </SelectTrigger>
                                    <SelectContent className="bg-slate-800 border-slate-700">
                                        {agencies.map(agency => (
                                            <SelectItem key={agency.id} value={agency.id} className="text-white focus:bg-slate-700">{agency.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-300">Agent Name</label>
                                <Input
                                    value={newAgentName}
                                    onChange={(e) => setNewAgentName(e.target.value)}
                                    placeholder="Enter agent name"
                                    className="bg-slate-800 border-slate-700 text-white placeholder:text-gray-500"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-gray-300">Email (Optional)</label>
                                <div className="relative">
                                    <Mail className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                                    <Input
                                        value={newAgentEmail}
                                        onChange={(e) => setNewAgentEmail(e.target.value)}
                                        placeholder="agent@example.com"
                                        type="email"
                                        className="pl-10 bg-slate-800 border-slate-700 text-white placeholder:text-gray-500"
                                    />
                                </div>
                            </div>
                            <Button
                                onClick={editingAgent ? handleUpdateAgent : handleAddAgent}
                                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700"
                            >
                                {editingAgent ? 'Update Agent' : 'Create Agent'}
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
                            placeholder="Search agents, emails, or agencies..."
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
                    Showing {filteredAgents.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredAgents.length)} of {filteredAgents.length} agents
                </div>
            </div>

            <div className="bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-white/10 hover:bg-transparent">
                            <TableHead className="text-gray-300 font-semibold">Agent Name</TableHead>
                            <TableHead className="text-gray-300 font-semibold">Email</TableHead>
                            <TableHead className="text-gray-300 font-semibold">Agency</TableHead>
                            <TableHead className="text-right text-gray-300 font-semibold">Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={4} className="text-center py-8">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="w-2 h-2 bg-green-500 rounded-full animate-bounce"></div>
                                        <div className="w-2 h-2 bg-emerald-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="w-2 h-2 bg-teal-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredAgents.length === 0 ? (
                            <TableRow className="border-b border-slate-800">
                                <TableCell colSpan={4} className="text-center py-8 text-gray-400">
                                    {searchTerm ? 'No agents found matching your search' : 'No agents found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedAgents.map((agent) => (
                                <TableRow key={agent.id} className="border-b border-slate-800 hover:bg-slate-900/80 transition-colors">
                                    <TableCell className="font-medium text-slate-100">{agent.name}</TableCell>
                                    <TableCell className="text-slate-400">
                                        {agent.email ? (
                                            <div className="flex items-center space-x-2">
                                                <Mail className="w-4 h-4 text-slate-500" />
                                                <span>{agent.email}</span>
                                            </div>
                                        ) : (
                                            <span className="text-slate-600">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-slate-400">
                                        <span className="px-3 py-1 rounded-full bg-slate-800 text-slate-200 text-sm">
                                            {agent.agencies?.name || 'Unknown'}
                                        </span>
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end space-x-2">
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => openDialog(agent)}
                                                className="hover:bg-slate-800 text-slate-200"
                                            >
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="hover:bg-red-900/40 text-red-300"
                                                onClick={() => handleDeleteAgent(agent.id)}
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
                {filteredAgents.length > 0 && (
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
