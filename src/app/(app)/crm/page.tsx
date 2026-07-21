import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listStages } from "@/lib/tenant/stages";
import { listLeadCards } from "@/lib/tenant/leads";
import { PageHeader } from "@/components/PageHeader";
import { Board } from "./Board";

export default async function CrmBoardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const ctx = getTenantContext(user);
  const [stages, leads] = await Promise.all([listStages(prisma, ctx), listLeadCards(prisma, user)]);

  return (
    <div className="space-y-6">
      <PageHeader title="Sales CRM" subtitle="Manage your pipeline" />
      <Board
        stages={stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability }))}
        leads={leads}
        isAdmin={user.role === "COMPANY_ADMIN"}
      />
    </div>
  );
}
