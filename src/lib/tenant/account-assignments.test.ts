import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Account, Team, User } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeam, makeUser, su, uniq, buildingKey } from "@/test/fixtures";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import {
  assignUserToAccount, unassignUserFromAccount, listAccountAssignees, listAssignmentCandidates,
} from "./account-assignments";
import { getAccount } from "./accounts";
import { setUserTeam } from "./users";

// ---------------------------------------------------------------------------------------------
// ASSIGNMENT IS A PRIVILEGE GRANT, so these tests are written as authorization tests, not CRUD
// tests. Every denial is asserted TWICE — the call is refused AND the table is checked afterwards —
// because a call that throws after writing has still granted the access.
// ---------------------------------------------------------------------------------------------

function caught(fn: () => Promise<unknown>): Promise<unknown> {
  return fn().then(() => undefined, (e) => e);
}

// Raw account rows: this file is about who may be granted access, so the create path's building
// claim / partner-link machinery is noise here.
async function makeAccount(team: Team, manager: User, name = uniq("Tower ")): Promise<Account> {
  return testPrisma.account.create({
    data: {
      companyId: team.companyId, teamId: team.id, accountManagerId: manager.id,
      name, buildingKey: buildingKey(name),
    },
  });
}

type World = {
  companyId: string;
  teamA: Team; teamB: Team;
  adminA: User; adminB: User;
  m1: User; m2: User; m3: User;
  onboarding: User; partner: User; sa: User;
  accA: Account; accB: Account;
  S: Record<"adminA" | "adminB" | "m1" | "m2" | "m3" | "onboarding" | "partner" | "sa", SessionUser>;
};

// ONE company, TWO sales teams, every role. accA belongs to team A and is managed by m1; accB
// belongs to team B and is managed by m3.
async function world(): Promise<World> {
  const company = await makeCompany();
  const teamA = await makeTeam({ companyId: company.id, name: "Team A" });
  const teamB = await makeTeam({ companyId: company.id, name: "Team B" });
  const adminA = await makeUser("COMPANY_ADMIN", teamA);
  const adminB = await makeUser("COMPANY_ADMIN", teamB);
  const m1 = await makeUser("MEMBER", teamA);
  const m2 = await makeUser("MEMBER", teamA);
  const m3 = await makeUser("MEMBER", teamB);
  // Teamless by design: activation staff serve every team's buildings.
  const onboarding = await makeUser("ONBOARDING", teamA);
  expect(onboarding.teamId).toBeNull();
  const accA = await makeAccount(teamA, m1);
  const accB = await makeAccount(teamB, m3);
  const partner = await makeUser("PARTNER_VIEWER", teamA, { accountId: accA.id });
  // The production owner shape: promoted inside the company, teamId null.
  const sa = await testPrisma.user.update({
    where: { id: (await makeUser("SUPER_ADMIN")).id },
    data: { companyId: company.id },
  });
  const w = {
    companyId: company.id, teamA, teamB, adminA, adminB, m1, m2, m3, onboarding, partner, sa,
    accA, accB,
  };
  return {
    ...w,
    S: {
      adminA: su(adminA), adminB: su(adminB), m1: su(m1), m2: su(m2), m3: su(m3),
      onboarding: su(onboarding), partner: su(partner), sa: su(sa),
    },
  };
}

function rows(accountId: string) {
  return testPrisma.accountAssignment.findMany({ where: { accountId } });
}

describe("account assignments: who may grant access", () => {
  beforeEach(resetDb);
  afterAll(async () => { await testPrisma.$disconnect(); });

  // THE ROLE GATE, and the self-assignment case it exists for. A MEMBER or ONBOARDING user naming
  // THEMSELVES would be self-service access to a building's resident names and phone numbers.
  it("a MEMBER cannot assign anyone — including themselves", async () => {
    const w = await world();
    for (const target of [w.m2.id, w.m1.id /* self */, w.onboarding.id]) {
      expect(await caught(() => assignUserToAccount(testPrisma, w.S.m1, w.accA.id, target)))
        .toBeInstanceOf(ForbiddenError);
    }
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  it("an ONBOARDING user cannot assign anyone — including themselves", async () => {
    const w = await world();
    // Give them real access first, so the refusal is about the CAPABILITY and not about scope:
    // an assigned onboarding user can see the building and still cannot widen it.
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);
    for (const target of [w.onboarding.id /* self */, w.m2.id]) {
      expect(await caught(() => assignUserToAccount(testPrisma, w.S.onboarding, w.accA.id, target)))
        .toBeInstanceOf(ForbiddenError);
    }
    // Still exactly the one row the admin wrote.
    expect(await rows(w.accA.id)).toHaveLength(1);
    // And they cannot grant themselves a SECOND building either.
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.onboarding, w.accB.id, w.onboarding.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accB.id)).toHaveLength(0);
  });

  it("a PARTNER_VIEWER cannot assign anyone, not even on its own account", async () => {
    const w = await world();
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.partner, w.accA.id, w.m2.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.partner, w.accA.id, w.partner.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  // THE ROLE REFUSAL IS NOT AN ID ORACLE: it happens before the id is read, so a real, a foreign
  // and an invented account id all produce the identical error.
  it("the role refusal is identical for a real, a foreign and an invented account id", async () => {
    const w = await world();
    const errs = await Promise.all(
      [w.accA.id, w.accB.id, "acc_does_not_exist"].map((id) =>
        caught(() => assignUserToAccount(testPrisma, w.S.m1, id, w.m2.id))),
    );
    for (const e of errs) expect(e).toBeInstanceOf(ForbiddenError);
    expect(new Set(errs.map((e) => (e as Error).message)).size).toBe(1);
  });

  // SCOPE: an account the actor may not administer stays NotFound. It must never become a 403 that
  // would confirm the id exists.
  it("a team-B admin acting on a team-A account gets NotFound, not Forbidden", async () => {
    const w = await world();
    const e = await caught(() => assignUserToAccount(testPrisma, w.S.adminB, w.accA.id, w.m3.id));
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e).not.toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
    // Same answer for an id that does not exist at all.
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminB, "nope", w.m3.id)))
      .toBeInstanceOf(NotFoundError);
  });

  it("a team-A admin cannot assign a team-B MEMBER to a team-A account", async () => {
    const w = await world();
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m3.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  it("a team-A admin cannot assign a team-B COMPANY_ADMIN either", async () => {
    const w = await world();
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.adminB.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  it("a PARTNER_VIEWER can never be the assignee — a building's rep gets no second building", async () => {
    const w = await world();
    for (const [acc, actor] of [[w.accA, w.S.adminA], [w.accB, w.S.sa]] as const) {
      expect(await caught(() => assignUserToAccount(testPrisma, actor, acc.id, w.partner.id)))
        .toBeInstanceOf(ForbiddenError);
      expect(await rows(acc.id)).toHaveLength(0);
    }
  });

  it("a SUPER_ADMIN can never be the assignee — the row would grant nothing and mislead", async () => {
    const w = await world();
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.sa.id)))
      .toBeInstanceOf(ForbiddenError);
    // Not even the super admin may write one for itself.
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.sa, w.accA.id, w.sa.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  // ONE SOURCE PER FACT: the manager's access comes from Account.accountManagerId, and a second
  // copy of that fact as an assignment row would drift on reassignment.
  it("the account's current manager is refused", async () => {
    const w = await world();
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m1.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
    // ...and becomes assignable once they are no longer the manager.
    await testPrisma.account.update({ where: { id: w.accA.id }, data: { accountManagerId: w.m2.id } });
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m1.id);
    expect(await rows(w.accA.id)).toHaveLength(1);
  });

  it("an INACTIVE candidate is refused", async () => {
    const w = await world();
    await testPrisma.user.update({ where: { id: w.m2.id }, data: { status: "INACTIVE" } });
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  it("a user from another company is refused", async () => {
    const w = await world();
    const otherTeam = await makeTeam();
    const stranger = await makeUser("MEMBER", otherTeam);
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, stranger.id)))
      .toBeInstanceOf(ForbiddenError);
    // An id that is not a user at all answers the same way — not an id oracle.
    expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, "no_such_user")))
      .toBeInstanceOf(ForbiddenError);
    expect(await rows(w.accA.id)).toHaveLength(0);
  });
});

describe("account assignments: the grant itself", () => {
  beforeEach(resetDb);
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("assigning a teammate widens their account scope, and several may share one building", async () => {
    const w = await world();
    // Before: m2 manages nothing and is assigned nothing, so accA is invisible to them.
    expect(await getAccount(testPrisma, w.S.m2, w.accA.id)).toBeNull();
    const row = await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    expect(row.companyId).toBe(w.companyId);
    expect(row.createdById).toBe(w.adminA.id);
    expect((await getAccount(testPrisma, w.S.m2, w.accA.id))?.id).toBe(w.accA.id);

    // "Several team members can be assigned to one building."
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);
    expect(await rows(w.accA.id)).toHaveLength(2);
    expect((await getAccount(testPrisma, w.S.onboarding, w.accA.id))?.id).toBe(w.accA.id);
  });

  it("an ONBOARDING user is assignable to an account in ANY team", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);
    // A different team's admin grants the SAME teamless user their own building.
    await assignUserToAccount(testPrisma, w.S.adminB, w.accB.id, w.onboarding.id);
    const mine = await testPrisma.accountAssignment.findMany({ where: { userId: w.onboarding.id } });
    expect(mine.map((r) => r.accountId).sort()).toEqual([w.accA.id, w.accB.id].sort());
  });

  it("a SUPER_ADMIN may grant in any team of the company it is scoped to", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.sa, w.accA.id, w.m2.id);
    await assignUserToAccount(testPrisma, w.S.sa, w.accB.id, w.adminB.id);
    expect(await rows(w.accA.id)).toHaveLength(1);
    expect(await rows(w.accB.id)).toHaveLength(1);
  });

  it("assign is idempotent: twice yields one row, and keeps the FIRST grantor", async () => {
    const w = await world();
    const first = await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    const second = await assignUserToAccount(testPrisma, w.S.sa, w.accA.id, w.m2.id);
    expect(second.id).toBe(first.id);
    expect(second.createdById).toBe(w.adminA.id);
    expect(await rows(w.accA.id)).toHaveLength(1);
  });

  it("unassign deletes the row, nulls the user's OPEN step/task assignees, and removes access", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);

    const openStep = await testPrisma.onboardingStep.create({ data: {
      companyId: w.companyId, accountId: w.accA.id, title: "SMS the residents", position: 1,
      assigneeId: w.onboarding.id,
    } });
    const doneStep = await testPrisma.onboardingStep.create({ data: {
      companyId: w.companyId, accountId: w.accA.id, title: "Train the manager", position: 2,
      assigneeId: w.onboarding.id, done: true,
    } });
    const openTask = await testPrisma.accountTask.create({ data: {
      companyId: w.companyId, accountId: w.accA.id, title: "Call back", assigneeId: w.onboarding.id,
    } });
    const doneTask = await testPrisma.accountTask.create({ data: {
      companyId: w.companyId, accountId: w.accA.id, title: "Signed", assigneeId: w.onboarding.id, done: true,
    } });
    // Somebody ELSE's open work on the same account, and the same user's work on ANOTHER account,
    // must both survive untouched.
    const otherStep = await testPrisma.onboardingStep.create({ data: {
      companyId: w.companyId, accountId: w.accA.id, title: "Collect docs", position: 3,
      assigneeId: w.m2.id,
    } });
    const elsewhere = await testPrisma.accountTask.create({ data: {
      companyId: w.companyId, accountId: w.accB.id, title: "Other building", assigneeId: w.onboarding.id,
    } });

    await unassignUserFromAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);

    expect(await testPrisma.accountAssignment.findMany({
      where: { accountId: w.accA.id, userId: w.onboarding.id },
    })).toHaveLength(0);
    // Access is gone.
    expect(await getAccount(testPrisma, w.S.onboarding, w.accA.id)).toBeNull();
    // Open work handed back; completed work keeps its author.
    const assignee = async (id: string, kind: "step" | "task") => kind === "step"
      ? (await testPrisma.onboardingStep.findUnique({ where: { id } }))?.assigneeId
      : (await testPrisma.accountTask.findUnique({ where: { id } }))?.assigneeId;
    expect(await assignee(openStep.id, "step")).toBeNull();
    expect(await assignee(openTask.id, "task")).toBeNull();
    expect(await assignee(doneStep.id, "step")).toBe(w.onboarding.id);
    expect(await assignee(doneTask.id, "task")).toBe(w.onboarding.id);
    expect(await assignee(otherStep.id, "step")).toBe(w.m2.id);
    expect(await assignee(elsewhere.id, "task")).toBe(w.onboarding.id);
    // The other assignee on this building is untouched.
    expect(await rows(w.accA.id)).toHaveLength(1);
  });

  it("unassign carries the same two gates as assign", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    // Role gate: a MEMBER cannot revoke, not even itself.
    expect(await caught(() => unassignUserFromAccount(testPrisma, w.S.m1, w.accA.id, w.m2.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await caught(() => unassignUserFromAccount(testPrisma, w.S.m2, w.accA.id, w.m2.id)))
      .toBeInstanceOf(ForbiddenError);
    // Scope gate: another team's admin gets NotFound, never a 403 confirming the id.
    expect(await caught(() => unassignUserFromAccount(testPrisma, w.S.adminB, w.accA.id, w.m2.id)))
      .toBeInstanceOf(NotFoundError);
    expect(await rows(w.accA.id)).toHaveLength(1);
  });

  it("unassigning someone who was never assigned is a no-op, not an error", async () => {
    const w = await world();
    await expect(unassignUserFromAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id)).resolves.toBeUndefined();
    expect(await rows(w.accA.id)).toHaveLength(0);
  });

  it("deleting a user revokes their grants (DB cascade)", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    await testPrisma.user.delete({ where: { id: w.m2.id } });
    expect(await rows(w.accA.id)).toHaveLength(0);
  });
});

describe("account assignments: reading the list", () => {
  beforeEach(resetDb);
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("internal staff who can see the account can see who else is on it", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);

    // The manager (m1) sees the building through accountManagerId, so they see the list.
    const asManager = await listAccountAssignees(testPrisma, w.S.m1, w.accA.id);
    expect(asManager.map((a) => a.userId).sort()).toEqual([w.m2.id, w.onboarding.id].sort());
    expect(asManager.find((a) => a.userId === w.onboarding.id)?.role).toBe("ONBOARDING");
    expect(asManager.find((a) => a.userId === w.m2.id)?.name).toBe(w.m2.name);

    // An assigned MEMBER and an assigned ONBOARDING user see the same list.
    for (const s of [w.S.m2, w.S.onboarding, w.S.adminA, w.S.sa]) {
      expect((await listAccountAssignees(testPrisma, s, w.accA.id))).toHaveLength(2);
    }
    // The manager is NOT in the list: their access is Account.accountManagerId, not an assignment.
    expect(asManager.map((a) => a.userId)).not.toContain(w.m1.id);
  });

  it("a caller who cannot see the account gets an empty list, never the names", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    expect(await listAccountAssignees(testPrisma, w.S.adminB, w.accA.id)).toEqual([]);
    expect(await listAccountAssignees(testPrisma, w.S.m3, w.accA.id)).toEqual([]);
    expect(await listAccountAssignees(testPrisma, w.S.adminA, "no_such_account")).toEqual([]);
  });

  // REGRESSION: the building's own representative CAN see the account (accountScopeWhere pins them
  // to it), so the account gate alone let them read the internal staff roster — every employee
  // assigned to them, by name and role. A Forbidden throw, not the empty list above: the empty list
  // means "no such visible building", which is the wrong answer here and would invite a retry.
  it("a PARTNER_VIEWER cannot read the staff roster, not even on its own account", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);

    // The partner really can see this building — so the refusal below is the role gate, not scope.
    expect(await getAccount(testPrisma, w.S.partner, w.accA.id)).not.toBeNull();
    await expect(listAccountAssignees(testPrisma, w.S.partner, w.accA.id))
      .rejects.toThrow(ForbiddenError);
  });

  it("listAssignmentCandidates returns EXACTLY the users assignUserToAccount would accept", async () => {
    const w = await world();
    const inactive = await makeUser("MEMBER", w.teamA);
    await testPrisma.user.update({ where: { id: inactive.id }, data: { status: "INACTIVE" } });
    const otherOnboarding = await makeUser("ONBOARDING", w.teamB);

    const candidates = await listAssignmentCandidates(testPrisma, w.S.adminA, w.accA.id);
    const ids = candidates.map((c) => c.id).sort();
    // adminA (own team), m2 (own team), both teamless ONBOARDING users. NOT m1 (the manager),
    // NOT team B's people, NOT the partner viewer, NOT the super admin, NOT the inactive member.
    expect(ids).toEqual([w.adminA.id, w.m2.id, w.onboarding.id, otherOnboarding.id].sort());

    // THE INVARIANT: every candidate is accepted...
    for (const c of candidates) {
      await expect(assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, c.id)).resolves.toBeTruthy();
    }
    // ...and every other user in the database is refused.
    const everyone = await testPrisma.user.findMany({ select: { id: true } });
    for (const u of everyone.filter((u) => !ids.includes(u.id))) {
      expect(await caught(() => assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, u.id)))
        .toBeInstanceOf(ForbiddenError);
    }
    expect(await rows(w.accA.id)).toHaveLength(candidates.length);
  });

  it("listAssignmentCandidates needs the capability and the account's scope", async () => {
    const w = await world();
    expect(await caught(() => listAssignmentCandidates(testPrisma, w.S.m1, w.accA.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await caught(() => listAssignmentCandidates(testPrisma, w.S.onboarding, w.accA.id)))
      .toBeInstanceOf(ForbiddenError);
    expect(await caught(() => listAssignmentCandidates(testPrisma, w.S.adminB, w.accA.id)))
      .toBeInstanceOf(NotFoundError);
  });
});

describe("account assignments: a team move revokes the old team's grants", () => {
  beforeEach(resetDb);
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("moving a MEMBER from team A to team B deletes their team-A grants only", async () => {
    const w = await world();
    const accA2 = await makeAccount(w.teamA, w.m1);
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    await assignUserToAccount(testPrisma, w.S.adminA, accA2.id, w.m2.id);
    // A legitimate grant in the DESTINATION team, written after m2 is moved there would be the
    // normal order; writing it via a raw row here keeps the test about the prune, not the order.
    await testPrisma.accountAssignment.create({
      data: { companyId: w.companyId, accountId: w.accB.id, userId: w.m2.id },
    });

    await setUserTeam(testPrisma, w.S.sa, w.m2.id, w.teamB.id);

    const left = await testPrisma.accountAssignment.findMany({ where: { userId: w.m2.id } });
    expect(left.map((r) => r.accountId)).toEqual([w.accB.id]);
    // The leak this prevents: team A's buildings are gone from their scope.
    const moved = su(await testPrisma.user.findUniqueOrThrow({ where: { id: w.m2.id } }));
    expect(await getAccount(testPrisma, moved, w.accA.id)).toBeNull();
    expect(await getAccount(testPrisma, moved, accA2.id)).toBeNull();
  });

  it("a teamless ONBOARDING user is never pruned", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.onboarding.id);
    await assignUserToAccount(testPrisma, w.S.adminB, w.accB.id, w.onboarding.id);
    // Putting activation staff on a team is refused outright (they are teamless by design), so
    // nothing can ever prune them through this path.
    const e = await caught(() => setUserTeam(testPrisma, w.S.sa, w.onboarding.id, w.teamB.id));
    expect(e).toBeInstanceOf(Error);
    expect(await testPrisma.accountAssignment.findMany({ where: { userId: w.onboarding.id } }))
      .toHaveLength(2);
  });

  it("a no-op move (same team) keeps every grant", async () => {
    const w = await world();
    await assignUserToAccount(testPrisma, w.S.adminA, w.accA.id, w.m2.id);
    await setUserTeam(testPrisma, w.S.sa, w.m2.id, w.teamA.id);
    expect(await testPrisma.accountAssignment.findMany({ where: { userId: w.m2.id } })).toHaveLength(1);
  });

  it("setUserTeam refuses self-moves, out-of-scope targets and other companies' teams", async () => {
    const w = await world();
    expect(await caught(() => setUserTeam(testPrisma, w.S.adminA, w.adminA.id, w.teamB.id)))
      .toBeInstanceOf(ForbiddenError);
    // A team admin cannot reach another team's member at all.
    expect(await caught(() => setUserTeam(testPrisma, w.S.adminA, w.m3.id, w.teamA.id)))
      .toBeInstanceOf(NotFoundError);
    const foreign = await makeTeam();
    expect(await caught(() => setUserTeam(testPrisma, w.S.sa, w.m2.id, foreign.id)))
      .toBeInstanceOf(NotFoundError);
    expect((await testPrisma.user.findUniqueOrThrow({ where: { id: w.m2.id } })).teamId).toBe(w.teamA.id);
  });
});
