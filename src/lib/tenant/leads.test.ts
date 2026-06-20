import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, listLeads, getLead, updateLead } from "./leads";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";

async function setup(shareAllLeads: boolean) {
  const id = Math.random().toString(36).slice(7);
  const slug = "a-ld-" + id;
  const c = await testPrisma.company.create({ data: { name: "A", slug, shareAllLeads } });
  await seedDefaultStages(testPrisma, c.id);
  const stage = (await listStages(testPrisma, { companyId: c.id }))[0];
  const admin = await testPrisma.user.create({ data: { companyId: c.id, email: `ad-${id}@a.com`, passwordHash: "x", name: "Ad", role: "COMPANY_ADMIN" } });
  const m1 = await testPrisma.user.create({ data: { companyId: c.id, email: `m1-${id}@a.com`, passwordHash: "x", name: "M1", role: "MEMBER" } });
  const m2 = await testPrisma.user.create({ data: { companyId: c.id, email: `m2-${id}@a.com`, passwordHash: "x", name: "M2", role: "MEMBER" } });
  const su = (u: typeof admin): SessionUser => ({ id: u.id, companyId: c.id, role: u.role });
  return { c, stage, admin, m1, m2, su };
}

describe("leads visibility + isolation", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("restricted member sees only own; admin sees all", async () => {
    const { stage, admin, m1, m2, su } = await setup(false);
    await createLead(testPrisma, su(m1), { title: "L1", contactName: "C1", stageId: stage.id });
    await createLead(testPrisma, su(m2), { title: "L2", contactName: "C2", stageId: stage.id });
    expect((await listLeads(testPrisma, su(m1))).map((l)=>l.title)).toEqual(["L1"]);
    expect((await listLeads(testPrisma, su(admin))).length).toBe(2);
  });

  it("shared mode: member sees all", async () => {
    const { stage, m1, m2, su } = await setup(true);
    await createLead(testPrisma, su(m2), { title: "L2", contactName: "C2", stageId: stage.id });
    expect((await listLeads(testPrisma, su(m1))).length).toBe(1);
  });

  it("cross-tenant getLead returns null", async () => {
    const A = await setup(true);
    const B = await setup(true);
    const lead = await createLead(testPrisma, A.su(A.m1), { title: "LA", contactName: "C", stageId: A.stage.id });
    expect(await getLead(testPrisma, B.su(B.m1), lead.id)).toBeNull();
  });
});

describe("leads tenancy validation", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("createLead rejects a stageId from another company", async () => {
    const A = await setup(true);
    const B = await setup(true);
    // B.stage belongs to B's tenant; A's user should not be able to use it
    await expect(
      createLead(testPrisma, A.su(A.m1), { title: "T", contactName: "C", stageId: B.stage.id }),
    ).rejects.toThrow(NotFoundError);
  });

  it("createLead rejects an ownerId from another company", async () => {
    const A = await setup(true);
    const B = await setup(true);
    await expect(
      createLead(testPrisma, A.su(A.m1), { title: "T", contactName: "C", stageId: A.stage.id, ownerId: B.m1.id }),
    ).rejects.toThrow(NotFoundError);
  });

  it("updateLead rejects an ownerId from another company", async () => {
    const A = await setup(true);
    const B = await setup(true);
    const lead = await createLead(testPrisma, A.su(A.m1), { title: "T", contactName: "C", stageId: A.stage.id });
    await expect(
      updateLead(testPrisma, A.su(A.m1), lead.id, { ownerId: B.m1.id }),
    ).rejects.toThrow(NotFoundError);
  });
});
