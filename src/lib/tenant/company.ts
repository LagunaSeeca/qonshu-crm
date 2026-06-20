import type { PrismaClient } from "@prisma/client";
import type { TenantContext } from "./context";

export async function getCompanySettings(
  db: PrismaClient,
  ctx: TenantContext
): Promise<{ shareAllLeads: boolean }> {
  const c = await db.company.findUnique({ where: { id: ctx.companyId } });
  // fail-closed: if the company is somehow missing, restrict visibility
  return { shareAllLeads: c?.shareAllLeads ?? false };
}
