import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { getDashboardStats } from "./dashboard";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

describe("dashboard stats", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("counts open leads, pipeline value and meetings; isolates tenants", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-dash" } });
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    const openStage = stages.find((s) => s.type === "OPEN")!;
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    const lead = await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: openStage.id, value: 1000 });
    await testPrisma.activity.create({ data: { companyId: c.id, leadId: lead.id, kind: "MEETING", body: "met", occurredAt: new Date("2026-07-10T10:00:00Z") } });
    await testPrisma.task.create({ data: { companyId: c.id, leadId: lead.id, title: "t", done: false, dueDate: new Date("2026-07-02T00:00:00Z") } });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.openLeads).toBe(1);
    expect(s.sales.pipelineValue).toBe(1000);
    expect(s.activity.meetingsDone).toBe(1);
    expect(s.activity.openTasks).toBe(1);
    expect(s.activity.overdueTasks).toBe(1);

    // other tenant sees nothing
    const c2 = await testPrisma.company.create({ data: { name: "B", slug: "b-dash" } });
    const u2 = await testPrisma.user.create({ data: { companyId: c2.id, email: "u@b.com", passwordHash: "x", name: "U2", role: "COMPANY_ADMIN" } });
    const s2 = await getDashboardStats(testPrisma, { id: u2.id, companyId: c2.id, role: "COMPANY_ADMIN" }, range);
    expect(s2.sales.openLeads).toBe(0);
    expect(s2.activity.meetingsDone).toBe(0);
  });
});
