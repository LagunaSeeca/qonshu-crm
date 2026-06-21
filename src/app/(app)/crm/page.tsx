import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listStages } from "@/lib/tenant/stages";
import { listLeads } from "@/lib/tenant/leads";
import { Board } from "./Board";

export default async function CrmBoardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const ctx = getTenantContext(user);
  const [stages, leads] = await Promise.all([listStages(prisma, ctx), listLeads(prisma, user)]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Sales CRM</h1>
        <div className="flex gap-4 text-sm">
          <Link href="/crm/list" className="text-blue-600">List view</Link>
          {user.role === "COMPANY_ADMIN" && (
            <Link href="/crm/stages" className="text-blue-600">Stage settings</Link>
          )}
        </div>
      </div>
      <Board
        stages={stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability }))}
        leads={leads.map((l) => ({ id: l.id, title: l.title, stageId: l.stageId, value: Number(l.value), contactName: l.contactName }))}
      />
    </div>
  );
}
