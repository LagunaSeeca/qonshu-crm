import type { Role } from "@prisma/client";

export type SessionUser = { id: string; companyId: string | null; role: Role; accountId?: string | null };
export type Action = "manage_users" | "manage_companies" | "view_company_data";
export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

const MATRIX: Record<Action, Role[]> = {
  manage_companies: ["SUPER_ADMIN"],
  manage_users: ["COMPANY_ADMIN"],
  view_company_data: ["COMPANY_ADMIN", "MEMBER"],
};

export function can(user: SessionUser, action: Action): boolean {
  return MATRIX[action].includes(user.role);
}

export function assertRole(user: SessionUser, roles: Role[]): void {
  if (!roles.includes(user.role)) throw new ForbiddenError(`requires ${roles.join("|")}`);
}
