import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("settlement schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("creates entries and cascades on account delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-se" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
    const e = await testPrisma.settlementEntry.create({ data: { companyId: c.id, accountId: acc.id, type: "COLLECTED", amount: "500", occurredAt: new Date(), createdById: u.id } });
    expect(Number(e.amount)).toBe(500);
    expect(e.type).toBe("COLLECTED");
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
