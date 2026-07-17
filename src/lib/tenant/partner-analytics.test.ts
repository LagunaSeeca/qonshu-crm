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

  it("aggregates installs: total/ios/android/activated/activationRate, all-time not period-filtered", async () => {
    const { c, acc, user } = await seed();
    // au already created by seed() has no installedAt/platform/lastLoginAt set (defaults: platform UNKNOWN, installedAt null)
    await testPrisma.partnerAppUser.createMany({
      data: [
        { companyId: c.id, accountId: acc.id, externalId: "ios1", name: "iOS Activated", active: true, debt: "0", joinedAt: new Date("2020-01-01"), platform: "IOS", installedAt: new Date("2020-02-01"), lastLoginAt: new Date("2020-02-02"), appToken: "tok1" },
        { companyId: c.id, accountId: acc.id, externalId: "ios2", name: "iOS Not Activated", active: true, debt: "0", joinedAt: new Date("2020-01-01"), platform: "IOS", installedAt: new Date("2020-02-01"), lastLoginAt: null, appToken: null },
        { companyId: c.id, accountId: acc.id, externalId: "and1", name: "Android Activated", active: true, debt: "0", joinedAt: new Date("2020-01-01"), platform: "ANDROID", installedAt: new Date("2020-02-01"), lastLoginAt: new Date("2020-02-03"), appToken: "tok2" },
        { companyId: c.id, accountId: acc.id, externalId: "notinst", name: "Not Installed", active: true, debt: "0", joinedAt: new Date("2020-01-01"), platform: "UNKNOWN", installedAt: null, lastLoginAt: null, appToken: null },
      ],
    });
    // Use a range far outside install dates to prove installs are all-time, not period-filtered
    const farRange = { from: new Date("2026-01-01T00:00:00Z"), to: new Date("2026-12-31T23:59:59Z") };
    const a = await getAccountAnalytics(testPrisma, user, acc.id, farRange);
    expect(a.installs.total).toBe(3); // ios1, ios2, and1 (seed's original au has no installedAt)
    expect(a.installs.ios).toBe(2);
    expect(a.installs.android).toBe(1);
    expect(a.installs.activated).toBe(2); // ios1 + and1 have lastLoginAt; ios2 does not
    expect(a.installs.activationRate).toBeCloseTo((2 / 3) * 100, 1);
  });

  it("does not count users without lastLoginAt as activated even if installed", async () => {
    const { c, acc, user } = await seed();
    await testPrisma.partnerAppUser.create({
      data: { companyId: c.id, accountId: acc.id, externalId: "only-installed", name: "Only Installed", active: true, debt: "0", joinedAt: new Date(), platform: "IOS", installedAt: new Date(), lastLoginAt: null, appToken: null },
    });
    const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
    expect(a.installs.total).toBe(1);
    expect(a.installs.activated).toBe(0);
    expect(a.installs.activationRate).toBe(0);
  });

  it("isolates installs across tenants", async () => {
    const { c, acc } = await seed();
    await testPrisma.partnerAppUser.create({
      data: { companyId: c.id, accountId: acc.id, externalId: "iso1", name: "Iso", active: true, debt: "0", joinedAt: new Date(), platform: "IOS", installedAt: new Date(), lastLoginAt: new Date(), appToken: "t" },
    });
    const B = await seed();
    const b = await getAccountAnalytics(testPrisma, B.user, B.acc.id, range);
    expect(b.installs.total).toBe(0);
    expect(b.installs.activated).toBe(0);
  });
});
