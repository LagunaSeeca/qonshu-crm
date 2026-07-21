import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getCompanyAnalytics } from "./company-analytics";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

async function seedCompanyA() {
  const slug = `a-ca-${Date.now()}-${Math.random()}`;
  const c = await testPrisma.company.create({ data: { name: "Company A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${Date.now()}-${Math.random()}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };

  const acc1 = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner One", accountManagerId: u.id } });
  const acc2 = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner Two", accountManagerId: u.id } });

  // Partner One: 2 app users, one installed+activated (iOS), one android installed not activated
  const au1 = await testPrisma.partnerAppUser.create({
    data: { companyId: c.id, accountId: acc1.id, externalId: "e1", name: "AU1", active: true, debt: "40", joinedAt: new Date("2026-01-01"), platform: "IOS", installedAt: new Date("2026-01-05"), lastLoginAt: new Date("2026-01-06") },
  });
  const au2 = await testPrisma.partnerAppUser.create({
    data: { companyId: c.id, accountId: acc1.id, externalId: "e2", name: "AU2", active: true, debt: "10", joinedAt: new Date("2026-01-01"), platform: "ANDROID", installedAt: new Date("2026-01-05"), lastLoginAt: null },
  });
  // Partner Two: 1 app user, not installed
  const au3 = await testPrisma.partnerAppUser.create({
    data: { companyId: c.id, accountId: acc2.id, externalId: "e3", name: "AU3", active: false, debt: "5", joinedAt: new Date("2026-01-01") },
  });

  // In-range payments
  await testPrisma.partnerPayment.createMany({
    data: [
      { companyId: c.id, accountId: acc1.id, appUserId: au1.id, occurredAt: new Date("2026-07-05T10:00:00Z"), amount: "100", method: "CARD", category: "UTILITY" },
      { companyId: c.id, accountId: acc1.id, appUserId: au2.id, occurredAt: new Date("2026-07-06T10:00:00Z"), amount: "50", method: "CASH", category: "APARTMENT" },
      { companyId: c.id, accountId: acc2.id, appUserId: au3.id, occurredAt: new Date("2026-07-10T10:00:00Z"), amount: "20", method: "MANUAL", category: "PARKING" },
      // second payment by au1, same day, to prove engagedUsers counts distinct users not payment rows
      { companyId: c.id, accountId: acc1.id, appUserId: au1.id, occurredAt: new Date("2026-07-05T14:00:00Z"), amount: "30", method: "CARD", category: "UTILITY" },
    ],
  });

  // Out-of-range payment (June) — must be excluded from totals/trend/partners
  await testPrisma.partnerPayment.create({
    data: { companyId: c.id, accountId: acc1.id, appUserId: au1.id, occurredAt: new Date("2026-06-15T10:00:00Z"), amount: "999", method: "CARD", category: "UTILITY" },
  });

  // Settlement entries for the money-flow chart: collected (bank) + transferred (cash),
  // spread across both accounts, plus an out-of-range (June) entry that must be excluded.
  await testPrisma.settlementEntry.createMany({
    data: [
      { companyId: c.id, accountId: acc1.id, type: "COLLECTED", amount: "60", method: "BANK_TRANSFER", occurredAt: new Date("2026-07-05T09:00:00Z"), createdById: u.id },
      { companyId: c.id, accountId: acc1.id, type: "TRANSFER", amount: "25", method: "CASH", occurredAt: new Date("2026-07-06T09:00:00Z"), createdById: u.id },
      { companyId: c.id, accountId: acc2.id, type: "COLLECTED", amount: "15", method: "CASH", occurredAt: new Date("2026-07-10T09:00:00Z"), createdById: u.id },
      { companyId: c.id, accountId: acc1.id, type: "COLLECTED", amount: "500", method: "BANK_TRANSFER", occurredAt: new Date("2026-06-20T09:00:00Z"), createdById: u.id },
    ],
  });

  // Daily debt snapshots for the debt-over-time chart: two in-range days across both accounts,
  // plus a June snapshot that must be excluded.
  await testPrisma.accountDebtSnapshot.createMany({
    data: [
      { companyId: c.id, accountId: acc1.id, capturedOn: new Date("2026-07-05"), totalDebt: "40" },
      { companyId: c.id, accountId: acc2.id, capturedOn: new Date("2026-07-05"), totalDebt: "5" },
      { companyId: c.id, accountId: acc1.id, capturedOn: new Date("2026-07-10"), totalDebt: "45" },
      { companyId: c.id, accountId: acc1.id, capturedOn: new Date("2026-06-20"), totalDebt: "999" },
    ],
  });

  return { c, user, acc1, acc2, au1, au2, au3 };
}

describe("company analytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("aggregates totals, byMethod, byCategory, trend and partners across all accounts", async () => {
    const { user, acc1, acc2 } = await seedCompanyA();
    const a = await getCompanyAnalytics(testPrisma, user, range);

    expect(a.totals.accounts).toBe(2);
    expect(a.totals.appUsers).toBe(3);
    expect(a.totals.activeUsers).toBe(2);
    expect(a.totals.totalDebt).toBe(55); // 40 + 10 + 5
    expect(a.totals.installs).toBe(2); // au1 + au2
    expect(a.totals.iosInstalls).toBe(1);
    expect(a.totals.androidInstalls).toBe(1);
    expect(a.totals.loggedInUsers).toBe(1); // only au1
    expect(a.totals.activationRate).toBeCloseTo((1 / 2) * 100, 1);

    // in-range payments only: 100 + 50 + 20 + 30 = 200 (the 999 in June excluded)
    expect(a.totals.paymentsCount).toBe(4);
    expect(a.totals.paymentsAmount).toBe(200);
    expect(a.totals.utilityCount).toBe(2); // au1's two CARD/UTILITY payments
    expect(a.totals.utilityAmount).toBe(130);

    // engagedUsers = distinct app users with >=1 payment in range => au1, au2, au3 = 3
    expect(a.totals.engagedUsers).toBe(3);

    const card = a.byMethod.find((m) => m.method === "CARD")!;
    expect(card.count).toBe(2);
    expect(card.amount).toBe(130);
    const cash = a.byMethod.find((m) => m.method === "CASH")!;
    expect(cash.amount).toBe(50);
    const manual = a.byMethod.find((m) => m.method === "MANUAL")!;
    expect(manual.amount).toBe(20);

    const utilityCat = a.byCategory.find((cc) => cc.category === "UTILITY")!;
    expect(utilityCat.amount).toBe(130);
    const apartmentCat = a.byCategory.find((cc) => cc.category === "APARTMENT")!;
    expect(apartmentCat.amount).toBe(50);
    const parkingCat = a.byCategory.find((cc) => cc.category === "PARKING")!;
    expect(parkingCat.amount).toBe(20);

    // trend: daily buckets within range only, June excluded
    expect(a.trend.every((t) => t.date.startsWith("2026-07"))).toBe(true);
    const trendTotal = a.trend.reduce((s, t) => s + t.amount, 0);
    expect(trendTotal).toBe(200);

    // moneyFlow: a 31-day range buckets daily ("YYYY-MM-DD" keys); June entries excluded.
    expect(a.moneyFlow.every((f) => f.date.startsWith("2026-07"))).toBe(true);
    const flowPaymentsIn = a.moneyFlow.reduce((s, f) => s + f.paymentsIn, 0);
    const flowCollected = a.moneyFlow.reduce((s, f) => s + f.collected, 0);
    const flowTransferred = a.moneyFlow.reduce((s, f) => s + f.transferred, 0);
    expect(flowPaymentsIn).toBe(200); // same in-range total as paymentsAmount
    expect(flowCollected).toBe(75); // 60 (acc1) + 15 (acc2); June's 500 excluded
    expect(flowTransferred).toBe(25);
    // bucket for 2026-07-05 carries both au1's two card payments (130) and the 60 collected entry
    const jul5 = a.moneyFlow.find((f) => f.date === "2026-07-05");
    expect(jul5?.paymentsIn).toBe(130);
    expect(jul5?.collected).toBe(60);
    const jul6 = a.moneyFlow.find((f) => f.date === "2026-07-06");
    expect(jul6?.paymentsIn).toBe(50);
    expect(jul6?.transferred).toBe(25);

    // partners: per-account comparison, sorted desc by paymentsAmount
    expect(a.partners).toHaveLength(2);
    expect(a.partners[0].accountId).toBe(acc1.id);
    expect(a.partners[0].accountName).toBe("Partner One");
    expect(a.partners[0].paymentsAmount).toBe(180); // 100 + 50 + 30
    expect(a.partners[0].paymentsCount).toBe(3);
    expect(a.partners[0].appUsers).toBe(2);
    expect(a.partners[0].installs).toBe(2);
    expect(a.partners[0].engagedUsers).toBe(2); // au1 + au2

    const partnerTwo = a.partners.find((p) => p.accountId === acc2.id)!;
    expect(partnerTwo.paymentsAmount).toBe(20);
    expect(partnerTwo.appUsers).toBe(1);
    expect(partnerTwo.installs).toBe(0);
    expect(partnerTwo.engagedUsers).toBe(1);

    // debtOverTime: per-day summed debt across accounts; June snapshot excluded, sorted by date
    expect(a.debtOverTime.every((d) => d.date.startsWith("2026-07"))).toBe(true);
    expect(a.debtOverTime).toEqual([
      { date: "2026-07-05", debt: 45 }, // acc1 40 + acc2 5
      { date: "2026-07-10", debt: 45 }, // acc1 only
    ]);
  });

  it("isolates tenants: company B's accounts/users/payments never appear in company A's analytics", async () => {
    const { user } = await seedCompanyA();

    // Company B — separate tenant with its own account, users, and in-range payments
    const cB = await testPrisma.company.create({ data: { name: "Company B", slug: `b-ca-${Date.now()}-${Math.random()}` } });
    const uB = await testPrisma.user.create({ data: { companyId: cB.id, email: `u-${Date.now()}-${Math.random()}@b.com`, passwordHash: "x", name: "UB", role: "COMPANY_ADMIN" } });
    const userB: SessionUser = { id: uB.id, companyId: cB.id, role: "COMPANY_ADMIN" };
    const accB = await testPrisma.account.create({ data: { companyId: cB.id, name: "Company B Partner", accountManagerId: uB.id } });
    const auB = await testPrisma.partnerAppUser.create({
      data: { companyId: cB.id, accountId: accB.id, externalId: "b1", name: "AUB", active: true, debt: "999", joinedAt: new Date("2026-01-01"), platform: "IOS", installedAt: new Date("2026-01-05"), lastLoginAt: new Date("2026-01-06") },
    });
    await testPrisma.partnerPayment.create({
      data: { companyId: cB.id, accountId: accB.id, appUserId: auB.id, occurredAt: new Date("2026-07-08T10:00:00Z"), amount: "5000", method: "CARD", category: "UTILITY" },
    });
    await testPrisma.settlementEntry.create({
      data: { companyId: cB.id, accountId: accB.id, type: "COLLECTED", amount: "3000", method: "BANK_TRANSFER", occurredAt: new Date("2026-07-08T10:00:00Z"), createdById: uB.id },
    });
    await testPrisma.accountDebtSnapshot.create({
      data: { companyId: cB.id, accountId: accB.id, capturedOn: new Date("2026-07-08"), totalDebt: "8000" },
    });

    const a = await getCompanyAnalytics(testPrisma, user, range);
    expect(a.totals.accounts).toBe(2);
    expect(a.partners.find((p) => p.accountId === accB.id)).toBeUndefined();
    expect(a.partners.some((p) => p.accountName === "Company B Partner")).toBe(false);
    expect(a.totals.paymentsAmount).toBe(200); // company B's 5000 never counted
    expect(a.totals.totalDebt).toBe(55); // company B's 999 debt never counted
    // company B's money-flow numbers (5000 in, 3000 collected) never leak into company A's buckets
    expect(a.moneyFlow.reduce((s, f) => s + f.paymentsIn, 0)).toBe(200);
    expect(a.moneyFlow.reduce((s, f) => s + f.collected, 0)).toBe(75);
    // company B's 8000 debt snapshot never appears in company A's debt trend (max stays 45)
    expect(Math.max(...a.debtOverTime.map((d) => d.debt))).toBe(45);

    const b = await getCompanyAnalytics(testPrisma, userB, range);
    expect(b.totals.accounts).toBe(1);
    expect(b.totals.paymentsAmount).toBe(5000);
    expect(b.partners).toHaveLength(1);
    expect(b.partners[0].accountId).toBe(accB.id);
    expect(b.moneyFlow.reduce((s, f) => s + f.paymentsIn, 0)).toBe(5000);
    expect(b.moneyFlow.reduce((s, f) => s + f.collected, 0)).toBe(3000);
  });
});
