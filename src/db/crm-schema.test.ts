import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, buildingKey } from "@/test/fixtures";

describe("crm schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates a lead in a stage and cascades on delete", async () => {
    const team = await makeTeam();
    const c = { id: team.companyId };
    const u = await makeUser("MEMBER", team);
    const s = await testPrisma.stage.create({ data: { companyId: c.id, teamId: team.id, name: "New", order: 0, type: "OPEN", probability: 10 } });
    const lead = await testPrisma.lead.create({ data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Deal"), title: "Deal", contactName: "Jane", stageId: s.id, ownerId: u.id } });
    await testPrisma.activity.create({ data: { companyId: c.id, leadId: lead.id, authorId: u.id, kind: "NOTE", body: "hi" } });
    await testPrisma.task.create({ data: { companyId: c.id, leadId: lead.id, title: "call" } });
    await testPrisma.attachment.create({ data: { companyId: c.id, leadId: lead.id, filename: "f.txt", diskPath: "/tmp/f.txt", size: 4, mime: "text/plain", uploadedById: u.id } });
    await testPrisma.lead.delete({ where: { id: lead.id } });
    expect(await testPrisma.activity.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await testPrisma.task.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await testPrisma.attachment.count({ where: { leadId: lead.id } })).toBe(0);
  });

  // Company.shareAllLeads was DROPPED by the teams refactor (members are always isolated), so the
  // old "defaults shareAllLeads to true" test is replaced by one for the constraint that took over
  // the isolation job at the schema level: a building is claimed once per company.
  it("enforces one lead per (companyId, buildingKey), but not across companies", async () => {
    const team = await makeTeam();
    const u = await makeUser("MEMBER", team);
    const s = await testPrisma.stage.create({ data: { companyId: team.companyId, teamId: team.id, name: "New", order: 0, type: "OPEN", probability: 10 } });
    const base = { companyId: team.companyId, teamId: team.id, buildingKey: buildingKey("Tower"), title: "Tower", contactName: "J", stageId: s.id, ownerId: u.id };
    await testPrisma.lead.create({ data: base });
    await expect(testPrisma.lead.create({ data: base })).rejects.toThrow();

    const team2 = await makeTeam();
    const u2 = await makeUser("MEMBER", team2);
    const s2 = await testPrisma.stage.create({ data: { companyId: team2.companyId, teamId: team2.id, name: "New", order: 0, type: "OPEN", probability: 10 } });
    await expect(
      testPrisma.lead.create({ data: { ...base, companyId: team2.companyId, teamId: team2.id, stageId: s2.id, ownerId: u2.id } }),
    ).resolves.toBeTruthy();
  });
});
