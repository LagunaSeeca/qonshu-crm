import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getDashboardStats } from "./dashboard";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { makePartnerStats } from "@/test/partner-stats-fixture";
import { makeTeam, makeUser, su, uniq, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import type { Team, User } from "@prisma/client";

// The dashboard's "partners" section is now a LIVE fan-out (via getCompanyAnalytics) instead of
// reads against the persisted PartnerAppUser/PartnerPayment mock tables — mock the external
// client so these tests stay hermetic, matching company-analytics.test.ts's pattern.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };
const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";

// "Configured" now means only a partner NAME — the account goes live off the shared
// PARTNER_API_KEY env var (set in beforeEach below); there is no per-account key entry anymore.
async function makeAccount(team: Team, manager: User, name: string, partnerKey?: string) {
  return testPrisma.account.create({
    data: {
      companyId: team.companyId, teamId: team.id, buildingKey: buildingKey(`${name}-${uniq()}`),
      // A supplied key means a CONFIRMED link: the dashboard reads the partner fan-out, and a
      // pending link contributes nothing to it by design.
      name, accountManagerId: manager.id, ...(partnerKey ? confirmedPartnerLink(partnerKey) : {}),
    },
  });
}
async function makeStages(team: Team) {
  const base = { companyId: team.companyId, teamId: team.id };
  const open = await testPrisma.stage.create({ data: { ...base, name: "New", order: 0, type: "OPEN" } });
  const won = await testPrisma.stage.create({ data: { ...base, name: "Won", order: 1, type: "WON" } });
  return { open, won };
}
async function makeLead(team: Team, owner: User, stageId: string, title: string, extra: { wonAt?: Date } = {}) {
  return testPrisma.lead.create({
    data: {
      companyId: team.companyId, teamId: team.id, buildingKey: buildingKey(`${title}-${uniq()}`),
      title, contactName: "C", stageId, ownerId: owner.id, ...extra,
    },
  });
}
// A team admin with an account helper bound to their team.
async function adminSetup() {
  const team = await makeTeam();
  const admin = await makeUser("COMPANY_ADMIN", team);
  return { team, admin, user: su(admin), mk: (name: string, key?: string) => makeAccount(team, admin, name, key) };
}

describe("dashboard stats", () => {
  let savedSecret: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    process.env.PARTNER_API_KEY = SHARED_API_KEY;
    vi.mocked(fetchPartnerStats).mockReset();
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
  });
  afterAll(() => testPrisma.$disconnect());

  it("counts open leads and meetings; isolates tenants", async () => {
    const { team, admin, user } = await adminSetup();
    const { open } = await makeStages(team);
    await makeLead(team, admin, open.id, "D");
    const lead = await makeLead(team, admin, open.id, "D2");
    await testPrisma.activity.create({ data: { companyId: team.companyId, leadId: lead.id, kind: "MEETING", body: "met", occurredAt: new Date("2026-07-10T10:00:00Z") } });
    await testPrisma.task.create({ data: { companyId: team.companyId, leadId: lead.id, title: "t", done: false, dueDate: new Date("2026-07-02T00:00:00Z") } });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.openLeads).toBe(2);
    expect(s.activity.meetingsDone).toBe(1);
    expect(s.activity.openTasks).toBe(1);
    expect(s.activity.overdueTasks).toBe(1);

    // other tenant sees nothing
    const other = await adminSetup();
    const s2 = await getDashboardStats(testPrisma, other.user, range);
    expect(s2.sales.openLeads).toBe(0);
    expect(s2.activity.meetingsDone).toBe(0);

    // no partner-configured accounts on either tenant -> the live fan-out never hit the network
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("wonInPeriod counts on wonAt, not updatedAt: editing an old won lead does not re-count it", async () => {
    const { team, admin, user } = await adminSetup();
    const { won } = await makeStages(team);
    await makeLead(team, admin, won.id, "won in range", { wonAt: new Date("2026-07-15T00:00:00Z") });
    const old = await makeLead(team, admin, won.id, "won long ago", { wonAt: new Date("2026-01-10T00:00:00Z") });
    await makeLead(team, admin, won.id, "won later", { wonAt: new Date("2026-09-01T00:00:00Z") });
    await makeLead(team, admin, won.id, "legacy, no wonAt");
    // An edit bumps @updatedAt to the test-run date; the old logic would have keyed on that.
    await testPrisma.lead.update({ where: { id: old.id }, data: { contactName: "edited" } });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.wonInPeriod).toBe(1);
  });

  it("wonInPeriod ignores a lead with wonAt in range that is no longer in a WON stage", async () => {
    const { team, admin, user } = await adminSetup();
    const { open } = await makeStages(team);
    await makeLead(team, admin, open.id, "reopened", { wonAt: new Date("2026-07-15T00:00:00Z") });
    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.wonInPeriod).toBe(0);
  });

  it("member sees only their own leads/accounts; team admin the team; never a sibling team", async () => {
    const { team, user: adminUser } = await adminSetup();
    const member = await makeUser("MEMBER", team);
    const mate = await makeUser("MEMBER", team);
    const { open, won } = await makeStages(team);
    await makeLead(team, member, open.id, "mine");
    await makeLead(team, mate, open.id, "mates");
    await makeLead(team, member, won.id, "mine won", { wonAt: new Date("2026-07-05T00:00:00Z") });
    await makeLead(team, mate, won.id, "mates won", { wonAt: new Date("2026-07-06T00:00:00Z") });
    const myAcc = await makeAccount(team, member, "MyAcc");
    const mateAcc = await makeAccount(team, mate, "MateAcc");
    const inRange = new Date("2026-07-10T10:00:00Z");
    const c = team.companyId;
    await testPrisma.accountActivity.create({ data: { companyId: c, accountId: myAcc.id, kind: "MEETING", body: "m", occurredAt: inRange } });
    await testPrisma.accountActivity.create({ data: { companyId: c, accountId: mateAcc.id, kind: "MEETING", body: "m", occurredAt: inRange } });
    await testPrisma.accountTask.create({ data: { companyId: c, accountId: myAcc.id, title: "t" } });
    await testPrisma.accountTask.create({ data: { companyId: c, accountId: mateAcc.id, title: "t" } });
    // a sibling team's data in the same company
    const sib = await makeTeam({ companyId: c });
    const sibAdmin = await makeUser("COMPANY_ADMIN", sib);
    const sibStages = await makeStages(sib);
    await makeLead(sib, sibAdmin, sibStages.open.id, "sibling lead");
    await makeAccount(sib, sibAdmin, "SibAcc");

    const m = await getDashboardStats(testPrisma, su(member), range);
    expect(m.sales).toEqual({ openLeads: 1, wonInPeriod: 1 });
    expect(m.partners.accounts).toBe(1);
    expect(m.activity.meetingsDone).toBe(1);
    expect(m.activity.openTasks).toBe(1);

    const a = await getDashboardStats(testPrisma, adminUser, range);
    expect(a.sales).toEqual({ openLeads: 2, wonInPeriod: 2 });
    expect(a.partners.accounts).toBe(2);
    expect(a.activity.meetingsDone).toBe(2);
    expect(a.activity.openTasks).toBe(2);
  });

  it("aggregates live partner totals (engaged users, payments amount) across configured accounts, skipping unconfigured ones", async () => {
    const slug = `dash-agg-${Date.now()}-${Math.random()}`;
    const { user, mk } = await adminSetup();
    await mk("Partner One", `${slug}-p1`);
    await mk("Partner Two", `${slug}-p2`);
    await mk("Not Linked"); // no partner key

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-p1`) {
        return makePartnerStats({ partner, total_users: 5, active_users: 4, logged_in_users: 3, engaged_users: 1, total_payments_amount: 20 });
      }
      if (partner === `${slug}-p2`) {
        return makePartnerStats({ partner, total_users: 2, active_users: 2, logged_in_users: 1, engaged_users: 1, total_payments_amount: 15 });
      }
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.engagedUsers).toBe(2);
    expect(s.partners.paymentsAmount).toBe(35);
    expect(s.partners.appUsers).toBe(7);
    expect(s.partners.activeAppUsers).toBe(4); // logged_in_users (3+1), not active_users (4+2)
    // "accounts" stays a plain in-scope Account count (all 3, configured or not) — it's
    // CRM data, not partner-app data, so it isn't sourced from the live fan-out.
    expect(s.partners.accounts).toBe(3);
    expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ partner: `${slug}-p1` }));
  });

  it("sums live app-install counts (iOS/Android split) for the selected range across configured accounts", async () => {
    const slug = `dash-installs-${Date.now()}-${Math.random()}`;
    const { user, mk } = await adminSetup();
    await mk("Acc", `${slug}-p1`);

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
    const { user, mk } = await adminSetup();
    await mk("OK", `${slug}-ok`);
    await mk("Broken", `${slug}-broken`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-ok`) return makePartnerStats({ partner, total_payments_amount: 42 });
      throw new Error("boom");
    });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.partners.paymentsAmount).toBe(42);
  });
});
