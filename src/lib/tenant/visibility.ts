import type { SessionUser } from "@/lib/auth/guards";
export function leadVisibilityWhere(user: SessionUser, shareAllLeads: boolean): { companyId: string; ownerId?: string } {
  if (!user.companyId) throw new Error("no tenant context");
  const base = { companyId: user.companyId };
  if (shareAllLeads || user.role === "COMPANY_ADMIN") return base;
  return { ...base, ownerId: user.id };
}
