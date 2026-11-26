import type { PrismaClient, User, UserStatus, Role, Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError, isAdmin, type SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { pruneAssignmentsOutsideTeam } from "./account-assignments";

export class InvalidUserRoleError extends Error {}

// WHAT THIS REPLACES: every function here used to be scoped by COMPANY (a TenantContext of
// `{ companyId }`), which in a one-company org means "everybody". The isolation boundary is now
// the TEAM:
//
//   SUPER_ADMIN    the owner. Creates one COMPANY_ADMIN ("Team Admin") per sales team; sees all.
//   COMPANY_ADMIN  adds MEMBERs to its OWN team, and partner logins for its OWN team's accounts.
//   MEMBER         cannot administer users at all.
//   ONBOARDING     activation staff. teamId null; company-wide, but sees only ASSIGNED accounts.
//   PARTNER_VIEWER a building's representative. teamId null, pinned to one Account.
//
// Three rules are load-bearing and repeated in each function:
//   1. Only the SUPER_ADMIN creates team admins. A team admin promoting itself a peer (or a
//      second admin into a sibling team) would make the "one admin per team" model unenforceable.
//   2. A team admin naming someone else's teamId/accountId is REJECTED, never silently
//      substituted with its own. Substituting would return 201/200 for something other than what
//      was asked, which is both a lie to the caller and an invitation to probe.
//   3. Only the SUPER_ADMIN creates ONBOARDING users, and they always land with teamId null.
//      Same reasoning as rule 1, one step stronger: an ONBOARDING login is a COMPANY-WIDE identity
//      (no team filter at all — see accountScopeWhere), so a team admin able to mint one would be
//      minting a role whose reach exceeds their own.

// The roles that live on a team. PARTNER_VIEWER is deliberately absent: a partner login belongs to
// an Account, never to a team, and carries teamId null. ONBOARDING is absent for the same reason in
// mirror image: it belongs to the company and reaches buildings through AccountAssignment rows.
//
// This constant is ALSO what keeps ONBOARDING out of every owner picker (it is the `role: { in: }`
// filter in listAssignableUsers below), matching OWNABLE_ROLES in scope.ts, which refuses to resolve
// one as a Lead owner or Account manager. Both lists are allowlists of the same two roles, so the
// new role was excluded by construction rather than by remembering to exclude it.
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
//
// `includeSuperAdmins` is OPT-IN AND LEAD-ONLY. Accounts and Tasks are fed by this same function,
// and a SUPER_ADMIN must not be offered as an account manager or a task assignee (scope.ts
// OWNABLE_ROLES still refuses one), so the DEFAULT behaviour must not change. The flag adds the
// ACTIVE SUPER_ADMINs of the actor's own company, and only when the ACTOR IS a SUPER_ADMIN with a
// concrete company context — matching resolveLeadOwner, which accepts the super admin as a lead
// owner only when it names ITSELF. A COMPANY_ADMIN passing the flag gets nothing extra, and a
// super admin whose own companyId is null gets nothing extra either (its scope is `{}`, so
// widening the role filter there would list every super admin on the platform).
export async function listAssignableUsers(
  db: PrismaClient,
  user: SessionUser,
  opts: { includeSuperAdmins?: boolean } = {},
): Promise<User[]> {
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
  // TEAM_ROLES itself is NEVER mutated — it is shared with scope.ts's OWNABLE_ROLES and with
  // setUserTeam. The extra role is added to a per-call copy.
  const roles: Role[] = [...TEAM_ROLES];
  if (opts.includeSuperAdmins && user.role === "SUPER_ADMIN" && user.companyId) {
    roles.push("SUPER_ADMIN");
  }
  return db.user.findMany({
    where: { ...scope, status: "ACTIVE", role: { in: roles } },
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
    // READ ON THE ONBOARDING BRANCH ONLY, and only ever from a SUPER_ADMIN (that branch is
    // SUPER_ADMIN-gated before this value is touched). Every other role derives its company from
    // the named team or the named account, which is why this argument does not exist for them —
    // see the note above about a client-supplied companyId being one more cross-tenant field to
    // police. An ONBOARDING user has NEITHER a team NOR an account, so there is nothing left to
    // derive it from: the owner, whose own companyId is null because they sit above the org, must
    // say which company the login belongs to.
    companyId?: string;
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
  // Rule 3: ONBOARDING is the owner's to grant. ForbiddenError, not InvalidUserRoleError, because
  // this is an authorization refusal rather than a malformed request — a COMPANY_ADMIN asking for
  // one is asking for something they are not allowed to have, not something that cannot exist.
  if (args.role === "ONBOARDING" && user.role !== "SUPER_ADMIN") {
    throw new ForbiddenError("only the super admin can create an onboarding user");
  }

  let companyId: string;
  let teamId: string | null;
  let accountId: string | null = null;

  if (args.role === "ONBOARDING") {
    // TEAM FORCED TO NULL, and a named team REJECTED rather than dropped (rule 2's shape): an
    // onboarding user works every team's buildings and is confined by AccountAssignment rows, so a
    // teamId would be a filter that means nothing — and silently honouring one would create a role
    // the scope helpers do not expect to find a team on.
    if (args.teamId) throw new InvalidUserRoleError("teamId is not allowed for ONBOARDING");
    if (args.accountId) throw new InvalidUserRoleError("accountId is only allowed for PARTNER_VIEWER");
    // The SUPER_ADMIN's own companyId may legitimately be null (it sits above the org), but an
    // ONBOARDING user must have a company — accountScopeWhere's requireCompany throws otherwise and
    // the login would be unusable. Named explicitly, never defaulted.
    const named = args.companyId ?? user.companyId;
    if (!named) throw new InvalidUserRoleError("companyId is required to create an onboarding user");
    companyId = named;
    teamId = null;
  } else if (args.role === "PARTNER_VIEWER") {
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

// Move a team-scoped user to another team of the same company — AND REVOKE THE GRANTS THEY LEAVE
// BEHIND.
//
// WHY THE CLEANUP LIVES INSIDE THE MOVE, in the same transaction. Access to a building now comes
// from an AccountAssignment row (scope.ts accountScopeWhere reads that table), and those rows name
// an ACCOUNT, not a team. So moving a MEMBER from team A to team B leaves every team-A grant they
// held intact, which silently breaks team isolation: the rows still exist and the scope still reads
// them. There is no safe "clean it up afterwards" — a crash between the two writes would leave a
// user sitting in team B holding live grants on team A's buildings, so the move and the revoke are
// one atomic fact. See pruneAssignmentsOutsideTeam in ./account-assignments for the rule itself
// (and for why an ONBOARDING user, being teamless by design, is never pruned).
//
// Scope and refusals mirror setUserStatus above: the target must be inside the actor's own
// visibility, and nobody moves themselves (a COMPANY_ADMIN moving itself out of its team would
// take its own team's user administration with it, mid-request). The destination team is validated
// against the DB and must be in the same company — a teamId is client input that decides which
// book someone can read.
export async function setUserTeam(
  db: PrismaClient,
  user: SessionUser,
  id: string,
  teamId: string,
): Promise<User> {
  if (id === user.id) throw new ForbiddenError("you cannot change your own team");
  const found = await getUser(db, user, id);
  if (!found) throw new NotFoundError("user not in scope");
  // ONBOARDING, SUPER_ADMIN and PARTNER_VIEWER are teamless by design (see the role table at the
  // top of this file); putting any of them on a team would create a role shape the scope functions
  // do not model.
  if (!TEAM_ROLES.includes(found.role)) {
    throw new InvalidUserRoleError(`a ${found.role} is not on a team`);
  }
  const team = await db.team.findUnique({ where: { id: teamId }, select: { id: true, companyId: true } });
  if (!team || team.companyId !== found.companyId) throw new NotFoundError("team not found");
  if (team.id === found.teamId) return found;

  return db.$transaction(async (tx) => {
    const moved = await tx.user.update({ where: { id: found.id }, data: { teamId: team.id } });
    // Atomic with the move: the grants they held on their OLD team's buildings die with the move.
    await pruneAssignmentsOutsideTeam(tx, { userId: moved.id, role: moved.role, teamId: moved.teamId });
    return moved;
  });
}
