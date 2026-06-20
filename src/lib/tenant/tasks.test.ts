import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { addTask, toggleTask, listTasks, isOverdue } from "./tasks";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";

async function lead() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-tk" } });
  await seedDefaultStages(testPrisma, c.id);
  const stage = (await listStages(testPrisma, { companyId: c.id }))[0];
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, user, l: await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: stage.id }) };
}

describe("tasks", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("adds, toggles, detects overdue", async () => {
    const { user, l } = await lead();
    const t = await addTask(testPrisma, user, l.id, { title: "call", dueDate: new Date(Date.now() - 1000) });
    expect(isOverdue(t)).toBe(true);
    const done = await toggleTask(testPrisma, user, t.id, true);
    expect(done.done).toBe(true);
    expect(isOverdue(done)).toBe(false);
    expect((await listTasks(testPrisma, user, l.id)).length).toBe(1);
  });

  it("addTask rejects an assigneeId from another company", async () => {
    const { user, l } = await lead();
    // Create a foreign company user
    const foreignCompany = await testPrisma.company.create({ data: { name: "B", slug: "b-tk-foreign" } });
    const foreignUser = await testPrisma.user.create({ data: { companyId: foreignCompany.id, email: "foreign@b.com", passwordHash: "x", name: "F", role: "MEMBER" } });
    await expect(
      addTask(testPrisma, user, l.id, { title: "call", assigneeId: foreignUser.id }),
    ).rejects.toThrow(NotFoundError);
  });
});
