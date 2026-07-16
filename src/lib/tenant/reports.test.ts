import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getReport, toCsv } from "./reports";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner, Inc", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("reports", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("ALL scope lists partner rows; CSV escapes commas", async () => {
    const { user } = await setup("r1");
    const r = await getReport(testPrisma, user, { range, label: "July 2026" });
    expect(r.scope).toBe("ALL");
    expect(r.partnerRows.length).toBe(1);
    const csv = toCsv(r);
    expect(csv).toContain("Partner,Payments,Payments Amount,Collected,Transferred,Owed");
    expect(csv).toContain('"Partner, Inc"');
  });

  it("PARTNER scope rejects another tenant's account", async () => {
    const A = await setup("r2");
    const B = await setup("r3");
    await expect(getReport(testPrisma, B.user, { range, label: "x", accountId: A.acc.id })).rejects.toThrow();
  });
});
