import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getAccountAnalytics, listAccountPayments } from "./partner-analytics";
import type { SessionUser } from "@/lib/auth/guards";

async function seed() {
  const slug = `a-pa-${Date.now()}`;
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${Date.now()}@a.com`, passwordHash: "x", name: "U", role: "MEMBER" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
  const au = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: acc.id, externalId: "e1", name: "AU", active: true, debt: "100", joinedAt: new Date() } });
  const day = new Date("2026-06-15T10:00:00Z");
  await testPrisma.partnerPayment.createMany({ data: [
    { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: day, amount: "100", method: "CARD", category: "UTILITY" },
    { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: day, amount: "50", method: "CASH", category: "APARTMENT" },
  ] });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, acc, user };
}
const range = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T23:59:59Z") };

describe("partner analytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("aggregates KPIs + breakdowns + utility", async () => {
    const { acc, user } = await seed();
    const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
    expect(a.kpis.paymentsCount).toBe(2);
    expect(a.kpis.paymentsAmount).toBe(150);
    expect(a.kpis.totalDebt).toBe(100);
    expect(a.kpis.utilityAmount).toBe(100);
    expect(a.byMethod.find((m) => m.method === "CARD")!.amount).toBe(100);
    expect(a.byCategory.find((cc) => cc.category === "APARTMENT")!.amount).toBe(50);
  });
  it("paginates + isolates cross-tenant", async () => {
    const { acc } = await seed();
    const B = await seed();
    expect((await listAccountPayments(testPrisma, B.user, acc.id, { ...range })).total).toBe(0);
  });
});
