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
