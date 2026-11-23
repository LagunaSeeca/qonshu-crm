import type { PrismaClient, User, UserStatus, Role, Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, isAdmin, type SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";

export class InvalidUserRoleError extends Error {}

// WHAT THIS REPLACES: every function here used to be scoped by COMPANY (a TenantContext of
// `{ companyId }`), which in a one-company org means "everybody". The isolation boundary is now
// the TEAM:
//
//   SUPER_ADMIN    the owner. Creates one COMPANY_ADMIN ("Team Admin") per sales team; sees all.
//   COMPANY_ADMIN  adds MEMBERs to its OWN team, and partner logins for its OWN team's accounts.
//   MEMBER         cannot administer users at all.
//   PARTNER_VIEWER a building's representative. teamId null, pinned to one Account.
//
// Two rules are load-bearing and repeated in each function:
//   1. Only the SUPER_ADMIN creates team admins. A team admin promoting itself a peer (or a
//      second admin into a sibling team) would make the "one admin per team" model unenforceable.
//   2. A team admin naming someone else's teamId/accountId is REJECTED, never silently
//      substituted with its own. Substituting would return 201/200 for something other than what
//      was asked, which is both a lie to the caller and an invitation to probe.

// The roles that live on a team. PARTNER_VIEWER is deliberately absent: a partner login belongs to
// an Account, never to a team, and carries teamId null.
const TEAM_ROLES: Role[] = ["COMPANY_ADMIN", "MEMBER"];

// Users a team admin may see: its own team, PLUS the partner logins pinned to an account that
// belongs to that team. The partner arm is a relation filter rather than a column match because
// a PARTNER_VIEWER has no teamId of its own — its team is whichever team owns its account.
function teamScopedUserWhere(teamId: string, companyId: string | null): Prisma.UserWhereInput {
  return {
    ...(companyId ? { companyId } : {}),
    OR: [{ teamId }, { role: "PARTNER_VIEWER", account: { is: { teamId } } }],
  };
}

// The WHERE for "users this actor may administer". Fails closed: a non-admin role, a team admin
// with no team, and a team admin naming another team all throw rather than widening.
//
// A SUPER_ADMIN is company-wide (team filter optional). Its companyId may legitimately be null —
// the owner sits above the org — in which case there is no company key to filter on; that is the
// one sanctioned unscoped read in this file and it is the SUPER_ADMIN's whole purpose.
function userAdminWhere(user: SessionUser, teamId?: string): Prisma.UserWhereInput {
  if (!isAdmin(user)) throw new ForbiddenError(`${user.role} cannot administer users`);
  if (user.role === "SUPER_ADMIN") {
    if (teamId) return teamScopedUserWhere(teamId, user.companyId);
    return user.companyId ? { companyId: user.companyId } : {};
  }
  if (!user.companyId) throw new ForbiddenError("no company context");
  if (!user.teamId) throw new ForbiddenError("COMPANY_ADMIN is not on a team");
  if (teamId && teamId !== user.teamId) throw new ForbiddenError("that team is not yours");
  return teamScopedUserWhere(user.teamId, user.companyId);
}

// Everyone the actor may administer: their team's members and the partner logins of their team's
// buildings. NOT a picker source — see listAssignableUsers.
// `async` (rather than returning the promise) so a scope violation REJECTS instead of throwing
// synchronously: userAdminWhere throws before any query is built, and a sync throw out of a
// promise-returning function is the classic unhandled-path bug at call sites that only `.catch()`.
export async function listUsers(
  db: PrismaClient,
  user: SessionUser,
  opts: { teamId?: string } = {},
): Promise<User[]> {
  return db.user.findMany({ where: userAdminWhere(user, opts.teamId), orderBy: { createdAt: "asc" } });
}

// Who may be picked as a Lead owner / Account manager.
//
// WHAT THIS FIXES: every owner and assignee picker in the app was fed by listUsers, i.e. by EVERY
// user in the company — including PARTNER_VIEWERs (a building's representative offered as the
// owner of a lead), deactivated people, and other teams' members. This returns only rows that
// resolveAssignableOwner (scope.ts) would actually accept:
//
//   SUPER_ADMIN    every active admin/member (it must name an owner explicitly; see scope.ts)
//   COMPANY_ADMIN  its own team's active admins and members
//   MEMBER         itself, and nothing else — a member's rows are always its own
//   PARTNER_VIEWER nothing: partners cannot own records
export async function listAssignableUsers(db: PrismaClient, user: SessionUser): Promise<User[]> {
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot own records");

  // No team/company read at all: a member's only assignable user is itself, so the picker is a
  // single row and cannot be widened by a bad teamId.
  if (user.role === "MEMBER") {
    const self = await db.user.findFirst({ where: { id: user.id, status: "ACTIVE" } });
    return self ? [self] : [];
  }

  if (!isAdmin(user)) throw new ForbiddenError(`${user.role} cannot be offered an owner picker`);
  let scope: Prisma.UserWhereInput;
  if (user.role === "SUPER_ADMIN") {
    scope = user.companyId ? { companyId: user.companyId } : {};
  } else {
    if (!user.companyId) throw new ForbiddenError("no company context");
    if (!user.teamId) throw new ForbiddenError("COMPANY_ADMIN is not on a team");
    scope = { companyId: user.companyId, teamId: user.teamId };
  }
  return db.user.findMany({
    where: { ...scope, status: "ACTIVE", role: { in: TEAM_ROLES } },
    orderBy: { createdAt: "asc" },
  });
}

// One user, through the same visibility as listUsers. Returns null (not a throw) when the id is
// outside the actor's scope, so callers decide between 404 and a silent skip.
export async function getUser(db: PrismaClient, user: SessionUser, id: string): Promise<User | null> {
  return db.user.findFirst({ where: { AND: [userAdminWhere(user), { id }] } });
}

// Direct user creation replaces the old invite-link flow: an admin types an email + password and
// tells the person directly (no email sending, no APP_URL-dependent links).
//
// The company is DERIVED, never passed: from the named team for a team role, and from the named
// account for a partner login. (The old `companyId` argument existed because a super admin had no
// company of its own; with one org and real teams, the team or the account already answers it, and
// a client-supplied companyId was one more cross-tenant field to police.) It is still checked to
// be ACTIVE: a suspended org gets no new working logins, whoever asks.
export async function createUser(
  db: PrismaClient,
  user: SessionUser,
  args: {
    name: string;
    email: string;
    password: string;
    role: Role;
    accountId?: string | null;
    teamId?: string | null;
  },
): Promise<User> {
  if (!isAdmin(user)) throw new ForbiddenError(`${user.role} cannot create users`);
  // The owner account is provisioned by prisma/scripts/super-admin.ts, deliberately out of band:
  // a second super admin must not be creatable through an authenticated HTTP route.
  if (args.role === "SUPER_ADMIN") {
    throw new InvalidUserRoleError("a SUPER_ADMIN is provisioned by prisma/scripts/super-admin.ts");
  }
  // Rule 1: one admin per team, created by the owner.
  if (args.role === "COMPANY_ADMIN" && user.role !== "SUPER_ADMIN") {
    throw new ForbiddenError("only the super admin can create a team admin");
  }

  let companyId: string;
  let teamId: string | null;
  let accountId: string | null = null;

  if (args.role === "PARTNER_VIEWER") {
    // A partner login is defined by its one account and has no team of its own, so a teamId here
    // is a caller misunderstanding — rejected rather than dropped, so the mistake is visible.
    if (args.teamId) throw new InvalidUserRoleError("teamId is not allowed for PARTNER_VIEWER");
    if (!args.accountId) throw new InvalidUserRoleError("accountId is required for PARTNER_VIEWER");
    const account = await db.account.findUnique({
      where: { id: args.accountId },
      select: { id: true, companyId: true, teamId: true },
    });
    // One message for "no such account", "another company's account" and "another team's
    // account": the caller has no business learning which.
    if (!account) throw new InvalidUserRoleError("accountId is not in your scope");
    if (user.role !== "SUPER_ADMIN") {
      if (account.companyId !== user.companyId || account.teamId !== user.teamId) {
        throw new InvalidUserRoleError("accountId is not in your scope");
      }
    }
    companyId = account.companyId;
    teamId = null;
    accountId = account.id;
  } else {
    if (args.accountId) throw new InvalidUserRoleError("accountId is only allowed for PARTNER_VIEWER");
    if (user.role === "SUPER_ADMIN") {
      // REQUIRED, not defaulted: the owner has no team, so there is no team to fall back to and a
      // silent choice would put the person in whichever team a later line happened to pick.
      if (!args.teamId) throw new InvalidUserRoleError("teamId is required to create a user as a super admin");
      const team = await db.team.findUnique({ where: { id: args.teamId }, select: { id: true, companyId: true } });
      if (!team) throw new NotFoundError("team not found");
      companyId = team.companyId;
      teamId = team.id;
    } else {
      if (!user.companyId) throw new ForbiddenError("no company context");
      if (!user.teamId) throw new ForbiddenError("COMPANY_ADMIN is not on a team");
      // Rule 2: own team or an outright rejection.
      if (args.teamId && args.teamId !== user.teamId) {
        throw new InvalidUserRoleError("teamId does not match your own team");
      }
      companyId = user.companyId;
      teamId = user.teamId;
    }
  }

  const company = await db.company.findUnique({ where: { id: companyId }, select: { status: true } });
  if (!company) throw new NotFoundError("company not found");
  if (company.status !== "ACTIVE") throw new InvalidUserRoleError("company is not active");

  const passwordHash = await hashPassword(args.password);
  return db.user.create({
    data: {
      companyId,
      teamId,
      email: args.email,
      name: args.name,
      passwordHash,
      role: args.role,
      accountId,
      status: "ACTIVE",
    },
  });
}

// Activate/deactivate someone in the actor's own team (company-wide for the owner).
//
// Two refusals that are not about scope:
//   - NOBODY changes their OWN status. The only reachable self-change is self-deactivation, which
//     logs the actor out mid-request (session.ts re-reads status per request) and, for the last
//     admin of a team, locks the team out of its own user administration.
//   - NOBODY deactivates a SUPER_ADMIN, including the SUPER_ADMIN itself. The owner account is the
//     recovery path for every other mistake in this file; it is restored only by
//     prisma/scripts/super-admin.ts, against the database.
export async function setUserStatus(
  db: PrismaClient,
  user: SessionUser,
  id: string,
  status: UserStatus,
): Promise<User> {
  if (id === user.id) throw new ForbiddenError("you cannot change your own status");
  const found = await getUser(db, user, id);
  if (!found) throw new NotFoundError("user not in scope");
  if (found.role === "SUPER_ADMIN") throw new ForbiddenError("the super admin cannot be deactivated");
  return db.user.update({ where: { id: found.id }, data: { status } });
}
