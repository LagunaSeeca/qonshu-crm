import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("crm schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates a lead in a stage and cascades on delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-crm" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const s = await testPrisma.stage.create({ data: { companyId: c.id, name: "New", order: 0, type: "OPEN", probability: 10 } });
    const lead = await testPrisma.lead.create({ data: { companyId: c.id, title: "Deal", contactName: "Jane", stageId: s.id, ownerId: u.id, value: "1000" } });
    await testPrisma.activity.create({ data: { companyId: c.id, leadId: lead.id, authorId: u.id, kind: "NOTE", body: "hi" } });
    await testPrisma.task.create({ data: { companyId: c.id, leadId: lead.id, title: "call" } });
    await testPrisma.attachment.create({ data: { companyId: c.id, leadId: lead.id, filename: "f.txt", diskPath: "/tmp/f.txt", size: 4, mime: "text/plain", uploadedById: u.id } });
    expect(Number(lead.value)).toBe(1000);
    await testPrisma.lead.delete({ where: { id: lead.id } });
    expect(await testPrisma.activity.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await testPrisma.task.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await testPrisma.attachment.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("defaults shareAllLeads to true", async () => {
    const c = await testPrisma.company.create({ data: { name: "B", slug: "b-crm" } });
    expect(c.shareAllLeads).toBe(true);
  });
});
