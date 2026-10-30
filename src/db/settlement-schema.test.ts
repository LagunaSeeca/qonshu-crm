import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, buildingKey } from "@/test/fixtures";

describe("settlement schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("creates entries and cascades on account delete", async () => {
    const team = await makeTeam();
    const c = { id: team.companyId };
    const u = await makeUser("COMPANY_ADMIN", team);
    const acc = await testPrisma.account.create({ data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("P"), name: "P", accountManagerId: u.id } });
    const e = await testPrisma.settlementEntry.create({ data: { companyId: c.id, accountId: acc.id, type: "COLLECTED", amount: "500", method: "CASH", occurredAt: new Date(), createdById: u.id } });
    expect(Number(e.amount)).toBe(500);
    expect(e.type).toBe("COLLECTED");
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
