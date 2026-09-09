import type { PrismaClient } from "@prisma/client";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";
export function leadVisibilityWhere(user: SessionUser, shareAllLeads: boolean): { companyId: string; ownerId?: string } {
  if (!user.companyId) throw new Error("no tenant context");
  // Partner logins never see the sales pipeline — CRM, dashboard, reports, and "my work"
  // all resolve their scope through this function, so this single check blocks all of them.
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot access CRM");
  const base = { companyId: user.companyId };
  if (shareAllLeads || user.role === "COMPANY_ADMIN") return base;
  return { ...base, ownerId: user.id };
}

// leadVisibilityWhere + the company's shareAllLeads lookup in one call — the WHERE every
// tenant-scoped lead read starts from.
//
// It lives HERE rather than in leads.ts so lead-conversion.ts can scope its own lead lookup
// without importing leads.ts: leads.ts imports lead-conversion.ts for the auto-convert-on-Won,
// and that pair has to stay acyclic.
export async function leadScopeWhere(db: PrismaClient, user: SessionUser) {
  const company = await db.company.findUnique({ where: { id: user.companyId! } });
  return leadVisibilityWhere(user, company?.shareAllLeads ?? true);
}
