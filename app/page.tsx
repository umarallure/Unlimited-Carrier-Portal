
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, FileText, Briefcase, Upload, Activity } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

const tileWrap =
  "rounded-2xl border border-slate-200 bg-card p-5 shadow-sm ring-1 ring-black/[0.04] transition-all duration-200 hover:border-orange-400/50 hover:shadow-md dark:border-slate-800/80 dark:bg-slate-900/45 dark:ring-white/[0.03] dark:hover:border-orange-500/25 dark:hover:shadow-xl dark:hover:shadow-black/40";

const tileIcon =
  "mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-gradient-to-br from-slate-100 to-slate-200/90 text-slate-800 transition-colors group-hover:border-orange-400/40 dark:border-white/[0.06] dark:from-slate-800 dark:to-slate-900 dark:text-slate-100 dark:group-hover:border-orange-500/20";

export default function Home() {
  return (
    <div className="admin-page space-y-10">
      <PageHeader
        title="Dashboard"
        description="High-level overview of agencies, carriers, and data."
        action={
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 shadow-md dark:border-emerald-500/25 dark:shadow-lg dark:shadow-black/20">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              <span className="text-sm font-medium text-emerald-900 dark:text-emerald-100">System online</span>
            </div>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Link href="/agencies" className="group block">
          <div className={tileWrap}>
            <div className={tileIcon}>
              <Briefcase className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-foreground">Agencies</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Create and manage agencies.</p>
          </div>
        </Link>

        <Link href="/carriers" className="group block">
          <div className={tileWrap}>
            <div className={tileIcon}>
              <FileText className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-foreground">Carriers</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Configure carriers per agency.</p>
          </div>
        </Link>

        <Link href="/agents" className="group block">
          <div className={tileWrap}>
            <div className={tileIcon}>
              <Users className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-foreground">Agents</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Maintain the agent directory.</p>
          </div>
        </Link>

        <Link href="/upload-tree" className="group block">
          <div className={tileWrap}>
            <div className={tileIcon}>
              <Upload className="h-5 w-5" />
            </div>
            <h3 className="font-display text-lg font-semibold text-foreground">Upload</h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Upload from the organization tree.</p>
          </div>
        </Link>

      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="border-b border-border pb-4 dark:border-slate-800/80">
              <CardTitle className="font-display text-base font-semibold text-foreground">Quick actions</CardTitle>
            </CardHeader>
            <CardContent className="pt-5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Link href="/agencies" className="rounded-xl border border-border bg-muted/40 px-4 py-4 transition-colors hover:bg-muted dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-600 dark:hover:bg-slate-800/40">
                  <p className="text-sm font-medium text-foreground">Add agency</p>
                  <p className="mt-1 text-xs text-muted-foreground">Create a new agency record.</p>
                </Link>
                <Link href="/carriers" className="rounded-xl border border-border bg-muted/40 px-4 py-4 transition-colors hover:bg-muted dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-600 dark:hover:bg-slate-800/40">
                  <p className="text-sm font-medium text-foreground">Add carrier</p>
                  <p className="mt-1 text-xs text-muted-foreground">Register a new carrier.</p>
                </Link>
                <Link href="/agents" className="rounded-xl border border-border bg-muted/40 px-4 py-4 transition-colors hover:bg-muted dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-600 dark:hover:bg-slate-800/40">
                  <p className="text-sm font-medium text-foreground">Add agent</p>
                  <p className="mt-1 text-xs text-muted-foreground">Onboard a new agent.</p>
                </Link>
                <Link href="/upload-tree" className="rounded-xl border border-border bg-muted/40 px-4 py-4 transition-colors hover:bg-muted dark:border-slate-800/80 dark:bg-slate-950/30 dark:hover:border-slate-600 dark:hover:bg-slate-800/40">
                  <p className="text-sm font-medium text-foreground">Upload file</p>
                  <p className="mt-1 text-xs text-muted-foreground">Upload from the organization tree.</p>
                </Link>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="border-b border-border pb-4 dark:border-slate-800/80">
            <CardTitle className="font-display text-base font-semibold text-foreground">System status</CardTitle>
          </CardHeader>
          <CardContent className="pt-5">
            <div className="space-y-4 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Database</span>
                <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-500/25 dark:text-emerald-200">
                  Online
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Storage</span>
                <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-500/25 dark:text-emerald-200">
                  Healthy
                </span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">API</span>
                <span className="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-xs font-medium text-emerald-800 dark:border-emerald-500/25 dark:text-emerald-200">
                  Responding
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
