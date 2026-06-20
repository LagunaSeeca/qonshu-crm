import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import type { SessionUser } from "@/lib/auth/guards";

describe("moveLeadStage", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("writes a STAGE_CHANGE activity and sets lostReason on LOST", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-mv" } });
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
    const lead = await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stages[0].id });
    const lost = stages.find((s) => s.type === "LOST")!;
    const moved = await moveLeadStage(testPrisma, user, lead.id, lost.id, "budget");
    expect(moved.stageId).toBe(lost.id);
    expect(moved.lostReason).toBe("budget");
    const acts = await testPrisma.activity.findMany({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } });
    expect(acts.length).toBe(1);
    expect(acts[0].body).toContain("New");
    expect(acts[0].body).toContain("Lost");
  });
});
