import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { getDashboardStats } from "./dashboard";
import { encryptSecret } from "@/lib/crypto/secret";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { makePartnerStats } from "@/test/partner-stats-fixture";
import type { SessionUser } from "@/lib/auth/guards";

// The dashboard's "partners" section is now a LIVE fan-out (via getCompanyAnalytics) instead of
// reads against the persisted PartnerAppUser/PartnerPayment mock tables — mock the external
// client so these tests stay hermetic, matching company-analytics.test.ts's pattern.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };
const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async function makeConfiguredAccount(companyId: string, managerId: string, name: string, partnerKey: string) {
  return testPrisma.account.create({
    data: {
      companyId,
      name,
      accountManagerId: managerId,
      externalPartnerKey: partnerKey,
      externalApiKeyEnc: encryptSecret(`key-for-${partnerKey}`),
      externalApiKeyLast4: "abcd",
    },
  });
}

describe("dashboard stats", () => {
  let savedSecret: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    vi.mocked(fetchPartnerStats).mockReset();
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = savedSecret;
  });
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

    // no partner-configured accounts on either tenant -> the live fan-out never hit the network
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("aggregates live partner totals (engaged users, payments amount) across configured accounts, skipping unconfigured ones", async () => {
    const slug = `dash-agg-${Date.now()}-${Math.random()}`;
    const c = await testPrisma.company.create({ data: { name: "C", slug } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u@${slug}.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    await makeConfiguredAccount(c.id, u.id, "Partner One", `${slug}-p1`);
    await makeConfiguredAccount(c.id, u.id, "Partner Two", `${slug}-p2`);
    await testPrisma.account.create({ data: { companyId: c.id, name: "Not Linked", accountManagerId: u.id } }); // no partner key

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-p1`) {
        return makePartnerStats({ partner, total_users: 5, active_users: 4, engaged_users: 1, total_payments_amount: 20 });
      }
      if (partner === `${slug}-p2`) {
        return makePartnerStats({ partner, total_users: 2, active_users: 2, engaged_users: 1, total_payments_amount: 15 });
      }
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.engagedUsers).toBe(2);
    expect(s.partners.paymentsAmount).toBe(35);
    expect(s.partners.appUsers).toBe(7);
    expect(s.partners.activeAppUsers).toBe(6);
    // "accounts" stays a plain company-wide Account count (all 3, configured or not) — it's
    // CRM data, not partner-app data, so it isn't sourced from the live fan-out.
    expect(s.partners.accounts).toBe(3);
    expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ partner: `${slug}-p1` }));
  });

  it("sums live app-install counts (iOS/Android split) for the selected range across configured accounts", async () => {
    const slug = `dash-installs-${Date.now()}-${Math.random()}`;
    const c = await testPrisma.company.create({ data: { name: "D", slug } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u@${slug}.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    await makeConfiguredAccount(c.id, u.id, "Acc", `${slug}-p1`);

    vi.mocked(fetchPartnerStats).mockResolvedValue(
      makePartnerStats({ partner: `${slug}-p1`, total_installations: 3, ios_installations: 2, android_installations: 1 }),
    );

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.appInstalls).toBe(3);
    expect(s.partners.installsIos).toBe(2);
    expect(s.partners.installsAndroid).toBe(1);
  });

  it("isolates one account's failure from the rest instead of failing the whole dashboard", async () => {
    const slug = `dash-fail-${Date.now()}-${Math.random()}`;
    const c = await testPrisma.company.create({ data: { name: "E", slug } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u@${slug}.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    await makeConfiguredAccount(c.id, u.id, "OK", `${slug}-ok`);
    await makeConfiguredAccount(c.id, u.id, "Broken", `${slug}-broken`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-ok`) return makePartnerStats({ partner, total_payments_amount: 42 });
      throw new Error("boom");
    });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.paymentsAmount).toBe(42);
  });
});
