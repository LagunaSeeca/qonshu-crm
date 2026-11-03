import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import { getAccount, listAccounts } from "./accounts";
import { getCompanyAnalytics } from "./company-analytics";
import { listCompanySettlements, addSettlementEntry } from "./settlements";
import { listCompanyServiceFees, addServiceFee } from "./service-fees";
import { leadScopeWhere, accountScopeWhere } from "./scope";
import { createUser, InvalidUserRoleError } from "./users";
import { ForbiddenError } from "@/lib/auth/guards";
import type { SessionUser } from "@/lib/auth/guards";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { makePartnerStats } from "@/test/partner-stats-fixture";

// getCompanyAnalytics is now a LIVE fan-out (see company-analytics.test.ts) — mock the external
// client so the getCompanyAnalytics cases below never hit the network. Every other case in this
// file (settlements/service-fees/users) is untouched by this mock.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";
const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

// Partner keys registered here so the fetchPartnerStats mock (wired in beforeEach) can look up
// the right canned response per account, keyed by the account's externalPartnerKey.
const statsByPartner = new Map<string, ReturnType<typeof makePartnerStats>>();

async function seed(slug: string) {
  const team = await makeTeam({ name: slug });
  const c = { id: team.companyId };
  const admin = await makeUser("COMPANY_ADMIN", team);
  const member = await makeUser("MEMBER", team);
  const adminUser: SessionUser = su(admin);
  const memberUser: SessionUser = su(member);

  // Two accounts, each with their own analytics/settlement/service-fee data. Both are wired up
  // as partner-configured by NAME only — the shared PARTNER_API_KEY env var (set in beforeEach
  // below) is what makes the live fan-out actually call out for them.
  const ownPartnerKey = `${slug}-own`;
  const otherPartnerKey = `${slug}-other`;
  const acc1 = await testPrisma.account.create({
    data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Own Account"), name: "Own Account", accountManagerId: admin.id, ...confirmedPartnerLink(ownPartnerKey) },
  });
  const acc2 = await testPrisma.account.create({
    data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Other Account"), name: "Other Account", accountManagerId: admin.id, ...confirmedPartnerLink(otherPartnerKey) },
  });
  statsByPartner.set(ownPartnerKey, makePartnerStats({ partner: ownPartnerKey, total_payments_amount: 150, total_debt: 40 }));
  statsByPartner.set(otherPartnerKey, makePartnerStats({ partner: otherPartnerKey, total_payments_amount: 5000, total_debt: 999 }));

  const partnerRecord = await makeUser("PARTNER_VIEWER", team, { accountId: acc1.id });
  const partnerUser: SessionUser = su(partnerRecord);
  const partnerUserNoAccount: SessionUser = { ...su(partnerRecord), accountId: null };

  // Settlement entries on both accounts.
  await addSettlementEntry(testPrisma, adminUser, acc1.id, { type: "COLLECTED", amount: 200, method: "CASH", occurredAt: new Date() });
  await addSettlementEntry(testPrisma, adminUser, acc2.id, { type: "COLLECTED", amount: 8000, method: "CASH", occurredAt: new Date() });

  // Service fees on both accounts.
  await addServiceFee(testPrisma, adminUser, acc1.id, { periodMonth: new Date("2026-07-01"), amount: 100 });
  await addServiceFee(testPrisma, adminUser, acc2.id, { periodMonth: new Date("2026-07-01"), amount: 3000 });

  return { c, team, admin, member, adminUser, memberUser, acc1, acc2, partnerUser, partnerUserNoAccount };
}

describe("partner portal security", () => {
  let savedSecret: string | undefined;
  let savedApiKey: string | undefined;
  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    process.env.PARTNER_API_KEY = SHARED_API_KEY;
    statsByPartner.clear();
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      const s = statsByPartner.get(partner);
      if (!s) throw new Error(`no mocked stats registered for partner: ${partner}`);
      return s;
    });
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
    else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
  });
  afterAll(() => testPrisma.$disconnect());

  it("getAccount: PARTNER_VIEWER can read their own account but gets null for another account in the same company", async () => {
    const { acc1, acc2, partnerUser } = await seed("pp-ga");
    const own = await getAccount(testPrisma, partnerUser, acc1.id);
    expect(own?.id).toBe(acc1.id);
    const other = await getAccount(testPrisma, partnerUser, acc2.id);
    expect(other).toBeNull();
  });

  it("listAccounts: PARTNER_VIEWER sees exactly one account (their own)", async () => {
    const { acc1, partnerUser } = await seed("pp-la");
    const list = await listAccounts(testPrisma, partnerUser);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(acc1.id);
  });

  it("getCompanyAnalytics: PARTNER_VIEWER sees only their own account's numbers", async () => {
    const { acc1, partnerUser } = await seed("pp-analytics");
    const a = await getCompanyAnalytics(testPrisma, partnerUser, range);
    expect(a.totals.accounts).toBe(1);
    expect(a.totals.paymentsAmount).toBe(150);
    expect(a.totals.totalDebt).toBe(40);
    expect(a.partners).toHaveLength(1);
    expect(a.partners[0].accountId).toBe(acc1.id);
    // the other account's huge numbers must never leak in
    expect(a.totals.paymentsAmount).not.toBe(5000);
    // and the other account was never even fetched
    expect(fetchPartnerStats).toHaveBeenCalledTimes(1);
  });

  it("listCompanySettlements: PARTNER_VIEWER sees only their own account's ledger", async () => {
    const { acc1, partnerUser } = await seed("pp-settle");
    const s = await listCompanySettlements(testPrisma, partnerUser);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].accountId).toBe(acc1.id);
    expect(s.totals.collected).toBe(200);
    expect(s.totals.collected).not.toBe(8000);
  });

  it("listCompanyServiceFees: PARTNER_VIEWER sees only their own account's fees", async () => {
    const { acc1, partnerUser } = await seed("pp-fees");
    const f = await listCompanyServiceFees(testPrisma, partnerUser);
    expect(f.rows).toHaveLength(1);
    expect(f.rows[0].accountId).toBe(acc1.id);
    expect(f.totals.billed).toBe(100);
    expect(f.totals.billed).not.toBe(3000);
  });

  it("fails closed: PARTNER_VIEWER with accountId null gets nothing everywhere", async () => {
    const { partnerUserNoAccount } = await seed("pp-noacct");
    expect(await getAccount(testPrisma, partnerUserNoAccount, "irrelevant-id")).toBeNull();
    expect(await listAccounts(testPrisma, partnerUserNoAccount)).toEqual([]);

    const a = await getCompanyAnalytics(testPrisma, partnerUserNoAccount, range);
    expect(a.totals.accounts).toBe(0);
    expect(a.partners).toHaveLength(0);

    const s = await listCompanySettlements(testPrisma, partnerUserNoAccount);
    expect(s.rows).toHaveLength(0);
    expect(s.totals.collected).toBe(0);

    const f = await listCompanyServiceFees(testPrisma, partnerUserNoAccount);
    expect(f.rows).toHaveLength(0);
    expect(f.totals.billed).toBe(0);
  });

  // leadVisibilityWhere(user, shareAll) is gone with shareAllLeads; leadScopeWhere has no flag, so
  // there is no longer a "shared" variant of the partner refusal to assert.
  it("leadScopeWhere throws ForbiddenError for PARTNER_VIEWER; accountScopeWhere pins them to their one account", async () => {
    const { partnerUser, partnerUserNoAccount, acc1 } = await seed("pp-crm");
    expect(() => leadScopeWhere(partnerUser)).toThrow(ForbiddenError);
    expect(accountScopeWhere(partnerUser)).toEqual({ companyId: partnerUser.companyId, id: acc1.id });
    // A partner with no accountId gets a sentinel id that matches nothing, never an unfiltered scope.
    expect(accountScopeWhere(partnerUserNoAccount).id).toBe("__no_access__");
  });

  it("direct creation: PARTNER_VIEWER without accountId is rejected", async () => {
    const { adminUser } = await seed("pp-inv1");
    await expect(
      createUser(testPrisma, adminUser, { name: "No Partner", email: "nopartner@a.com", password: "pw123456", role: "PARTNER_VIEWER" }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("direct creation: PARTNER_VIEWER with an accountId from another company is rejected", async () => {
    const { adminUser } = await seed("pp-inv2");
    const other = await seed("pp-inv2-other");
    await expect(
      createUser(testPrisma, adminUser, {
        name: "Cross", email: "cross@a.com", password: "pw123456", role: "PARTNER_VIEWER", accountId: other.acc1.id,
      }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("direct creation: a non-PARTNER_VIEWER role with an accountId is rejected", async () => {
    const { adminUser, acc1 } = await seed("pp-inv3");
    await expect(
      createUser(testPrisma, adminUser, { name: "X", email: "x@a.com", password: "pw123456", role: "MEMBER", accountId: acc1.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("direct creation: PARTNER_VIEWER with a valid accountId in the same company succeeds", async () => {
    const { adminUser, acc2 } = await seed("pp-inv4");
    const created = await createUser(testPrisma, adminUser, {
      name: "Good Partner", email: "goodpartner@a.com", password: "pw123456", role: "PARTNER_VIEWER", accountId: acc2.id,
    });
    expect(created.role).toBe("PARTNER_VIEWER");
    expect(created.accountId).toBe(acc2.id);
  });

  // CHANGED ON PURPOSE (teams refactor): this used to assert a MEMBER sees the whole company's
  // accounts (2). A MEMBER now sees only the accounts they MANAGE; both seeded accounts are managed
  // by the team admin, so the member sees none of them until one is assigned to them.
  it("COMPANY_ADMIN (team admin) sees both accounts; a MEMBER sees only the accounts they manage", async () => {
    const { adminUser, memberUser, member, team, c } = await seed("pp-regression");

    const aAdmin = await getCompanyAnalytics(testPrisma, adminUser, range);
    expect(aAdmin.totals.accounts).toBe(2);
    expect(aAdmin.totals.paymentsAmount).toBe(5150); // 150 + 5000

    const aMember = await getCompanyAnalytics(testPrisma, memberUser, range);
    expect(aMember.totals.accounts).toBe(0);
    expect(await listAccounts(testPrisma, memberUser)).toEqual([]);

    const sAdmin = await listCompanySettlements(testPrisma, adminUser);
    expect(sAdmin.rows).toHaveLength(2);
    expect(sAdmin.totals.collected).toBe(8200); // 200 + 8000

    const fAdmin = await listCompanyServiceFees(testPrisma, adminUser);
    expect(fAdmin.rows).toHaveLength(2);
    expect(fAdmin.totals.billed).toBe(3100); // 100 + 3000

    const listAdmin = await listAccounts(testPrisma, adminUser);
    expect(listAdmin).toHaveLength(2);

    // Scope: admin = their team; member = their team AND their own rows.
    expect(leadScopeWhere(adminUser)).toEqual({ companyId: adminUser.companyId, teamId: adminUser.teamId });
    expect(leadScopeWhere(memberUser)).toEqual({ companyId: memberUser.companyId, teamId: memberUser.teamId, ownerId: memberUser.id });

    // Give the member one account of their own: they see exactly that one, not the admin's two.
    const mine = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Member Account"), name: "Member Account", accountManagerId: member.id },
    });
    const mineList = await listAccounts(testPrisma, memberUser);
    expect(mineList.map((a) => a.id)).toEqual([mine.id]);
  });

  it("PARTNER_VIEWER cannot read another tenant's data at all (companyId isolation still holds)", async () => {
    const { partnerUser } = await seed("pp-tenant1");
    const other = await seed("pp-tenant2");
    expect(await getAccount(testPrisma, partnerUser, other.acc1.id)).toBeNull();
  });
});
