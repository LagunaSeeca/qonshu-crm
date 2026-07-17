import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listStages } from "@/lib/tenant/stages";
import { listLeads } from "@/lib/tenant/leads";
import { listUsers } from "@/lib/tenant/users";
import { LeadCreate } from "../LeadCreate";
import { LeadTable, type LeadRow } from "../LeadTable";
import { Input } from "@/components/ui/input";
import { LayoutGrid, List } from "lucide-react";

export default async function CrmListPage({ searchParams }: { searchParams: Promise<{ q?: string; stageId?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const ctx = getTenantContext(user);
  const sp = await searchParams;
  const [stages, leads, users] = await Promise.all([
    listStages(prisma, ctx),
    listLeads(prisma, user, { q: sp.q, stageId: sp.stageId }),
    listUsers(prisma, ctx),
  ]);

  const stageMap = Object.fromEntries(stages.map((s) => [s.id, s.name]));
  const userMap = Object.fromEntries(users.map((u) => [u.id, u.name ?? u.email]));

  const rows: LeadRow[] = leads.map((l) => ({
    id: l.id,
    title: l.title,
    contactName: l.contactName,
    stageName: stageMap[l.stageId] ?? l.stageId,
    priority: l.priority,
    ownerName: userMap[l.ownerId ?? ""] ?? "—",
  }));

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sales CRM</h1>
        <p className="text-sm text-muted-foreground mt-1">All leads in your pipeline</p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* View toggle */}
        <div className="flex items-center rounded-md border border-border bg-background overflow-hidden">
          <Link
            href="/crm"
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
            Board
          </Link>
          <span className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground">
            <List className="h-3.5 w-3.5" />
            List
          </span>
        </div>

        {/* Filters form */}
        <form method="GET" className="flex items-center gap-2 flex-1">
          <Input
            name="q"
            defaultValue={sp.q ?? ""}
            placeholder="Search leads..."
            className="h-8 text-sm max-w-xs"
          />
          <select
            name="stageId"
            defaultValue={sp.stageId ?? ""}
            className="h-8 rounded-md border border-input bg-background px-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring transition-colors duration-150"
          >
            <option value="">All stages</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <button
            type="submit"
            className="h-8 px-3 rounded-md border border-input bg-muted text-sm font-medium hover:bg-muted/70 transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-ring"
          >
            Filter
          </button>
        </form>

        {/* New Lead button */}
        <div className="ml-auto">
          <LeadCreate
            stages={stages.map((s) => ({ id: s.id, name: s.name }))}
            members={users.map((u) => ({ id: u.id, name: u.name ?? u.email }))}
          />
        </div>
      </div>

      {/* Table */}
      <LeadTable rows={rows} />
    </div>
  );
}
