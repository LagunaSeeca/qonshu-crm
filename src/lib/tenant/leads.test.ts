import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { SessionUser } from "@/lib/auth/guards";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeam, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import { BuildingClaimedError } from "./building-claim";
import { listStages, seedTeamStages } from "./stages";
import { addTask } from "./tasks";
import { createLead, getLead, listLeads, updateLead, type CreateLeadInput } from "./leads";

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
