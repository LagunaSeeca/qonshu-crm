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
  | "view_financials"
  | "view_object_detail"
  | "edit_accounts"
  | "manage_onboarding"
  | "manage_account_assignments";
export class ForbiddenError extends Error {}
export class NotFoundError extends Error {}

// Explicit allowlists: the list is the WHOLE truth for an action. Unlike assertRole, there is no
// automatic SUPER_ADMIN widening here, so SUPER_ADMIN is listed wherever it belongs and nowhere
// else — and, for the same reason, so is COMPANY_ADMIN: `write_settlements` listing only
// SUPER_ADMIN locked team admins out of the transfer routes these capabilities replaced
// (`assertRole(user, ["COMPANY_ADMIN"])` on master), which left nobody but the super admin able to
// record a transfer. The removed `view_company_data` entry had no callers and omitted
// SUPER_ADMIN/PARTNER_VIEWER, contradicting the current model.
const MATRIX: Record<Action, readonly Role[]> = {
  manage_companies: ["SUPER_ADMIN"],
  manage_users: ["COMPANY_ADMIN", "SUPER_ADMIN"],
  view_payment_detail: ["PARTNER_VIEWER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  view_settlements: ["PARTNER_VIEWER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  // SUPER_ADMIN ALONE, by explicit product rule: "only superadmin should be able to add
  // settlements transfers". Do NOT widen this to COMPANY_ADMIN again. It was widened once,
  // because a team admin got a 403 from a transfer control the UI still rendered — but the 403
  // was correct and the UI was the bug; the control is now hidden unless the viewer holds this
  // capability. A transfer row moves `remaining`/`owed` directly, i.e. what Qonshu owes a
  // partner, so write authority stays with the owner.
  write_settlements: ["SUPER_ADMIN"],
  // EVERYONE EXCEPT ONBOARDING — and that is the whole reason this action exists.
  //
  // "Money" was never one capability. A MEMBER holds NEITHER view_payment_detail NOR
  // view_settlements, yet a member legitimately reads service fees (CRM billing for the buildings
  // they manage) and the per-unit debt/balance that comes back with view_object_detail. So there
  // was no existing action that could be denied to ONBOARDING without ALSO taking those figures
  // away from a MEMBER, which is a behaviour change the owner did not ask for.
  //
  // ONBOARDING staff are activation staff: they need the building, its units and the residents'
  // names and phone numbers to run the post-contract checklist (SMS, WhatsApp, app training). They
  // have no business seeing what the building owes, what it has paid, or what Qonshu invoices it.
  // This action is the line between those two things, and it is enforced in the SERVICES (server
  // components call them directly and hand the result to the client bundle, so a route-only gate
  // still ships the numbers to the browser).
  //
  // PARTNER_VIEWER is listed because a building's own representative reads their own building's
  // money — that is the partner portal's entire purpose, and it already holds the strictly
  // narrower view_payment_detail / view_settlements.
  view_financials: ["PARTNER_VIEWER", "MEMBER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  // ONBOARDING is ADDED here: the checklist steps are "send the residents an SMS", "add them to
  // the WhatsApp group", "train the manager" — none of which can be done without the unit list and
  // the owner names/phones that this capability unlocks. It carries no money (see view_financials,
  // which strips debt/balance/net from the same payload for a role that lacks it).
  view_object_detail: ["PARTNER_VIEWER", "ONBOARDING", "COMPANY_ADMIN", "SUPER_ADMIN"],
  // ACCOUNT AND SUB-RESOURCE WRITES, as ONE gate.
  //
  // Before this, every account mutator authorized purely with getAccount — i.e. "if you can read
  // it you can write it". That is sound while read scope and write scope coincide, and it stopped
  // being true the moment ACCESS COULD COME FROM AN ASSIGNMENT: an ONBOARDING user assigned to a
  // building is inside that building's read scope, so without a role gate they could rename it
  // (which re-stakes the pending partner link), flip its status (DEMO -> ACTIVE seeds a checklist),
  // delete it outright, mint a PARTNER_VIEWER login, or edit its fields, fees, installs, tasks and
  // asks. None of that is activation work.
  //
  // PARTNER_VIEWER is excluded for the same reason it always was: a building's representative is a
  // reader of their own building, never an editor of our CRM record of it.
  edit_accounts: ["MEMBER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  // READ AND WRITE of the post-contract onboarding checklist. ONBOARDING is the role the checklist
  // exists for; the sales side keeps access because the manager who closed the building is the
  // person chasing the activation, and an admin has to be able to see where it is stuck.
  //
  // PARTNER_VIEWER is absent on purpose and must stay absent: the checklist is Qonshu's internal
  // record of how an activation is going, including steps that are about the customer rather than
  // for them. A building's representative must never see it.
  manage_onboarding: ["ONBOARDING", "MEMBER", "COMPANY_ADMIN", "SUPER_ADMIN"],
  // WHO MAY GRANT ACCESS TO A BUILDING. Assignment is now a visibility primitive — an
  // AccountAssignment row is what puts a building in a MEMBER's or an ONBOARDING user's scope — so
  // the power to create one is the power to widen somebody's data access. That belongs with the
  // roles that already administer people (manage_users), and nowhere else: a MEMBER who could
  // assign could hand their own book to anyone, and an ONBOARDING user who could assign could
  // grant themselves every building in the company.
  manage_account_assignments: ["COMPANY_ADMIN", "SUPER_ADMIN"],
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
