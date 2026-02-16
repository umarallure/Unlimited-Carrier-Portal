'use client'

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Home, Briefcase, FileText, Upload, Users, Shield, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import type { User, AuthChangeEvent, Session } from '@supabase/supabase-js';

const Sidebar = () => {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const supabase = createClient();

    useEffect(() => {
        supabase.auth.getUser().then((res: { data: { user: User | null } }) => setUser(res.data.user ?? null));
        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event: AuthChangeEvent, session: Session | null) => setUser(session?.user ?? null));
        return () => subscription.unsubscribe();
    }, []);

    const handleSignOut = async () => {
        await supabase.auth.signOut();
        router.push('/login');
        router.refresh();
    };

    return (
        <div className="h-screen w-72 bg-slate-950 border-r border-slate-800 text-white flex flex-col">
            <div className="p-6 border-b border-slate-800">
                <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-xl bg-slate-800 flex items-center justify-center">
                        <Shield className="w-6 h-6 text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-semibold text-slate-50">Admin Panel</h1>
                        <p className="text-xs text-slate-400">Unlimited Insurance</p>
                    </div>
                </div>
            </div>

            <nav className="flex-1 p-4 space-y-1">
                <Link
                    href="/"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <Home size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Dashboard</span>
                </Link>

                <Link
                    href="/agencies"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <Briefcase size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Agencies</span>
                </Link>

                <Link
                    href="/carriers"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <FileText size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Carriers</span>
                </Link>

                <Link
                    href="/agents"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <Users size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Agents</span>
                </Link>

                <Link
                    href="/records"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <FileText size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Records</span>
                </Link>

                <Link
                    href="/upload-tree"
                    className="group flex items-center space-x-3 px-3 py-2 rounded-lg hover:bg-slate-900 transition-colors"
                >
                    <div className="w-8 h-8 rounded-md bg-slate-900 flex items-center justify-center">
                        <Upload size={18} className="text-slate-200" />
                    </div>
                    <span className="text-sm font-medium text-slate-100">Organization Tree (Upload)</span>
                </Link>
            </nav>

            <div className="p-4 border-t border-slate-800 space-y-2">
                {user?.email && (
                    <p className="text-xs text-slate-400 truncate px-1" title={user.email}>{user.email}</p>
                )}
                <Button variant="ghost" size="sm" className="w-full justify-start text-slate-300 hover:text-slate-100" onClick={handleSignOut}>
                    <LogOut className="w-4 h-4 mr-2" />
                    Sign out
                </Button>
                <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                    <p className="text-xs text-slate-500">Unlimited Insurance Admin</p>
                    <p className="text-sm font-medium text-slate-200 mt-1">v2.0</p>
                </div>
            </div>
        </div>
    );
};

export default Sidebar;
