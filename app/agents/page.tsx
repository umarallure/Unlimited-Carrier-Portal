
'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabaseClient'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Pencil, Trash2, Plus, Users, Mail, Search, FileText } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
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

export default function AgentsPage() {
    const [agents, setAgents] = useState<any[]>([])
    const [agencies, setAgencies] = useState<any[]>([])
    const [loading, setLoading] = useState(true)
    const [newAgentName, setNewAgentName] = useState('')
    const [newAgentEmail, setNewAgentEmail] = useState('')
    const [selectedAgencyId, setSelectedAgencyId] = useState('')
    const [selectedCarriers, setSelectedCarriers] = useState<string[]>([])
    const [availableCarriers, setAvailableCarriers] = useState<{ id: string; name: string; code: string }[]>([])
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

    const fetchCarriersForAgency = async (agencyId: string) => {
        if (!agencyId) {
            setAvailableCarriers([])
            return
        }
        const { data } = await supabase
            .from('agency_carriers')
            .select('id, carriers(id, name, code)')
            .eq('agency_id', agencyId)
            .order('carriers(name)')
        
        const carriers = (data || [])
            .map((ac: any) => ({
                id: ac.id,
                name: Array.isArray(ac.carriers) ? ac.carriers[0]?.name : ac.carriers?.name,
                code: Array.isArray(ac.carriers) ? ac.carriers[0]?.code : ac.carriers?.code,
            }))
            .filter((c: any) => c.name)
        
        setAvailableCarriers(carriers as { id: string; name: string; code: string }[])
    }

    const fetchAgentCarriers = async (agentId: string) => {
        const { data } = await supabase
            .from('agent_carriers')
            .select('agency_carrier_id')
            .eq('agent_id', agentId)
        
        return (data || []).map((r: any) => r.agency_carrier_id)
    }

    const fetchAgents = async () => {
        setLoading(true)
        const { data: agentsData, error } = await supabase
            .from('agents')
            .select('*, agencies(name)')
            .order('name')

        if (error) {
            console.error('Error fetching agents:', error.message, error.code, error.details)
            setAgents([])
            setLoading(false)
            return
        }

        // Fetch carrier assignments for all agents
        const agentIds = (agentsData || []).map((a: any) => a.id)
        const { data: agentCarriersData } = await supabase
            .from('agent_carriers')
            .select('agent_id, agency_carriers(id, carriers(id, name, code))')
            .in('agent_id', agentIds)

        // Build a map of agent_id -> carriers
        const agentCarrierMap = new Map<string, { name: string; code: string }[]>()
        if (agentCarriersData) {
            agentCarriersData.forEach((ac: any) => {
                const agentId = ac.agent_id
                const carrier = Array.isArray(ac.agency_carriers?.carriers) 
                    ? ac.agency_carriers.carriers[0] 
                    : ac.agency_carriers?.carriers
                
                if (carrier && carrier.name) {
                    if (!agentCarrierMap.has(agentId)) {
                        agentCarrierMap.set(agentId, [])
                    }
                    agentCarrierMap.get(agentId)!.push({
                        name: carrier.name,
                        code: carrier.code || '',
                    })
                }
            })
        }

        // Add carriers to each agent
        const agentsWithCarriers = (agentsData || []).map((agent: any) => ({
            ...agent,
            assignedCarriers: agentCarrierMap.get(agent.id) || [],
        }))

        setAgents(agentsWithCarriers)
        setLoading(false)
    }

    const handleAddAgent = async () => {
        if (!newAgentName.trim() || !selectedAgencyId) return

        // Insert agent first
        const { data: agentData, error: agentError } = await supabase
            .from('agents')
            .insert([{ name: newAgentName, email: newAgentEmail, agency_id: selectedAgencyId }])
            .select()
            .single()

        if (agentError) {
            alert('Error adding agent: ' + agentError.message)
            return
        }

        // Insert carrier assignments if any selected
        if (selectedCarriers.length > 0 && agentData) {
            const carrierInserts = selectedCarriers.map(acId => ({
                agent_id: agentData.id,
                agency_carrier_id: acId,
            }))
            
            const { error: carrierError } = await supabase
                .from('agent_carriers')
                .insert(carrierInserts)

            if (carrierError) {
                console.error('Error assigning carriers:', carrierError)
                // Don't fail the whole operation, just log the error
            }
        }

        // Reset form
        setNewAgentName('')
        setNewAgentEmail('')
        setSelectedAgencyId('')
        setSelectedCarriers([])
        setAvailableCarriers([])
        setIsDialogOpen(false)
        fetchAgents()
    }

    const handleUpdateAgent = async () => {
        if (!editingAgent || !newAgentName.trim() || !selectedAgencyId) return

        // Update agent
        const { error: agentError } = await supabase
            .from('agents')
            .update({ name: newAgentName, email: newAgentEmail, agency_id: selectedAgencyId })
            .eq('id', editingAgent.id)

        if (agentError) {
            alert('Error updating agent: ' + agentError.message)
            return
        }

        // Update carrier assignments
        // Delete existing relationships
        await supabase
            .from('agent_carriers')
            .delete()
            .eq('agent_id', editingAgent.id)

        // Insert new relationships
        if (selectedCarriers.length > 0) {
            const carrierInserts = selectedCarriers.map(acId => ({
                agent_id: editingAgent.id,
                agency_carrier_id: acId,
            }))
            
            const { error: carrierError } = await supabase
                .from('agent_carriers')
                .insert(carrierInserts)

            if (carrierError) {
                console.error('Error updating carrier assignments:', carrierError)
                // Don't fail the whole operation
            }
        }

        // Reset form
        setEditingAgent(null)
        setNewAgentName('')
        setNewAgentEmail('')
        setSelectedAgencyId('')
        setSelectedCarriers([])
        setAvailableCarriers([])
        setIsDialogOpen(false)
        fetchAgents()
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

    const openDialog = async (agent?: any) => {
        if (agent) {
            setEditingAgent(agent)
            setNewAgentName(agent.name)
            setNewAgentEmail(agent.email || '')
            setSelectedAgencyId(agent.agency_id)
            // Fetch carriers for this agency
            await fetchCarriersForAgency(agent.agency_id)
            // Fetch current carrier assignments
            const currentCarriers = await fetchAgentCarriers(agent.id)
            setSelectedCarriers(currentCarriers)
        } else {
            setEditingAgent(null)
            setNewAgentName('')
            setNewAgentEmail('')
            setSelectedAgencyId('')
            setSelectedCarriers([])
            setAvailableCarriers([])
        }
        setIsDialogOpen(true)
    }

    const handleAgencyChange = async (agencyId: string) => {
        setSelectedAgencyId(agencyId)
        setSelectedCarriers([]) // Reset carriers when agency changes
        await fetchCarriersForAgency(agencyId)
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
        <div className="admin-page animate-in space-y-6 fade-in duration-500">
            <PageHeader
                title="Agents"
                description="Manage all your agents"
                icon={<Users className="h-7 w-7 text-orange-500 dark:text-orange-400" strokeWidth={2} />}
                action={
                    <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                        <DialogTrigger asChild>
                            <Button onClick={() => openDialog()} className="bg-orange-600 text-white shadow-sm hover:bg-orange-700">
                                <Plus className="mr-2 h-4 w-4" /> Add Agent
                            </Button>
                        </DialogTrigger>
                        <DialogContent className="sm:max-w-lg" aria-describedby="agent-dialog-desc">
                            <DialogHeader>
                                <DialogTitle>{editingAgent ? 'Edit Agent' : 'Add New Agent'}</DialogTitle>
                                <DialogDescription id="agent-dialog-desc" className="sr-only">
                                    {editingAgent ? 'Edit agent details and agency.' : 'Add a new agent and assign agency.'}
                                </DialogDescription>
                            </DialogHeader>
                            <div className="space-y-4 py-4">
                                <div className="space-y-2">
                                    <Label className="text-foreground">Agency</Label>
                                    <Select value={selectedAgencyId} onValueChange={handleAgencyChange}>
                                        <SelectTrigger className={cn('h-10 w-full', adminSelectTrigger)}>
                                            <SelectValue placeholder="Select Agency" />
                                        </SelectTrigger>
                                        <SelectContent className={adminSelectContent}>
                                            {agencies.map(agency => (
                                                <SelectItem key={agency.id} value={agency.id} className={adminSelectItem}>{agency.name}</SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-foreground">Agent Name</Label>
                                    <Input value={newAgentName} onChange={(e) => setNewAgentName(e.target.value)} placeholder="Enter agent name" className={adminInput} />
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-foreground">Email (Optional)</Label>
                                    <div className="relative">
                                        <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                                        <Input
                                            value={newAgentEmail}
                                            onChange={(e) => setNewAgentEmail(e.target.value)}
                                            placeholder="agent@example.com"
                                            type="email"
                                            className={cn(adminInput, 'pl-10')}
                                        />
                                    </div>
                                </div>

                                {selectedAgencyId && (
                                    <div className="space-y-2">
                                        <Label className="text-foreground">Assign Carriers (Optional)</Label>
                                        <div className="max-h-48 overflow-y-auto rounded-lg border border-border bg-muted/30 p-4 dark:bg-slate-800/40">
                                            {availableCarriers.length === 0 ? (
                                                <p className="py-4 text-center text-sm text-muted-foreground">
                                                    No carriers available for this agency. Add carriers to the agency first.
                                                </p>
                                            ) : (
                                                <div className="space-y-2">
                                                    {availableCarriers.map((carrier) => {
                                                        const isChecked = selectedCarriers.includes(carrier.id)
                                                        return (
                                                            <div
                                                                key={carrier.id}
                                                                className="flex cursor-pointer items-center space-x-3 rounded-lg p-2 transition-colors hover:bg-muted/80 dark:hover:bg-slate-700/50"
                                                                onClick={() => {
                                                                    setSelectedCarriers(prev =>
                                                                        isChecked ? prev.filter(id => id !== carrier.id) : [...prev, carrier.id]
                                                                    )
                                                                }}
                                                            >
                                                                <Checkbox
                                                                    checked={isChecked}
                                                                    onCheckedChange={(checked) => {
                                                                        setSelectedCarriers(prev =>
                                                                            checked ? [...prev, carrier.id] : prev.filter(id => id !== carrier.id)
                                                                        )
                                                                    }}
                                                                />
                                                                <label className="flex-1 cursor-pointer text-sm text-foreground">
                                                                    {carrier.name} {carrier.code && <span className="text-muted-foreground">({carrier.code})</span>}
                                                                </label>
                                                            </div>
                                                        )
                                                    })}
                                                </div>
                                            )}
                                        </div>
                                        {selectedCarriers.length > 0 && (
                                            <p className="text-xs text-muted-foreground">
                                                {selectedCarriers.length} carrier{selectedCarriers.length !== 1 ? 's' : ''} selected
                                            </p>
                                        )}
                                    </div>
                                )}

                                <Button
                                    onClick={editingAgent ? handleUpdateAgent : handleAddAgent}
                                    className="w-full bg-gradient-to-r from-green-500 to-emerald-600 text-white hover:from-green-600 hover:to-emerald-700"
                                >
                                    {editingAgent ? 'Update Agent' : 'Create Agent'}
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
                                placeholder="Search agents, emails, or agencies..."
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
                        Showing {filteredAgents.length === 0 ? 0 : startIndex + 1}–{Math.min(endIndex, filteredAgents.length)} of {filteredAgents.length} agents
                    </div>
                </CardContent>
            </Card>

            <Card className="overflow-hidden">
                <CardContent className="p-0">
                <Table>
                    <TableHeader>
                        <TableRow className="border-b border-border hover:bg-transparent dark:border-white/10">
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Agent Name</TableHead>
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Email</TableHead>
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Agency</TableHead>
                            <TableHead className={cn(adminThPlain, 'font-semibold')}>Carriers</TableHead>
                            <TableHead className={cn(adminThPlain, 'text-right font-semibold')}>Actions</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {loading ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={5} className="py-8 text-center">
                                    <div className="flex items-center justify-center space-x-2">
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-green-500"></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-emerald-500" style={{ animationDelay: '0.1s' }}></div>
                                        <div className="h-2 w-2 animate-bounce rounded-full bg-teal-500" style={{ animationDelay: '0.2s' }}></div>
                                    </div>
                                </TableCell>
                            </TableRow>
                        ) : filteredAgents.length === 0 ? (
                            <TableRow className="border-b border-border dark:border-slate-800">
                                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                                    {searchTerm ? 'No agents found matching your search' : 'No agents found'}
                                </TableCell>
                            </TableRow>
                        ) : (
                            paginatedAgents.map((agent) => (
                                <TableRow key={agent.id} className={adminTableRowInteractive}>
                                    <TableCell className={cn(adminTdStrong, 'font-medium')}>{agent.name}</TableCell>
                                    <TableCell className={adminTdMuted}>
                                        {agent.email ? (
                                            <div className="flex items-center space-x-2">
                                                <Mail className="h-4 w-4 text-muted-foreground" />
                                                <span>{agent.email}</span>
                                            </div>
                                        ) : (
                                            <span className="text-muted-foreground/70">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className={adminTdMuted}>
                                        <span className="rounded-full border border-border bg-muted px-3 py-1 text-sm text-foreground dark:bg-slate-800 dark:text-slate-200">
                                            {agent.agencies?.name || 'Unknown'}
                                        </span>
                                    </TableCell>
                                    <TableCell className={adminTdMuted}>
                                        {agent.assignedCarriers && agent.assignedCarriers.length > 0 ? (
                                            <div className="flex flex-wrap gap-1">
                                                {agent.assignedCarriers.map((carrier: any, idx: number) => (
                                                    <span
                                                        key={idx}
                                                        className="rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-900 dark:border-blue-700/50 dark:bg-blue-950/40 dark:text-blue-300"
                                                        title={carrier.code ? `${carrier.name} (${carrier.code})` : carrier.name}
                                                    >
                                                        {carrier.name}
                                                    </span>
                                                ))}
                                            </div>
                                        ) : (
                                            <span className="text-sm text-muted-foreground/70">-</span>
                                        )}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex justify-end space-x-2">
                                            <Button variant="ghost" size="icon" onClick={() => openDialog(agent)} className="text-foreground hover:bg-muted dark:text-slate-200 dark:hover:bg-slate-800">
                                                <Pencil className="h-4 w-4" />
                                            </Button>
                                            <Button variant="ghost" size="icon" className="text-destructive hover:bg-destructive/10 dark:text-red-300 dark:hover:bg-red-900/40" onClick={() => handleDeleteAgent(agent.id)}>
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))
                        )}
                    </TableBody>
                </Table>
                {filteredAgents.length > 0 && (
                    <div className={cn('flex items-center justify-between border-t border-border px-4 py-3 dark:border-slate-800', adminPaginationBar)}>
                        <div className="text-sm text-muted-foreground">Page {currentPage} of {totalPages}</div>
                        <div className="flex items-center gap-2">
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(1)} disabled={currentPage === 1} className={adminOutlineBtn}>First</Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1} className={adminOutlineBtn}>Previous</Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))} disabled={currentPage === totalPages} className={adminOutlineBtn}>Next</Button>
                            <Button variant="outline" size="sm" onClick={() => setCurrentPage(totalPages)} disabled={currentPage === totalPages} className={adminOutlineBtn}>Last</Button>
                        </div>
                    </div>
                )}
                </CardContent>
            </Card>
        </div>
    )
}
