import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { addActivity, listActivities } from "./activities";
import type { SessionUser } from "@/lib/auth/guards";

async function lead() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-ac" } });
  await seedDefaultStages(testPrisma, c.id);
  const stage = (await listStages(testPrisma, { companyId: c.id }))[0];
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  const l = await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stage.id });
  return { user, l };
}

describe("activities", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("adds and lists a note; rejects STAGE_CHANGE", async () => {
    const { user, l } = await lead();
    await addActivity(testPrisma, user, l.id, { kind: "CALL", body: "called", outcome: "interested" });
    const acts = await listActivities(testPrisma, user, l.id);
    expect(acts[0].outcome).toBe("interested");
    await expect(addActivity(testPrisma, user, l.id, { kind: "STAGE_CHANGE" as never, body: "x" })).rejects.toThrow();
  });
});
