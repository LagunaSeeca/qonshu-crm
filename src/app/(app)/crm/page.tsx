import { redirect } from "next/navigation";
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
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sales CRM</h1>
        <p className="text-sm text-muted-foreground mt-1">Manage your pipeline</p>
      </div>
      <Board
        stages={stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability }))}
        leads={leads.map((l) => ({
          id: l.id,
          title: l.title,
          stageId: l.stageId,
          contactName: l.contactName,
          priority: l.priority,
        }))}
        isAdmin={user.role === "COMPANY_ADMIN"}
      />
    </div>
  );
}
