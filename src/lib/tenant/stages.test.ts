import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages, createStage, deleteStage, reorderStages, StageHasLeadsError } from "./stages";

async function company() { return testPrisma.company.create({ data: { name: "A", slug: "a-st" } }); }

describe("stages", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("seeds 7 default stages idempotently", async () => {
    const c = await company();
    await seedDefaultStages(testPrisma, c.id);
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    expect(stages.map((s) => s.name)).toEqual(["New","Contacted","Qualified","Proposal","Negotiation","Won","Lost"]);
    expect(stages[0].order).toBe(0);
    expect(stages.find((s)=>s.name==="Won")!.type).toBe("WON");
  });

  it("reorders and blocks deleting a stage with leads", async () => {
    const c = await company();
    await seedDefaultStages(testPrisma, c.id);
    const ctx = { companyId: c.id };
    const [s0, s1] = await listStages(testPrisma, ctx);
    await reorderStages(testPrisma, ctx, [s1.id, s0.id]);
    expect((await listStages(testPrisma, ctx))[0].id).toBe(s1.id);
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "o@a.com", passwordHash: "x", name: "O", role: "MEMBER" } });
    await testPrisma.lead.create({ data: { companyId: c.id, title: "D", contactName: "C", stageId: s1.id, ownerId: u.id } });
    await expect(deleteStage(testPrisma, ctx, s1.id)).rejects.toThrow(StageHasLeadsError);
  });
});
