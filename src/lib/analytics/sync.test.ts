import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { MockPartnerAnalyticsSource } from "./source";
import { syncAccountAnalytics } from "./sync";

async function acct() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-sy" } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
  return { c, acc };
}
describe("syncAccountAnalytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("populates users + payments idempotently", async () => {
    const { c, acc } = await acct();
    const src = new MockPartnerAnalyticsSource();
    const r1 = await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    expect(r1.users).toBeGreaterThan(0);
    expect(r1.payments).toBeGreaterThan(0);
    const usersAfter1 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    const usersAfter2 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    expect(usersAfter2).toBe(usersAfter1); // no duplicate externalIds
  });
});
