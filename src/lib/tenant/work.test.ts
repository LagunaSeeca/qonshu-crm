import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, uniq, buildingKey } from "@/test/fixtures";
import { getMyWork } from "./work";
import type { Team, User } from "@prisma/client";

async function lead(team: Team, owner: User, title: string) {
  const s = await testPrisma.stage.create({ data: { companyId: team.companyId, teamId: team.id, name: "New", order: 0, type: "OPEN" } });
  return testPrisma.lead.create({
    data: {
      companyId: team.companyId, teamId: team.id, buildingKey: buildingKey(`${title}-${uniq()}`),
      title, contactName: "C", stageId: s.id, ownerId: owner.id,
    },
  });
}
async function account(team: Team, manager: User, name: string) {
  return testPrisma.account.create({
    data: { companyId: team.companyId, teamId: team.id, buildingKey: buildingKey(`${name}-${uniq()}`), name, accountManagerId: manager.id },
  });
}

describe("getMyWork", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("only shows tasks and meetings on leads I own", async () => {
    const team = await makeTeam();
    const m1 = await makeUser("MEMBER", team);
    const m2 = await makeUser("MEMBER", team);
    const mine = await lead(team, m1, "Mine");
    const theirs = await lead(team, m2, "Theirs");
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: mine.id, title: "Follow up mine" } });
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: theirs.id, title: "Follow up theirs" } });
    await testPrisma.activity.create({ data: { companyId: team.companyId, leadId: mine.id, kind: "MEETING", body: "met mine" } });
    await testPrisma.activity.create({ data: { companyId: team.companyId, leadId: theirs.id, kind: "MEETING", body: "met theirs" } });

    const work = await getMyWork(testPrisma, su(m1));
    expect(work.tasks.map((t) => t.title)).toEqual(["Follow up mine"]);
    expect(work.meetings.map((m) => m.body)).toEqual(["met mine"]);
  });

  // CHANGED ON PURPOSE: this used to be "assigneeId wins" and asserted that a task assigned to me
  // on a TEAMMATE's lead showed up in my work. It cannot: My Work renders the parent's title, and
  // for a MEMBER a teammate's lead title is not visible — ownership is absolute (scope.ts), so a
  // row I cannot open cannot be listed by its name either. Nor is that state reachable any more:
  // assertAssignable (tasks.ts) only accepts the lead's owner or a COMPANY_ADMIN of its team as an
  // assignee, so a MEMBER can only hold an assignment on a lead they own; and reassigning the lead
  // drops the old owner's open assignments (leads.ts clearUnseeableAssignees). The rows below are
  // written straight to the DB precisely because the service layer refuses to create them.
  it("ownership wins: an assignment on a teammate's lead does not surface it; delegated away on my own lead does not either", async () => {
    const team = await makeTeam();
    const me = await makeUser("MEMBER", team);
    const mate = await makeUser("MEMBER", team);
    const myLead = await lead(team, me, "Mine");
    const mateLead = await lead(team, mate, "Mate");
    const c = team.companyId;
    await testPrisma.task.create({ data: { companyId: c, leadId: myLead.id, title: "unassigned on mine" } });
    await testPrisma.task.create({ data: { companyId: c, leadId: myLead.id, title: "delegated away", assigneeId: mate.id } });
    await testPrisma.task.create({ data: { companyId: c, leadId: mateLead.id, title: "assigned to me elsewhere", assigneeId: me.id } });
    await testPrisma.task.create({ data: { companyId: c, leadId: mateLead.id, title: "unassigned on theirs" } });

    const work = await getMyWork(testPrisma, su(me));
    expect(work.tasks.map((t) => t.title).sort()).toEqual(["unassigned on mine"]);
    // The teammate's lead title is what the leak was: assert the name itself never appears.
    expect(work.tasks.map((t) => t.parentTitle)).not.toContain(mateLead.title);
  });

  it("account tasks/meetings are mine only on an account I manage — an assignment or my own authorship is not enough", async () => {
    const team = await makeTeam();
    const me = await makeUser("MEMBER", team);
    const mate = await makeUser("MEMBER", team);
    const c = team.companyId;
    const mine = await account(team, me, "MineAcc");
    const theirs = await account(team, mate, "TheirAcc");
    await testPrisma.accountTask.create({ data: { companyId: c, accountId: mine.id, title: "QBR prep" } });
    await testPrisma.accountTask.create({ data: { companyId: c, accountId: theirs.id, title: "not mine" } });
    await testPrisma.accountTask.create({ data: { companyId: c, accountId: theirs.id, title: "assigned to me", assigneeId: me.id } });
    await testPrisma.accountActivity.create({ data: { companyId: c, accountId: mine.id, kind: "MEETING", body: "kickoff" } });
    await testPrisma.accountActivity.create({ data: { companyId: c, accountId: theirs.id, kind: "MEETING", body: "theirs" } });
    await testPrisma.accountActivity.create({ data: { companyId: c, accountId: theirs.id, kind: "MEETING", body: "I authored", authorId: me.id } });

    const work = await getMyWork(testPrisma, su(me));
    expect(work.tasks.map((t) => t.title).sort()).toEqual(["QBR prep"]);
    expect(work.tasks.every((t) => t.parentType === "ACCOUNT")).toBe(true);
    // "I authored" is the Activity half of the same leak: authorship is permanent and can never be
    // cleared the way a task assignment is, so matching on it would keep a teammate's BUILDING
    // NAME in my work forever. The account I manage is the only thing that qualifies.
    expect(work.meetings.map((m) => m.body).sort()).toEqual(["kickoff"]);
    expect(work.meetings.map((m) => m.parentTitle)).not.toContain(theirs.name);
  });

  it("a team admin's My Work is their own, not the whole team's", async () => {
    const team = await makeTeam();
    const admin = await makeUser("COMPANY_ADMIN", team);
    const member = await makeUser("MEMBER", team);
    const l = await lead(team, member, "Member lead");
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: l.id, title: "member task" } });
    expect((await getMyWork(testPrisma, su(admin))).tasks).toEqual([]);
  });

  it("cross-team isolation: a task assigned to me on another team's record is not shown", async () => {
    const A = await makeTeam();
    const B = await makeTeam({ companyId: A.companyId });
    const me = await makeUser("MEMBER", A);
    const other = await makeUser("MEMBER", B);
    const l = await lead(B, other, "B deal");
    await testPrisma.task.create({ data: { companyId: A.companyId, leadId: l.id, title: "stray", assigneeId: me.id } });
    expect((await getMyWork(testPrisma, su(me))).tasks).toEqual([]);
  });

  it("cross-company isolation: a user never sees another company's work", async () => {
    const A = await makeTeam();
    const B = await makeTeam();
    const a = await makeUser("MEMBER", A);
    const b = await makeUser("MEMBER", B);
    const l = await lead(A, a, "A deal");
    await testPrisma.task.create({ data: { companyId: A.companyId, leadId: l.id, title: "A task" } });
    const acc = await account(A, a, "AccA");
    await testPrisma.accountTask.create({ data: { companyId: A.companyId, accountId: acc.id, title: "A account task" } });
    const workB = await getMyWork(testPrisma, su(b));
    expect(workB.tasks).toEqual([]);
    expect(workB.meetings).toEqual([]);
  });

  it("excludes done tasks", async () => {
    const team = await makeTeam();
    const me = await makeUser("MEMBER", team);
    const l = await lead(team, me, "D");
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: l.id, title: "Done already", done: true } });
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: l.id, title: "Still open" } });
    expect((await getMyWork(testPrisma, su(me))).tasks.map((t) => t.title)).toEqual(["Still open"]);
  });

  it("partner logins are rejected", async () => {
    const team = await makeTeam();
    const p = await makeUser("PARTNER_VIEWER", team);
    await expect(getMyWork(testPrisma, su(p))).rejects.toThrow();
  });
});
