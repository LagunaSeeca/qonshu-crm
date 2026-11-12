import type { Role } from "@prisma/client";

// `teamId` is REQUIRED (not optional) on purpose. Team membership is now the isolation boundary:
// a MEMBER sees only their own rows, a COMPANY_ADMIN ("Team Admin") sees their whole team, and a
// SUPER_ADMIN — teamId null — sees everything. Were this optional, a caller that forgot to set it
// would silently fall through to an `undefined` team filter instead of failing to compile, which
// is a data-leak shape rather than a bug. Null is the explicit "no team" value, used by
// SUPER_ADMIN and by PARTNER_VIEWER (scoped to one Account via accountId instead).
export type SessionUser = { id: string; companyId: string | null; teamId: string | null; role: Role; accountId?: string | null };
export type Action =
  | "manage_users"
  | "manage_companies"
  | "view_payment_detail"
  | "view_settlements"
  | "write_settlements"
  | "view_object_detail";
export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

// Explicit allowlists: the list is the WHOLE truth for an action. Unlike assertRole, there is no
// automatic SUPER_ADMIN widening here (write_settlements admits SUPER_ADMIN but not COMPANY_ADMIN),
// so SUPER_ADMIN is listed wherever it belongs and nowhere else. The removed `view_company_data`
// entry had no callers and omitted SUPER_ADMIN/PARTNER_VIEWER, contradicting the current model.
const MATRIX: Record<Action, readonly Role[]> = {
  manage_companies: ["SUPER_ADMIN"],
  manage_users: ["COMPANY_ADMIN", "SUPER_ADMIN"],
  view_payment_detail: ["PARTNER_VIEWER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  view_settlements: ["PARTNER_VIEWER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  write_settlements: ["SUPER_ADMIN"],
  view_object_detail: ["PARTNER_VIEWER", "COMPANY_ADMIN", "SUPER_ADMIN"],
};

// Fails closed: an unknown/future role or an unknown action yields false, never a default-allow.
export function can(user: SessionUser, action: Action): boolean {
  if (!Object.hasOwn(MATRIX, action)) return false;
  return MATRIX[action].includes(user.role);
}

export function assertCan(user: SessionUser, action: Action): void {
  if (!can(user, action)) throw new ForbiddenError(`not permitted: ${action}`);
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
