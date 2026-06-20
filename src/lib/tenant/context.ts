import type { SessionUser } from "@/lib/auth/guards";
export type TenantContext = { companyId: string };
export function getTenantContext(user: SessionUser): TenantContext {
  if (!user.companyId) throw new Error("no tenant context for this user");
  return { companyId: user.companyId };
}
