
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, FileText, Briefcase, Upload, Activity } from "lucide-react";
import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-50 mb-1">Dashboard</h1>
          <p className="text-sm text-slate-400">High-level overview of agencies, carriers, and data.</p>
        </div>
        <div className="bg-slate-900 border border-slate-800 px-5 py-3 rounded-lg">
          <div className="flex items-center space-x-2">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-medium text-slate-200">System online</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
        <Link href="/agencies" className="group">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 hover:bg-slate-900/80 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-md bg-slate-800 flex items-center justify-center">
                <Briefcase className="h-5 w-5 text-slate-100" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium text-slate-50">Agencies</h3>
              <p className="text-xs text-slate-400">Create and manage agencies.</p>
            </div>
          </div>
        </Link>

        <Link href="/carriers" className="group">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 hover:bg-slate-900/80 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-md bg-slate-800 flex items-center justify-center">
                <FileText className="h-5 w-5 text-slate-100" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium text-slate-50">Carriers</h3>
              <p className="text-xs text-slate-400">Configure carriers per agency.</p>
            </div>
          </div>
        </Link>

        <Link href="/agents" className="group">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 hover:bg-slate-900/80 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-md bg-slate-800 flex items-center justify-center">
                <Users className="h-5 w-5 text-slate-100" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium text-slate-50">Agents</h3>
              <p className="text-xs text-slate-400">Maintain the agent directory.</p>
            </div>
          </div>
        </Link>

        <Link href="/upload-tree" className="group">
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 hover:bg-slate-900/80 transition-colors">
            <div className="flex items-center justify-between mb-3">
              <div className="w-10 h-10 rounded-md bg-slate-800 flex items-center justify-center">
                <Upload className="h-5 w-5 text-slate-100" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-medium text-slate-50">Upload</h3>
              <p className="text-xs text-slate-400">Upload from the organization tree.</p>
            </div>
          </div>
        </Link>

      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-lg p-5">
          <h3 className="text-base font-medium text-slate-100 mb-4">Quick actions</h3>
          <div className="grid grid-cols-2 gap-3">
            <Link href="/agencies" className="px-4 py-3 rounded-md border border-slate-800 hover:bg-slate-800/80 transition-colors">
              <p className="text-sm font-medium text-slate-50">Add agency</p>
              <p className="text-xs text-slate-400 mt-1">Create a new agency record.</p>
            </Link>
            <Link href="/carriers" className="px-4 py-3 rounded-md border border-slate-800 hover:bg-slate-800/80 transition-colors">
              <p className="text-sm font-medium text-slate-50">Add carrier</p>
              <p className="text-xs text-slate-400 mt-1">Register a new carrier.</p>
            </Link>
            <Link href="/agents" className="px-4 py-3 rounded-md border border-slate-800 hover:bg-slate-800/80 transition-colors">
              <p className="text-sm font-medium text-slate-50">Add agent</p>
              <p className="text-xs text-slate-400 mt-1">Onboard a new agent.</p>
            </Link>
            <Link href="/upload-tree" className="px-4 py-3 rounded-md border border-slate-800 hover:bg-slate-800/80 transition-colors">
              <p className="text-sm font-medium text-slate-50">Upload file</p>
              <p className="text-xs text-slate-400 mt-1">Upload from the organization tree.</p>
            </Link>
          </div>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-lg p-5">
          <h3 className="text-base font-medium text-slate-100 mb-4">System status</h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Database</span>
              <span className="inline-flex items-center rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-300">
                Online
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">Storage</span>
              <span className="inline-flex items-center rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-300">
                Healthy
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-slate-300">API</span>
              <span className="inline-flex items-center rounded-full bg-emerald-900/40 px-2 py-0.5 text-xs font-medium text-emerald-300">
                Responding
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
