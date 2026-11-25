import type { PrismaClient, Role, AccountAssignment, Account, Prisma } from "@prisma/client";
import { assertCan, ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

// ============================== THIS TABLE IS AN AUTHORIZATION INPUT =============================
//
// An AccountAssignment row is not a label, a tag or a piece of reporting metadata. It is a GRANT.
// `accountScopeWhere` in src/lib/tenant/scope.ts reads this exact table to decide what a person can
// see:
//
//   MEMBER      { companyId, teamId, AND: [{ OR: [ { accountManagerId: me }, { assignments: { some: { userId: me } } } ] }] }
//   ONBOARDING  { companyId,          AND: [        { assignments: { some: { userId: me } } }                            ] }
//
// So a single INSERT here immediately widens somebody's data access — to the building, its units,
// its residents' names and phone numbers, its tasks, asks, activities and attachments. For an
// ONBOARDING user, whose scope has NO team key at all, the assignment list is the ONLY thing that
// selects any row for them: with zero rows they see nothing, which is the fail-closed direction, and
// each row added is the whole of what they gained.
//
// Treat every write in this file as a privilege grant, not a data edit. Specifically:
//   - the ROLE gate (`manage_account_assignments`) comes FIRST, before any id is read;
//   - the account is resolved through `getAccount`, so the actor's own scope confines WHERE they
//     may grant;
//   - the candidate is re-read FROM THE DATABASE and re-validated, never trusted from the request.
//
// The product rule behind all of it, in the owner's words: "every sales manager and assigned
// onboarding member should only see their buildings data. Several team members can be assigned to
// one building."
// =============================================================================================

export type AccountAssignee = { userId: string; name: string; role: Role };
export type AssignmentCandidate = { id: string; name: string; role: Role };

// The roles that are assignable AND belong to a team. An ONBOARDING user is assignable but is NOT
// in this list, because it is teamless and therefore exempt from the team-match test below.
const TEAM_SCOPED_ASSIGNABLE: readonly Role[] = ["MEMBER", "COMPANY_ADMIN"];

// The WHOLE allowlist. PARTNER_VIEWER and SUPER_ADMIN are absent, and must stay absent — see the
// REFUSED ROLES note in assertEligible.
const ASSIGNABLE_ROLES: readonly Role[] = [...TEAM_SCOPED_ASSIGNABLE, "ONBOARDING"];

type CandidateRow = {
  id: string;
  role: Role;
  status: string;
  companyId: string | null;
  teamId: string | null;
};

// ================================ THE ELIGIBILITY RULE, ONCE ===================================
//
// A user may be assigned to an account if and only if ALL of:
//   1. status === "ACTIVE"                     — a deactivated login is not given new access
//   2. companyId === account.companyId         — tenancy; never taken from the request
//   3. EITHER role === "ONBOARDING"            — teamless activation staff, who serve every team's
//                                                buildings, so NO team match is required
//      OR    role is MEMBER | COMPANY_ADMIN
//            AND teamId === account.teamId     — a sales role may only be assigned inside the team
//                                                that owns the building. Without this, an
//                                                assignment would be a way to read another team's
//                                                book — and note that it would not even work:
//                                                a MEMBER's scope keeps its own `teamId` key, so a
//                                                cross-team row would grant nothing while looking
//                                                like it had.
//   4. id !== account.accountManagerId         — see MANAGER_IS_REFUSED below
//
// REFUSED ROLES, explicitly:
//   PARTNER_VIEWER  a building's own representative, pinned to exactly one account via
//                   User.accountId. Assigning one to a SECOND building would hand an outside party
//                   another customer's residents. There is no legitimate case; this is a hard no.
//   SUPER_ADMIN     already sees every team of the company it is given a context for. A row would
//                   grant nothing it did not have, so it could only MISLEAD — an assignee list that
//                   implies the owner was staffed onto this building, and a revoke that appears to
//                   take access away while changing nothing.
//
// `listAssignmentCandidates` below compiles this SAME rule into one WHERE clause, so the picker can
// never offer a user that `assignUserToAccount` would then reject.
//
// -------------------------------- MANAGER_IS_REFUSED -----------------------------------------
// The account's CURRENT accountManagerId is refused, and that is not an oversight.
//
// The manager ALREADY has access, through `Account.accountManagerId` — it is the first arm of the
// MEMBER scope's OR. The project rule is ONE SOURCE PER FACT, and "this person can see this
// building because they run it" is already stored, in the account row. Writing it a second time as
// an assignment creates two sources for one fact, and two sources drift: reassigning the building
// to a new manager updates Account.accountManagerId but leaves the stale assignment row behind,
// which silently keeps the OLD manager's access alive. The revoke would then have to be remembered
// by hand, in a second place, by whoever did the reassignment.
//
// Refusing the write is what keeps the manager's access derived from exactly one column. (The same
// reasoning is already applied in account-tasks.ts assertAssignable, which short-circuits on the
// manager instead of looking for an assignment row.)
// ---------------------------------------------------------------------------------------------
function assertEligible(candidate: CandidateRow, account: Account): void {
  // ForbiddenError, not NotFoundError, for every arm: by the time we are here the actor has
  // already proved (via getAccount) that it may administer THIS account, so it is entitled to be
  // told that the person it named is not assignable. The message never distinguishes "no such
  // user" from "wrong role" — loadCandidate below collapses those deliberately.
  if (candidate.status !== "ACTIVE") throw new ForbiddenError("that user is not active");
  // The never-assignable ROLES are refused here, ahead of the company test, purely so the message
  // is true: a SUPER_ADMIN has companyId null, so the tenancy check below would reject it with
  // "not in this company" — accurate about the column, wrong about the reason.
  if (!ASSIGNABLE_ROLES.includes(candidate.role)) {
    throw new ForbiddenError(`a ${candidate.role} cannot be assigned to an account`);
  }
  if (!candidate.companyId || candidate.companyId !== account.companyId) {
    throw new ForbiddenError("that user is not in this company");
  }
  if (candidate.id === account.accountManagerId) {
    // ONE SOURCE PER FACT — see MANAGER_IS_REFUSED above.
    throw new ForbiddenError("the account manager already has access to this account");
  }
  // Teamless activation staff serve every team's buildings, so no team match is required.
  if (candidate.role === "ONBOARDING") return;
  if (!candidate.teamId || candidate.teamId !== account.teamId) {
    throw new ForbiddenError("that user is not on this account's team");
  }
}

// A single primary-key read. "No such user" raises the same ForbiddenError shape as "not
// assignable" because the actor has no business learning which — it would turn the assign endpoint
// into a user-id oracle for the whole database.
async function loadCandidate(db: PrismaClient, userId: string): Promise<CandidateRow> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true, companyId: true, teamId: true },
  });
  if (!row) throw new ForbiddenError("that user is not assignable");
  return row;
}

// ============================== WHY THE ROLE GATE IS FIRST ====================================
//
// `assertCan(actor, "manage_account_assignments")` runs BEFORE the account id is looked at, before
// the candidate is looked at, and before any query at all. Two reasons:
//
//  1. SELF-ASSIGNMENT MUST BE IMPOSSIBLE. A MEMBER or an ONBOARDING user naming THEMSELVES is the
//     attack this gate exists for: it would be self-service access to any building's resident names
//     and phone numbers. The gate is a pure role test, so "assign me to building X" is refused for
//     the same reason as "assign my colleague to building X" — there is no self-case to get wrong.
//     (guards.ts: manage_account_assignments is COMPANY_ADMIN + SUPER_ADMIN only.)
//
//  2. NO ID ORACLE. Because it is a pure ROLE test that never reads the id, a denied caller gets a
//     byte-identical ForbiddenError for a REAL account id, ANOTHER TEAM's account id and an
//     INVENTED one. The refusal therefore confirms nothing about which ids exist. This is the same
//     capability-before-scope ordering as getWritableAccount in accounts.ts, and the reason the
//     404-before-403 discipline is not violated by it: nothing was looked up to leak.
//
// The SCOPE check (getAccount -> null -> NotFoundError) handles the other direction: an id the
// actor may not administer stays a 404 and never becomes a 403 that would confirm the id exists.
// For a COMPANY_ADMIN that confines granting to their own team; a SUPER_ADMIN, given a company
// context, may act on any team in it.
// =============================================================================================
async function requireAdministrableAccount(
  db: PrismaClient,
  actor: SessionUser,
  accountId: string,
): Promise<Account> {
  assertCan(actor, "manage_account_assignments"); // FIRST — before the id is read. See above.
  const account = await getAccount(db, actor, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  return account;
}

// Grant `userId` access to `accountId`.
//
// IDEMPOTENT by the (accountId, userId) unique key: assigning somebody twice is a no-op that
// returns the existing row rather than a 409. Re-pressing "assign" (or two admins doing it at once)
// is not an error condition — the desired state is already the state. `createdById` is kept from
// the FIRST grant on purpose: the audit question is who opened this access, not who last re-pressed
// a button that changed nothing.
export async function assignUserToAccount(
  db: PrismaClient,
  actor: SessionUser,
  accountId: string,
  userId: string,
): Promise<AccountAssignment> {
  const account = await requireAdministrableAccount(db, actor, accountId);
  assertEligible(await loadCandidate(db, userId), account);
  return db.accountAssignment.upsert({
    where: { accountId_userId: { accountId: account.id, userId } },
    create: {
      companyId: account.companyId,
      accountId: account.id,
      userId,
      // Bare id, audit only (no relation on the column) — deleting the actor must never cascade
      // into, nor be blocked by, somebody else's grant.
      createdById: actor.id,
    },
    update: {},
  });
}

// Revoke `userId`'s access to `accountId`, and hand back the work they can no longer see.
//
// ONE TRANSACTION, three statements. Revoking access while leaving that person named as the
// assignee of an open onboarding step or account task would leave them holding work that has
// vanished from their lists — a step nobody is chasing, assigned to somebody who cannot open the
// building. Either both happen or neither does.
//
// ONLY OPEN ROWS ARE CLEARED (`done: false`). A COMPLETED step or task is history: "Ayşe sent the
// residents the SMS" stays true after Ayşe moves off the building, and blanking the assignee would
// rewrite the record of who did the work.
//
// deleteMany, not delete: unassigning somebody who is not assigned is a no-op rather than a P2025.
// Like assign, the desired end state is the only thing that matters.
export async function unassignUserFromAccount(
  db: PrismaClient,
  actor: SessionUser,
  accountId: string,
  userId: string,
): Promise<void> {
  const account = await requireAdministrableAccount(db, actor, accountId);
  await db.$transaction(async (tx) => {
    await tx.accountAssignment.deleteMany({ where: { accountId: account.id, userId } });
    await tx.onboardingStep.updateMany({
      where: { accountId: account.id, assigneeId: userId, done: false },
      data: { assigneeId: null },
    });
    await tx.accountTask.updateMany({
      where: { accountId: account.id, assigneeId: userId, done: false },
      data: { assigneeId: null },
    });
  });
}

// Who is assigned to this building.
//
// READABLE BY ANYONE WHO CAN SEE THE ACCOUNT — deliberately NOT gated on
// manage_account_assignments. "Several team members can be assigned to one building", so a MEMBER
// working a building needs to know who else is on it (and who to hand a task to). The authorization
// is TWO gates, not one: `manage_onboarding` for the role (partner logins are refused — see the
// assertCan below), then the account itself, since `getAccount` applies accountScopeWhere, so a
// caller who cannot see the building gets the 404 and never learns who staffs it.
//
// The ACCOUNT MANAGER IS NOT IN THIS LIST, because they are not an assignment — see
// MANAGER_IS_REFUSED. A caller that wants "everybody with access" composes this with
// `Account.accountManagerId`, which it already has.
export async function listAccountAssignees(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
): Promise<AccountAssignee[]> {
  // WHO STAFFS A BUILDING IS QONSHU'S INTERNAL RECORD, so the account scope below is NOT a
  // sufficient gate on its own. A PARTNER_VIEWER's accountScopeWhere pins them to their own
  // account, so `getAccount` SUCCEEDS for it — without this line the building's own
  // representative could read the names and roles of every employee assigned to them.
  // manage_onboarding is exactly the right list (ONBOARDING | MEMBER | COMPANY_ADMIN |
  // SUPER_ADMIN): it admits the assigned onboarding user this function exists to serve while
  // excluding partner logins. The gate lives HERE, not in the route, so a future second caller
  // cannot reintroduce the leak by forgetting it.
  assertCan(user, "manage_onboarding");
  const account = await getAccount(db, user, accountId);
  // Empty list, not a throw: mirrors listAsks/listAccountTasks, so a sub-resource read of an
  // invisible account is indistinguishable from an empty one.
  if (!account) return [];
  const rows = await db.accountAssignment.findMany({
    where: { accountId: account.id },
    orderBy: { createdAt: "asc" },
    select: { userId: true, user: { select: { name: true, role: true } } },
  });
  return rows.map((r) => ({ userId: r.userId, name: r.user.name, role: r.user.role }));
}

// Exactly the users that `assignUserToAccount` would ACCEPT for this account — no more, no less.
//
// This is the same rule as assertEligible, compiled into one WHERE clause rather than restated:
//   ACTIVE, same company, NOT the account manager, and (ONBOARDING | a MEMBER/COMPANY_ADMIN of the
//   account's own team).
// The two must agree, because a picker offering a name the service then refuses is a bug the user
// cannot distinguish from a broken permission.
//
// ALREADY-ASSIGNED USERS ARE NOT FILTERED OUT, on purpose: assign is idempotent, so they ARE part
// of the accepted set and removing them here would make this function something other than "what
// the service accepts". The UI subtracts `listAccountAssignees` if it wants a strictly-new list;
// doing it here would mean two slightly different definitions of eligible.
export async function listAssignmentCandidates(
  db: PrismaClient,
  actor: SessionUser,
  accountId: string,
): Promise<AssignmentCandidate[]> {
  const account = await requireAdministrableAccount(db, actor, accountId);
  const where: Prisma.UserWhereInput = {
    companyId: account.companyId,
    status: "ACTIVE",
    id: { not: account.accountManagerId },
    OR: [
      // Teamless activation staff serve every team's buildings.
      { role: "ONBOARDING" },
      // Sales roles only inside the team that owns the building.
      { role: { in: [...TEAM_SCOPED_ASSIGNABLE] }, teamId: account.teamId },
    ],
  };
  const rows = await db.user.findMany({
    where,
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: { id: true, name: true, role: true },
  });
  return rows;
}

// Accepts a PrismaClient or an interactive-transaction client, so the team move and this cleanup
// land in the same transaction. Same pattern as scope.ts's UserReader.
type AssignmentWriter = Pick<PrismaClient, "accountAssignment">;

// ======================= TEAM-CHANGE CLEANUP (called from users.ts) ===========================
//
// WHEN A USER'S TEAM CHANGES, THEIR GRANTS ON THE OLD TEAM'S BUILDINGS MUST DIE WITH IT.
//
// Assignments are rows that outlive the reason they were created. Move a MEMBER from team A to
// team B and their team-A assignment rows survive untouched, which silently breaks team isolation
// in the one way that is hardest to notice: the rows still exist, the scope still reads them, and
// `/accounts` still lists team A's buildings for somebody who is now in team B. (The MEMBER scope's
// `teamId` key does blunt the leak for a MEMBER specifically — it filters to the NEW team — but a
// COMPANY_ADMIN's scope is purely `{ companyId, teamId }`, and relying on a second filter to
// neutralise a stale grant is exactly the "two sources for one fact" this codebase refuses. The
// grant must not exist.)
//
// ONBOARDING USERS ARE NEVER TOUCHED. They are teamless BY DESIGN (teamId null) and serve every
// team's buildings; their assignment list is the only thing that grants them anything at all, so
// pruning it against a team they do not have would wipe out their entire access.
//
// A team-scoped role with a NULL new team is treated as "no buildings qualify" and loses every
// grant. That is the fail-closed direction: a MEMBER with no team has no book.
//
// Returns the number of grants revoked, so the caller can log or assert on it.
export async function pruneAssignmentsOutsideTeam(
  db: AssignmentWriter,
  candidate: { userId: string; role: Role; teamId: string | null },
): Promise<number> {
  if (candidate.role === "ONBOARDING") return 0;
  const result = await db.accountAssignment.deleteMany({
    where: candidate.teamId
      ? { userId: candidate.userId, account: { teamId: { not: candidate.teamId } } }
      : { userId: candidate.userId },
  });
  return result.count;
}
