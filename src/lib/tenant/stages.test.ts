import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages, createStage, deleteStage, reorderStages, StageHasLeadsError, LastStageError } from "./stages";

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

  it("deleteStage blocks removing the only WON stage (no leads)", async () => {
    const c = await company();
    await seedDefaultStages(testPrisma, c.id);
    const ctx = { companyId: c.id };
    const stages = await listStages(testPrisma, ctx);
    const wonStage = stages.find((s) => s.type === "WON")!;
    await expect(deleteStage(testPrisma, ctx, wonStage.id)).rejects.toThrow(LastStageError);
  });

  it("deleteStage succeeds when deleting a non-last OPEN stage (≥2 OPEN exist, no leads)", async () => {
    const c = await company();
    await seedDefaultStages(testPrisma, c.id);
    const ctx = { companyId: c.id };
    const stages = await listStages(testPrisma, ctx);
    // Default seeds have 5 OPEN stages — delete the first one
    const openStages = stages.filter((s) => s.type === "OPEN");
    expect(openStages.length).toBeGreaterThanOrEqual(2);
    await expect(deleteStage(testPrisma, ctx, openStages[0].id)).resolves.toBeUndefined();
  });
});
