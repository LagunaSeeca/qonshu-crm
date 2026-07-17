import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { getDashboardStats } from "./dashboard";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

describe("dashboard stats", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("counts open leads and meetings; isolates tenants", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-dash" } });
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    const openStage = stages.find((s) => s.type === "OPEN")!;
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: openStage.id });
    const lead = await createLead(testPrisma, user, { title: "D2", contactName: "C2", stageId: openStage.id });
    await testPrisma.activity.create({ data: { companyId: c.id, leadId: lead.id, kind: "MEETING", body: "met", occurredAt: new Date("2026-07-10T10:00:00Z") } });
    await testPrisma.task.create({ data: { companyId: c.id, leadId: lead.id, title: "t", done: false, dueDate: new Date("2026-07-02T00:00:00Z") } });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.openLeads).toBe(2);
    expect(s.activity.meetingsDone).toBe(1);
    expect(s.activity.openTasks).toBe(1);
    expect(s.activity.overdueTasks).toBe(1);

    // other tenant sees nothing
    const c2 = await testPrisma.company.create({ data: { name: "B", slug: "b-dash" } });
    const u2 = await testPrisma.user.create({ data: { companyId: c2.id, email: "u@b.com", passwordHash: "x", name: "U2", role: "COMPANY_ADMIN" } });
    const s2 = await getDashboardStats(testPrisma, { id: u2.id, companyId: c2.id, role: "COMPANY_ADMIN" }, range);
    expect(s2.sales.openLeads).toBe(0);
    expect(s2.activity.meetingsDone).toBe(0);
  });

  it("counts distinct engaged users (appUsers with a payment in period), not raw payment count", async () => {
    const c = await testPrisma.company.create({ data: { name: "C", slug: "c-dash" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@c.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    const account = await testPrisma.account.create({ data: { companyId: c.id, name: "Acc", accountManagerId: u.id } });
    const appUser1 = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: account.id, externalId: "e1", name: "User1", joinedAt: new Date("2026-01-01") } });
    const appUser2 = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: account.id, externalId: "e2", name: "User2", joinedAt: new Date("2026-01-01") } });
    // appUser1 pays twice in period, appUser2 pays once; both should count once each -> engagedUsers = 2
    await testPrisma.partnerPayment.createMany({ data: [
      { companyId: c.id, accountId: account.id, appUserId: appUser1.id, occurredAt: new Date("2026-07-05"), amount: 10, method: "CASH", category: "UTILITY" },
      { companyId: c.id, accountId: account.id, appUserId: appUser1.id, occurredAt: new Date("2026-07-15"), amount: 20, method: "CASH", category: "UTILITY" },
      { companyId: c.id, accountId: account.id, appUserId: appUser2.id, occurredAt: new Date("2026-07-20"), amount: 5, method: "CASH", category: "UTILITY" },
    ] });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.engagedUsers).toBe(2);
    expect(s.partners.paymentsAmount).toBe(35);
  });

  it("counts company-wide app installs (iOS/Android split), all-time regardless of period", async () => {
    const c = await testPrisma.company.create({ data: { name: "D", slug: "d-dash" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@d.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    const account = await testPrisma.account.create({ data: { companyId: c.id, name: "Acc", accountManagerId: u.id } });
    await testPrisma.partnerAppUser.createMany({
      data: [
        { companyId: c.id, accountId: account.id, externalId: "i1", name: "iOS1", joinedAt: new Date("2020-01-01"), platform: "IOS", installedAt: new Date("2020-01-05") },
        { companyId: c.id, accountId: account.id, externalId: "i2", name: "iOS2", joinedAt: new Date("2020-01-01"), platform: "IOS", installedAt: new Date("2020-01-06") },
        { companyId: c.id, accountId: account.id, externalId: "a1", name: "Android1", joinedAt: new Date("2020-01-01"), platform: "ANDROID", installedAt: new Date("2020-01-07") },
        { companyId: c.id, accountId: account.id, externalId: "n1", name: "NotInstalled", joinedAt: new Date("2020-01-01"), platform: "UNKNOWN" },
      ],
    });
    const s = await getDashboardStats(testPrisma, user, range); // range is July 2026, install dates are 2020 — proves all-time
    expect(s.partners.appInstalls).toBe(3);
    expect(s.partners.installsIos).toBe(2);
    expect(s.partners.installsAndroid).toBe(1);
  });
});
