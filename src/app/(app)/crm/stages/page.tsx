import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listStages } from "@/lib/tenant/stages";
import { StageSettings } from "./StageSettings";

export default async function StageSettingsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "COMPANY_ADMIN") redirect("/crm");

  const ctx = getTenantContext(user);
  const [stages, company] = await Promise.all([
    listStages(prisma, ctx),
    prisma.company.findUnique({ where: { id: ctx.companyId } }),
  ]);

  return (
    <StageSettings
      initialStages={stages.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type as "OPEN" | "WON" | "LOST",
        probability: s.probability,
        order: s.order,
      }))}
      shareAllLeads={company?.shareAllLeads ?? true}
    />
  );
}
