import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { getMyWork } from "./work";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(shareAllLeads: boolean, slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug, shareAllLeads } });
  await seedDefaultStages(testPrisma, c.id);
  const stage = (await listStages(testPrisma, { companyId: c.id }))[0];
  const m1 = await testPrisma.user.create({ data: { companyId: c.id, email: `m1-${slug}@a.com`, passwordHash: "x", name: "M1", role: "MEMBER" } });
  const m2 = await testPrisma.user.create({ data: { companyId: c.id, email: `m2-${slug}@a.com`, passwordHash: "x", name: "M2", role: "MEMBER" } });
  const su = (u: typeof m1): SessionUser => ({ id: u.id, companyId: c.id, role: u.role });
  return { c, stage, m1, m2, su };
}

describe("getMyWork", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("restricted member only sees open tasks and meetings from their own leads", async () => {
    const { stage, m1, m2, su } = await setup(false, "a-work");
    const myLead = await createLead(testPrisma, su(m1), { title: "Mine", contactName: "C1", stageId: stage.id });
    const otherLead = await createLead(testPrisma, su(m2), { title: "Theirs", contactName: "C2", stageId: stage.id });

    await testPrisma.task.create({ data: { companyId: myLead.companyId, leadId: myLead.id, title: "Follow up mine" } });
    await testPrisma.task.create({ data: { companyId: otherLead.companyId, leadId: otherLead.id, title: "Follow up theirs" } });
    await testPrisma.activity.create({ data: { companyId: myLead.companyId, leadId: myLead.id, kind: "MEETING", body: "met mine" } });
    await testPrisma.activity.create({ data: { companyId: otherLead.companyId, leadId: otherLead.id, kind: "MEETING", body: "met theirs" } });

    const work = await getMyWork(testPrisma, su(m1));
    expect(work.tasks.map((t) => t.title)).toEqual(["Follow up mine"]);
    expect(work.meetings.map((m) => m.body)).toEqual(["met mine"]);
  });

  it("account tasks and meetings are company-wide (visible regardless of lead ownership)", async () => {
    const { c, m1, m2 } = await setup(false, "b-work");
    const account = await testPrisma.account.create({ data: { companyId: c.id, name: "Acc", accountManagerId: m2.id } });
    await testPrisma.accountTask.create({ data: { companyId: c.id, accountId: account.id, title: "QBR prep" } });
    await testPrisma.accountActivity.create({ data: { companyId: c.id, accountId: account.id, kind: "MEETING", body: "kickoff" } });

    const user1: SessionUser = { id: m1.id, companyId: c.id, role: "MEMBER" };
    const work = await getMyWork(testPrisma, user1);
    expect(work.tasks.map((t) => t.title)).toContain("QBR prep");
    expect(work.tasks.find((t) => t.title === "QBR prep")?.parentType).toBe("ACCOUNT");
    expect(work.meetings.map((m) => m.body)).toContain("kickoff");
  });

  it("cross-tenant isolation: a user never sees another company's tasks or meetings", async () => {
    const A = await setup(true, "c-work");
    const B = await setup(true, "d-work");
    const leadA = await createLead(testPrisma, A.su(A.m1), { title: "A deal", contactName: "CA", stageId: A.stage.id });
    await testPrisma.task.create({ data: { companyId: leadA.companyId, leadId: leadA.id, title: "A task" } });
    const accountA = await testPrisma.account.create({ data: { companyId: A.c.id, name: "AccA", accountManagerId: A.m1.id } });
    await testPrisma.accountTask.create({
      data: { companyId: A.c.id, accountId: accountA.id, title: "A account task" },
    });

    const workB = await getMyWork(testPrisma, B.su(B.m1));
    expect(workB.tasks).toEqual([]);
    expect(workB.meetings).toEqual([]);
  });

  it("marks done tasks as excluded from the open-tasks list", async () => {
    const { stage, m1, su } = await setup(true, "e-work");
    const lead = await createLead(testPrisma, su(m1), { title: "D", contactName: "C", stageId: stage.id });
    await testPrisma.task.create({ data: { companyId: lead.companyId, leadId: lead.id, title: "Done already", done: true } });
    await testPrisma.task.create({ data: { companyId: lead.companyId, leadId: lead.id, title: "Still open", done: false } });

    const work = await getMyWork(testPrisma, su(m1));
    expect(work.tasks.map((t) => t.title)).toEqual(["Still open"]);
  });
});
