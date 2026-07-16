import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { addSettlementEntry, getAccountSettlement, listCompanySettlements, deleteSettlementEntry } from "./settlements";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("settlements", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("computes owed = collected - transferred", async () => {
    const { acc, user } = await setup("s1");
    await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 500, occurredAt: new Date() });
    await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 300, occurredAt: new Date() });
    await addSettlementEntry(testPrisma, user, acc.id, { type: "TRANSFER", amount: 200, method: "CASH", occurredAt: new Date() });
    const s = await getAccountSettlement(testPrisma, user, acc.id);
    expect(s.collected).toBe(800);
    expect(s.transferred).toBe(200);
    expect(s.owed).toBe(600);
    expect(s.entries.length).toBe(3);
  });

  it("company summary totals match rows; cross-tenant isolated", async () => {
    const A = await setup("s2");
    await addSettlementEntry(testPrisma, A.user, A.acc.id, { type: "COLLECTED", amount: 100, occurredAt: new Date() });
    const B = await setup("s3");
    const sumA = await listCompanySettlements(testPrisma, A.user);
    expect(sumA.totals.collected).toBe(100);
    expect(sumA.rows.length).toBe(1);
    const sumB = await listCompanySettlements(testPrisma, B.user);
    expect(sumB.totals.collected).toBe(0);
    await expect(getAccountSettlement(testPrisma, B.user, A.acc.id)).rejects.toThrow();
  });

  it("delete updates totals", async () => {
    const { acc, user } = await setup("s4");
    const e = await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 50, occurredAt: new Date() });
    await deleteSettlementEntry(testPrisma, user, e.id);
    expect((await getAccountSettlement(testPrisma, user, acc.id)).collected).toBe(0);
  });
});
