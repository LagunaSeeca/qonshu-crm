import type { Role } from "@prisma/client";

// `teamId` is REQUIRED (not optional) on purpose. Team membership is now the isolation boundary:
// a MEMBER sees only their own rows, a COMPANY_ADMIN ("Team Admin") sees their whole team, and a
// SUPER_ADMIN — teamId null — sees everything. Were this optional, a caller that forgot to set it
// would silently fall through to an `undefined` team filter instead of failing to compile, which
// is a data-leak shape rather than a bug. Null is the explicit "no team" value, used by
// SUPER_ADMIN and by PARTNER_VIEWER (scoped to one Account via accountId instead).
export type SessionUser = { id: string; companyId: string | null; teamId: string | null; role: Role; accountId?: string | null };
export type Action = "manage_users" | "manage_companies" | "view_company_data";
export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

const MATRIX: Record<Action, Role[]> = {
  manage_companies: ["SUPER_ADMIN"],
  manage_users: ["COMPANY_ADMIN", "SUPER_ADMIN"],
  view_company_data: ["COMPANY_ADMIN", "MEMBER"],
};

export function can(user: SessionUser, action: Action): boolean {
  return MATRIX[action].includes(user.role);
}

// The two roles that may administer a team's book. Use this instead of comparing against
// "COMPANY_ADMIN" by hand: every such comparison that forgot SUPER_ADMIN silently locked the
// super admin out of (or, worse, into the member branch of) an admin-only code path.
export function isAdmin(user: SessionUser): boolean {
  return user.role === "COMPANY_ADMIN" || user.role === "SUPER_ADMIN";
}

// A SUPER_ADMIN passes any list that admits a COMPANY_ADMIN, because "a super admin can do
// anything a team admin can" is a rule of the business model rather than of each call site —
// encoding it here is what spares ~38 route handlers from having to spell `["COMPANY_ADMIN",
// "SUPER_ADMIN"]` and from drifting the day one of them forgets.
//
// This widens the ROLE gate only. It does NOT widen data scope: every tenant read/write re-scopes
// through leadScopeWhere/accountScopeWhere/getTenantContext, all of which require a concrete
// companyId and throw for a SUPER_ADMIN's null one. So a super admin reaching one of these
// handlers gets a tenant-context failure, never another team's rows (see scope.ts).
//
// A list that does NOT include COMPANY_ADMIN is untouched: `assertRole(user, ["MEMBER"])` still
// rejects a SUPER_ADMIN, which is right — those gates exist to catch a non-member caller, not to
// grant privilege.
export function assertRole(user: SessionUser, roles: Role[]): void {
  if (roles.includes(user.role)) return;
  if (user.role === "SUPER_ADMIN" && roles.includes("COMPANY_ADMIN")) return;
  throw new ForbiddenError(`requires ${roles.join("|")}`);
}
