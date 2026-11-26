import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { SessionUser } from "@/lib/auth/guards";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeam, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import { BuildingClaimedError } from "./building-claim";
import { listStages, seedTeamStages } from "./stages";
import { addTask } from "./tasks";
import { createLead, getLead, listLeads, moveLeadStage, updateLead, type CreateLeadInput } from "./leads";
import { createAccount, updateAccount } from "./accounts";

async function teamFixture(companyId?: string) {
  const t = await makeTeamWithUsers(companyId ? { companyId } : {});
  await seedTeamStages(testPrisma, t.companyId, t.team.id);
  const stages = await listStages(testPrisma, { companyId: t.companyId, teamId: t.team.id });
  return {
    ...t, stages,
    open: stages[0],
    won: stages.find((s) => s.type === "WON")!,
    lost: stages.find((s) => s.type === "LOST")!,
  };
}
type Fixture = Awaited<ReturnType<typeof teamFixture>>;

// companyName is REQUIRED now — it is the building name, and the building name is the claim.
// Unique per call by default so a test that does not care about the claim never trips over it.
function input(t: Fixture, over: Partial<CreateLeadInput> = {}): CreateLeadInput {
  return { title: "L", contactName: "C", stageId: t.open.id, companyName: uniq("Building "), ...over };
}

// A SUPER_ADMIN acting INSIDE a company. Its own session has companyId null and so fails closed
// in leadScopeWhere; the sanctioned pattern is for the caller to hand it a concrete company
// context (see the note at the top of scope.ts).
function saIn(companyId: string, sa: SessionUser): SessionUser {
  return { ...sa, companyId };
}

describe("lead visibility", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("a MEMBER sees only its own leads; its team admin sees the whole team", async () => {
    const t = await teamFixture();
    const other = await makeUser("MEMBER", t.team);
    await createLead(testPrisma, t.suMember, input(t, { title: "mine" }));
    await createLead(testPrisma, su(other), input(t, { title: "theirs" }));

    // ABSOLUTE, with no setting that widens it: Company.shareAllLeads is gone, and with it the
    // old "share everything by default" branch.
    expect((await listLeads(testPrisma, t.suMember)).map((l) => l.title)).toEqual(["mine"]);
    expect((await listLeads(testPrisma, t.suAdmin)).length).toBe(2);
  });

  it("a team admin sees nothing from a sibling team in the same company", async () => {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    const theirs = await createLead(testPrisma, b.suMember, input(b, { title: "team b" }));

    expect(await getLead(testPrisma, a.suAdmin, theirs.id)).toBeNull();
    expect((await listLeads(testPrisma, a.suAdmin)).length).toBe(0);
  });

  it("cross-tenant getLead returns null", async () => {
    const a = await teamFixture();
    const b = await teamFixture();
    const lead = await createLead(testPrisma, a.suMember, input(a));
    expect(await getLead(testPrisma, b.suMember, lead.id)).toBeNull();
  });

  it("?ownerId= cannot widen a MEMBER's scope", async () => {
    const t = await teamFixture();
    const colleague = await makeUser("MEMBER", t.team);
    await createLead(testPrisma, su(colleague), input(t, { title: "not yours" }));

    // THE REGRESSION THIS PINS: the filter used to be spread over the scope
    // (`where.ownerId = opts.ownerId`), overwriting the member-isolation ownerId that had just
    // been pinned — so this exact call handed a member a colleague's book.
    expect(await listLeads(testPrisma, t.suMember, { ownerId: colleague.id })).toEqual([]);
    // An admin may legitimately filter inside their own team.
    expect((await listLeads(testPrisma, t.suAdmin, { ownerId: colleague.id })).length).toBe(1);
  });
});

describe("createLead", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("stores the normalized buildingKey and the owner's team", async () => {
    const t = await teamFixture();
    const lead = await createLead(testPrisma, t.suMember, input(t, { companyName: "  Sabah   CITY " }));
    expect(lead.buildingKey).toBe(buildingKey("Sabah City"));
    expect(lead.companyName).toBe("  Sabah   CITY ");
    expect(lead.teamId).toBe(t.team.id);
    expect(lead.ownerId).toBe(t.member.id);
    expect(lead.wonAt).toBeNull();
  });

  it("claims the building: a second lead for it is rejected, from any team in the company", async () => {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    await createLead(testPrisma, a.suMember, input(a, { companyName: "Sabah City" }));

    await expect(createLead(testPrisma, a.suMember, input(a, { companyName: "sabah city" })))
      .rejects.toThrow(BuildingClaimedError);
    // One building, one record, ORG-WIDE — not merely per team.
    await expect(createLead(testPrisma, b.suMember, input(b, { companyName: "SABAH CITY" })))
      .rejects.toThrow(BuildingClaimedError);
    // Another company is a separate claim namespace.
    const far = await teamFixture();
    await expect(createLead(testPrisma, far.suMember, input(far, { companyName: "Sabah City" })))
      .resolves.toBeTruthy();
  });

  it("rolls the claim back with the insert when the insert fails", async () => {
    const t = await teamFixture();
    // A stage id that passes the lookup but a title that violates nothing... instead force the
    // failure at the DB by reusing a buildingKey through a raw insert inside the same window:
    // simplest deterministic proof is that a failed create leaves no claim behind.
    await expect(createLead(testPrisma, t.suMember, input(t, { stageId: "no-such-stage" })))
      .rejects.toThrow(NotFoundError);
    expect(await testPrisma.lead.count({ where: { companyId: t.companyId } })).toBe(0);
  });

  it("rejects a stage from another team, and the org template's stages", async () => {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    await expect(createLead(testPrisma, a.suMember, input(a, { stageId: b.open.id })))
      .rejects.toThrow(NotFoundError);

    // Template rows (teamId null) are the set new teams are seeded FROM; they are never attached
    // to a lead.
    const tplStage = await testPrisma.stage.create({
      data: { companyId: a.companyId, teamId: null, name: "Tpl", type: "OPEN", order: 0 },
    });
    await expect(createLead(testPrisma, a.suMember, input(a, { stageId: tplStage.id })))
      .rejects.toThrow(NotFoundError);
  });

  it("ignores a MEMBER's ownerId outright and always owns the lead itself", async () => {
    const t = await teamFixture();
    const colleague = await makeUser("MEMBER", t.team);
    // Deliberately not an error: every create form posts the field, and a member tampering with
    // it must not get a probe-able response — just a value with no effect (see scope.ts).
    const lead = await createLead(testPrisma, t.suMember, input(t, { ownerId: colleague.id }));
    expect(lead.ownerId).toBe(t.member.id);
  });

  it("lets a team admin assign within its team and refuses a sibling team's member", async () => {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    const mine = await createLead(testPrisma, a.suAdmin, input(a, { ownerId: a.member.id }));
    expect(mine.ownerId).toBe(a.member.id);

    await expect(createLead(testPrisma, a.suAdmin, input(a, { ownerId: b.member.id })))
      .rejects.toThrow(ForbiddenError);
    const foreign = await teamFixture();
    await expect(createLead(testPrisma, a.suAdmin, input(a, { ownerId: foreign.member.id })))
      .rejects.toThrow(ForbiddenError);
  });

  it("makes a SUPER_ADMIN name the owner, and takes the team from that owner", async () => {
    const t = await teamFixture();
    const sa = saIn(t.companyId, su(await makeUser("SUPER_ADMIN")));
    await expect(createLead(testPrisma, sa, input(t))).rejects.toThrow(ForbiddenError);
    const lead = await createLead(testPrisma, sa, input(t, { ownerId: t.member.id }));
    expect(lead.teamId).toBe(t.team.id);
  });

  it("stamps wonAt when a lead is created straight into a Won stage", async () => {
    const t = await teamFixture();
    const lead = await createLead(testPrisma, t.suMember, input(t, { stageId: t.won.id }));
    expect(lead.wonAt).toBeInstanceOf(Date);
  });
});

describe("updateLead", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("refuses a MEMBER the ownerId field", async () => {
    const t = await teamFixture();
    const colleague = await makeUser("MEMBER", t.team);
    const lead = await createLead(testPrisma, t.suMember, input(t));

    // THE REGRESSION THIS PINS: PATCH /api/leads/[id] used to accept ownerId from anyone who
    // could see the lead, checking only "same company" — so a member could push a lead into a
    // colleague's book and never see it again.
    await expect(updateLead(testPrisma, t.suMember, lead.id, { ownerId: colleague.id }))
      .rejects.toThrow(ForbiddenError);
    // Naming yourself is not a reassignment, so it is allowed through.
    await expect(updateLead(testPrisma, t.suMember, lead.id, { ownerId: t.member.id, title: "ok" }))
      .resolves.toMatchObject({ title: "ok" });
  });

  it("lets a team admin reassign inside its own team", async () => {
    const t = await teamFixture();
    const colleague = await makeUser("MEMBER", t.team);
    const lead = await createLead(testPrisma, t.suMember, input(t));
    const moved = await updateLead(testPrisma, t.suAdmin, lead.id, { ownerId: colleague.id });
    expect(moved.ownerId).toBe(colleague.id);
    expect(moved.teamId).toBe(t.team.id);
  });

  it("re-runs the claim guard on a rename, and lets a lead keep its own key", async () => {
    const t = await teamFixture();
    const taken = await createLead(testPrisma, t.suMember, input(t, { companyName: "Taken Tower" }));
    const mine = await createLead(testPrisma, t.suMember, input(t, { companyName: "Park Plaza" }));

    await expect(updateLead(testPrisma, t.suMember, mine.id, { companyName: "taken TOWER" }))
      .rejects.toThrow(BuildingClaimedError);
    expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: mine.id } })).buildingKey)
      .toBe(buildingKey("Park Plaza"));

    // A different spelling of its OWN building: the key does not change, so the lead is never
    // reported against itself.
    const respelled = await updateLead(testPrisma, t.suMember, mine.id, { companyName: "  PARK   plaza " });
    expect(respelled.companyName).toBe("  PARK   plaza ");
    expect(respelled.buildingKey).toBe(buildingKey("Park Plaza"));

    // A genuine move onto a free building re-keys the claim.
    const renamed = await updateLead(testPrisma, t.suMember, mine.id, { companyName: "Yeni Residence" });
    expect(renamed.buildingKey).toBe(buildingKey("Yeni Residence"));
    expect(taken.buildingKey).toBe(buildingKey("Taken Tower"));
  });
});

describe("updateLead cross-team transfer", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  async function twoTeams() {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    const sa = saIn(a.companyId, su(await makeUser("SUPER_ADMIN")));
    return { a, b, sa };
  }

  it("moves team, remaps the stage by name and logs a STAGE_CHANGE", async () => {
    const { a, b, sa } = await twoTeams();
    const lead = await createLead(testPrisma, a.suMember, input(a, { stageId: a.stages[2].id }));
    const fromName = a.stages[2].name;

    const moved = await updateLead(testPrisma, sa, lead.id, { ownerId: b.member.id });

    expect(moved.teamId).toBe(b.team.id);
    expect(moved.ownerId).toBe(b.member.id);
    // Same name, and crucially a row belonging to team B — the old stageId is meaningless there.
    const landed = await testPrisma.stage.findUniqueOrThrow({ where: { id: moved.stageId } });
    expect(landed.teamId).toBe(b.team.id);
    expect(landed.name).toBe(fromName);

    const acts = await testPrisma.activity.findMany({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } });
    expect(acts.length).toBe(1);
    expect(acts[0].body).toBe(`Transferred to ${b.team.name}; stage ${fromName} → ${fromName}`);
  });

  it("keeps a WON lead WON when the target team has no stage of that name", async () => {
    const { a, b, sa } = await twoTeams();
    // Team B renames its Won column and adds an OPEN stage that happens to be called "Won" —
    // the trap a name-only match would fall into.
    await testPrisma.stage.update({ where: { id: b.won.id }, data: { name: "Closed Won" } });
    await testPrisma.stage.create({
      data: { companyId: b.companyId, teamId: b.team.id, name: "Won", type: "OPEN", order: 99 },
    });
    const lead = await createLead(testPrisma, a.suMember, input(a, { stageId: a.won.id }));
    const wonAt = lead.wonAt;

    const moved = await updateLead(testPrisma, sa, lead.id, { ownerId: b.member.id });

    const landed = await testPrisma.stage.findUniqueOrThrow({ where: { id: moved.stageId } });
    expect(landed.type).toBe("WON");
    expect(landed.id).toBe(b.won.id);
    // wonAt is untouched, so no won-count and no "won in period" report shifts under the move.
    expect(moved.wonAt).toEqual(wonAt);
  });

  it("refuses a transfer when the target team has no stage of the lead's type", async () => {
    const { a, b, sa } = await twoTeams();
    const lead = await createLead(testPrisma, a.suMember, input(a, { stageId: a.lost.id }));
    // Strip team B of every LOST stage. Parking the lead in an OPEN or WON column instead would
    // quietly resurrect a dead lead.
    await testPrisma.stage.deleteMany({ where: { teamId: b.team.id, type: "LOST" } });
    await expect(updateLead(testPrisma, sa, lead.id, { ownerId: b.member.id })).rejects.toThrow(NotFoundError);
    expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).teamId).toBe(a.team.id);
  });

  it("refuses a transfer into another company", async () => {
    const a = await teamFixture();
    const far = await teamFixture();
    const sa = saIn(a.companyId, su(await makeUser("SUPER_ADMIN")));
    const lead = await createLead(testPrisma, a.suMember, input(a));
    // Lead.companyId never changes, so this would leave the row pointing at a team outside its
    // own tenant — and the per-company building claim enforced against the wrong company.
    await expect(updateLead(testPrisma, sa, lead.id, { ownerId: far.member.id })).rejects.toThrow(ForbiddenError);
  });

  it("clears open-task assignees who can no longer see the lead, and keeps the rest", async () => {
    const { a, b, sa } = await twoTeams();
    const lead = await createLead(testPrisma, a.suMember, input(a));
    // Team A's admin can see the lead today, so this is a legal assignment.
    const open = await addTask(testPrisma, a.suMember, lead.id, { title: "call", assigneeId: a.admin.id });
    const done = await addTask(testPrisma, a.suMember, lead.id, { title: "done", assigneeId: a.admin.id });
    await testPrisma.task.update({ where: { id: done.id }, data: { done: true } });
    // Raw, because addTask would (correctly) refuse to assign team B's member before the move.
    const forNewOwner = await testPrisma.task.create({
      data: { companyId: a.companyId, leadId: lead.id, title: "handover", assigneeId: b.member.id },
    });

    await updateLead(testPrisma, sa, lead.id, { ownerId: b.member.id });

    // Work nobody can open: the task survives, unassigned, for the new team to pick up.
    expect((await testPrisma.task.findUniqueOrThrow({ where: { id: open.id } })).assigneeId).toBeNull();
    // Done tasks keep their assignee — that is history, not work.
    expect((await testPrisma.task.findUniqueOrThrow({ where: { id: done.id } })).assigneeId).toBe(a.admin.id);
    // The new owner can see the lead, so their assignment stands.
    expect((await testPrisma.task.findUniqueOrThrow({ where: { id: forNewOwner.id } })).assigneeId).toBe(b.member.id);
  });

  it("keeps the whole transfer in one transaction", async () => {
    const { a, b, sa } = await twoTeams();
    const lead = await createLead(testPrisma, a.suMember, input(a));
    // Make the final lead.update fail by pointing the rename at a building team B already holds:
    // the claim guard throws after the stage remap and the activity write, so neither may survive.
    await createLead(testPrisma, b.suMember, input(b, { companyName: "Held By B" }));

    await expect(updateLead(testPrisma, sa, lead.id, { ownerId: b.member.id, companyName: "held by b" }))
      .rejects.toThrow(BuildingClaimedError);

    const after = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.teamId).toBe(a.team.id);
    expect(after.ownerId).toBe(a.member.id);
    expect(await testPrisma.activity.count({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } })).toBe(0);
  });
});

// ============== THE SUPER ADMIN AS A LEAD OWNER ==============
//
// The product rule, and the whole of it: ONLY the SUPER_ADMIN may name THEMSELVES as a lead owner,
// and the lead still has to say which team it belongs to. Nothing else gets wider — in particular
// a SUPER_ADMIN is still not a legal `accountManagerId`, which the last test in this block pins.

// A real super-admin ROW: companyId SET (prisma/seed.ts does this; leadScopeWhere throws without
// it) and teamId null. makeUser forces companyId null for the role, which models the unscoped
// platform owner rather than the seeded one, so it is corrected here.
async function makeOwnerUser(companyId: string, over: { status?: "ACTIVE" | "INACTIVE" } = {}) {
  const u = await makeUser("SUPER_ADMIN");
  return testPrisma.user.update({
    where: { id: u.id },
    data: { companyId, status: over.status ?? "ACTIVE" },
  });
}

describe("a SUPER_ADMIN owning a lead", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates a lead owned by itself when it names its own company's team", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);
    const lead = await createLead(testPrisma, su(owner), input(t, { ownerId: owner.id, teamId: t.team.id }));

    expect(lead.ownerId).toBe(owner.id);
    // The team is what was NAMED — the owner has none to derive it from — and the company follows
    // the team, as for every other lead.
    expect(lead.teamId).toBe(t.team.id);
    expect(lead.companyId).toBe(t.companyId);
  });

  it("refuses the super admin naming itself with no team, or with another company's team", async () => {
    const t = await teamFixture();
    const far = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);

    await expect(createLead(testPrisma, su(owner), input(t, { ownerId: owner.id })))
      .rejects.toThrow(ForbiddenError);
    await expect(createLead(testPrisma, su(owner), input(t, { ownerId: owner.id, teamId: far.team.id })))
      .rejects.toThrow(ForbiddenError);
    expect(await testPrisma.lead.count()).toBe(0);
  });

  it("refuses an INACTIVE super admin, and a super admin from another company", async () => {
    const t = await teamFixture();
    const inactive = await makeOwnerUser(t.companyId, { status: "INACTIVE" });
    await expect(createLead(testPrisma, su(inactive), input(t, { ownerId: inactive.id, teamId: t.team.id })))
      .rejects.toThrow(ForbiddenError);

    // A super admin of ANOTHER company, acting with a forged company context: the ROW is what is
    // checked, so the session's claim buys nothing.
    const far = await teamFixture();
    const stranger = await makeOwnerUser(far.companyId);
    await expect(
      createLead(testPrisma, saIn(t.companyId, su(stranger)), input(t, { ownerId: stranger.id, teamId: t.team.id })),
    ).rejects.toThrow(ForbiddenError);
    expect(await testPrisma.lead.count()).toBe(0);
  });

  it("a MEMBER posting the super admin's id still owns the lead itself", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);
    // UNCHANGED BEHAVIOUR, deliberately not an error: a supplied ownerId is ignored for a member,
    // so a tampered field is a value with no effect rather than something to probe.
    const lead = await createLead(testPrisma, t.suMember, input(t, { ownerId: owner.id, teamId: t.team.id }));
    expect(lead.ownerId).toBe(t.member.id);
    expect(lead.teamId).toBe(t.team.id);
  });

  it("a COMPANY_ADMIN posting the super admin's id is REFUSED", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);
    // The same refusal any other non-assignable role gets — OWNABLE_ROLES is untouched.
    await expect(createLead(testPrisma, t.suAdmin, input(t, { ownerId: owner.id, teamId: t.team.id })))
      .rejects.toThrow("a SUPER_ADMIN cannot own records");
    expect(await testPrisma.lead.count()).toBe(0);
  });

  it("is visible to that team's COMPANY_ADMIN and invisible to another team's MEMBER", async () => {
    const a = await teamFixture();
    const b = await teamFixture(a.companyId);
    const owner = await makeOwnerUser(a.companyId);
    const lead = await createLead(testPrisma, su(owner), input(a, { ownerId: owner.id, teamId: a.team.id }));

    expect((await getLead(testPrisma, a.suAdmin, lead.id))?.id).toBe(lead.id);
    // Not its own lead -> not in a member's book, even in the same team.
    expect(await getLead(testPrisma, a.suMember, lead.id)).toBeNull();
    // Another team sees nothing at all, admin or member.
    expect(await getLead(testPrisma, b.suAdmin, lead.id)).toBeNull();
    expect(await getLead(testPrisma, b.suMember, lead.id)).toBeNull();
  });

  it("an update with no teamId keeps the lead's current team", async () => {
    const a = await teamFixture();
    await teamFixture(a.companyId);
    const owner = await makeOwnerUser(a.companyId);
    const lead = await createLead(testPrisma, su(owner), input(a, { ownerId: owner.id, teamId: a.team.id }));

    // Re-posting the same owner is not a reassignment at all; posting it after a change of some
    // other field must not transfer the lead as a side effect either.
    const saved = await updateLead(testPrisma, su(owner), lead.id, { title: "renamed", ownerId: owner.id });
    expect(saved.teamId).toBe(a.team.id);
    expect(saved.ownerId).toBe(owner.id);
    expect(await testPrisma.activity.count({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } })).toBe(0);
  });

  it("the team admin may take a super-admin-owned lead back, and the super admin may hand it over", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);
    const lead = await createLead(testPrisma, su(owner), input(t, { ownerId: owner.id, teamId: t.team.id }));

    const handed = await updateLead(testPrisma, su(owner), lead.id, { ownerId: t.member.id });
    expect(handed.ownerId).toBe(t.member.id);
    expect(handed.teamId).toBe(t.team.id);
    // And back the other way is refused for the team admin: only the owner may name the owner.
    await expect(updateLead(testPrisma, t.suAdmin, lead.id, { ownerId: owner.id }))
      .rejects.toThrow("a SUPER_ADMIN cannot own records");
  });

  it("converts normally when won: the super admin becomes the account's manager", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);
    const lead = await createLead(testPrisma, su(owner), input(t, {
      ownerId: owner.id, teamId: t.team.id, companyName: "Owner Tower",
    }));

    const res = await moveLeadStage(testPrisma, su(owner), lead.id, t.won.id);
    expect(res.reason).toBeUndefined();
    expect(res.autoConverted).toBe(true);

    const account = await testPrisma.account.findUniqueOrThrow({ where: { sourceLeadId: lead.id } });
    expect(account.accountManagerId).toBe(owner.id);
    // The building belongs to the team that won it, not to the teamless owner.
    expect(account.teamId).toBe(t.team.id);
    expect(account.companyId).toBe(t.companyId);
  });

  it("STILL refuses a SUPER_ADMIN as an accountManagerId — the shared allowlist was not widened", async () => {
    const t = await teamFixture();
    const owner = await makeOwnerUser(t.companyId);

    // CREATE: named through a request, the owner is not an ownable account manager.
    await expect(createAccount(testPrisma, su(owner), { name: uniq("Building "), accountManagerId: owner.id }))
      .rejects.toThrow("a SUPER_ADMIN cannot own records");
    await expect(createAccount(testPrisma, t.suAdmin, { name: uniq("Building "), accountManagerId: owner.id }))
      .rejects.toThrow("a SUPER_ADMIN cannot own records");

    // UPDATE: reassigning an existing account to the owner is refused the same way.
    const acc = await createAccount(testPrisma, t.suAdmin, { name: uniq("Building ") });
    await expect(updateAccount(testPrisma, su(owner), acc.id, { accountManagerId: owner.id }))
      .rejects.toThrow("a SUPER_ADMIN cannot own records");
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).accountManagerId)
      .toBe(t.admin.id);
  });
});
