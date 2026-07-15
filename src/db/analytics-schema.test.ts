import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("analytics schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("creates users + payments and cascades on account delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-an" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
    const au = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: acc.id, externalId: "e1", name: "AppUser", debt: "120", joinedAt: new Date() } });
    await testPrisma.partnerPayment.create({ data: { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: new Date(), amount: "50", method: "CARD", category: "UTILITY" } });
    expect(Number(au.debt)).toBe(120);
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.partnerPayment.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
