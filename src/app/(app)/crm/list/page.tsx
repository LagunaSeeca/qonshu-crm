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
    value: Number(l.value),
    priority: l.priority,
    ownerName: userMap[l.ownerId ?? ""] ?? "—",
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Leads</h1>
        <Link href="/crm" className="text-sm text-blue-600">Board view →</Link>
      </div>
      <form method="GET" className="flex gap-2">
        <input name="q" defaultValue={sp.q ?? ""} placeholder="Search leads..." className="border p-2 rounded text-sm w-64" />
        <button type="submit" className="bg-gray-200 px-3 py-2 rounded text-sm">Search</button>
      </form>
      <LeadCreate stages={stages.map((s) => ({ id: s.id, name: s.name }))} />
      <LeadTable rows={rows} />
    </div>
  );
}
