import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getPlatformOverview } from "./overview";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { InvalidApiKeyError } from "@/lib/partner-api/errors";
import { makePartnerStats } from "@/test/partner-stats-fixture";

// Platform Overview's app-user/payment figures are now a LIVE fan-out over the external
// Partner API (see src/lib/platform/overview.ts) instead of reads from the persisted
// partnerAppUser/partnerPayment tables — so the external client is mocked here, same as
// src/lib/tenant/company-analytics.test.ts, rather than seeding those old-model rows.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };
const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";

async function seedCompanyWithData(opts: {
  slug: string;
  admins: number;
  members: number;
  accounts: number;
  leadsPerAccount?: number;
}) {
  const company = await testPrisma.company.create({ data: { name: `Co ${opts.slug}`, slug: opts.slug } });
  const stage = await testPrisma.stage.create({ data: { companyId: company.id, name: "Open", order: 0, type: "OPEN" } });

  const admins = [];
  for (let i = 0; i < opts.admins; i++) {
    admins.push(
      await testPrisma.user.create({
        data: { companyId: company.id, email: `admin-${i}-${opts.slug}@a.com`, passwordHash: "x", name: `Admin ${i}`, role: "COMPANY_ADMIN" },
      }),
    );
  }
  for (let i = 0; i < opts.members; i++) {
    await testPrisma.user.create({
      data: { companyId: company.id, email: `member-${i}-${opts.slug}@a.com`, passwordHash: "x", name: `Member ${i}`, role: "MEMBER" },
    });
  }

  const owner = admins[0];
  const accounts = [];
  for (let i = 0; i < opts.accounts; i++) {
    const account = await testPrisma.account.create({
      data: { companyId: company.id, name: `Account ${i}`, accountManagerId: owner.id },
    });
    accounts.push(account);
    for (let j = 0; j < (opts.leadsPerAccount ?? 0); j++) {
      await testPrisma.lead.create({
        data: { companyId: company.id, title: `Lead ${i}-${j}`, contactName: "C", stageId: stage.id, ownerId: owner.id },
      });
    }
  }

  return { company, owner, accounts };
}

// Links an existing account to the external Partner API by partner NAME only — the shared
// PARTNER_API_KEY env var (set in beforeEach below) is what makes the live fan-out pick it up as
// "configured" instead of skipping it. There is no per-account key entry anymore.
async function configureAccount(accountId: string, partnerKey: string) {
  return testPrisma.account.update({
    where: { id: accountId },
    data: { externalPartnerKey: partnerKey },
  });
}

describe("getPlatformOverview", () => {
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

  it("returns correct per-company counts and platform totals, with live app-user/payment figures fanned out across companies", async () => {
    const ts = Date.now();
    const a = await seedCompanyWithData({
      slug: `ov-a-${ts}`, admins: 1, members: 2, accounts: 2, leadsPerAccount: 1,
    });
    const b = await seedCompanyWithData({
      slug: `ov-b-${ts}`, admins: 1, members: 0, accounts: 1, leadsPerAccount: 3,
    });

    await configureAccount(a.accounts[0].id, `${ts}-a0`);
    await configureAccount(a.accounts[1].id, `${ts}-a1`);
    await configureAccount(b.accounts[0].id, `${ts}-b0`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${ts}-a0`) return makePartnerStats({ partner, total_users: 5, total_payments_amount: 100 });
      if (partner === `${ts}-a1`) return makePartnerStats({ partner, total_users: 2, total_payments_amount: 50 });
      if (partner === `${ts}-b0`) return makePartnerStats({ partner, total_users: 1, total_payments_amount: 25 });
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const overview = await getPlatformOverview(testPrisma, su);

    const rowA = overview.companies.find((c) => c.id === a.company.id)!;
    const rowB = overview.companies.find((c) => c.id === b.company.id)!;

    expect(rowA.users).toBe(3); // 1 admin + 2 members
    expect(rowA.admins).toBe(1);
    expect(rowA.members).toBe(2);
    expect(rowA.accounts).toBe(2);
    expect(rowA.leads).toBe(2); // 1 lead per account x 2 accounts
    expect(rowA.appUsers).toBe(7); // 5 + 2, summed live across a0/a1
    expect(rowA.paymentsAmount).toBe(150); // 100 + 50

    expect(rowB.users).toBe(1);
    expect(rowB.admins).toBe(1);
    expect(rowB.members).toBe(0);
    expect(rowB.accounts).toBe(1);
    expect(rowB.leads).toBe(3);
    expect(rowB.appUsers).toBe(1);
    expect(rowB.paymentsAmount).toBe(25);

    // Totals should be at least the sum contributed by these two companies (other tests may
    // have left rows from a prior run in a shared DB, but resetDb() wipes between tests).
    expect(overview.totals.companies).toBe(2);
    expect(overview.totals.users).toBe(4);
    expect(overview.totals.accounts).toBe(3);
    expect(overview.totals.leads).toBe(5);
    expect(overview.totals.appUsers).toBe(8);
    expect(overview.totals.paymentsAmount).toBe(175);

    // Live fan-out coverage: all 3 configured accounts across both companies succeeded.
    expect(overview.liveData.contributed).toBe(3);
    expect(overview.liveData.skipped).toBe(0);
    expect(fetchPartnerStats).toHaveBeenCalledTimes(3);

    // Resolved YYYY-MM-DD bounds were forwarded to the client (bounded window — see overview.ts).
    expect(fetchPartnerStats).toHaveBeenCalledWith(
      expect.objectContaining({ partner: `${ts}-a0`, dateFrom: expect.any(String), dateTo: expect.any(String) }),
    );
  });

  it("skips unconfigured and errored accounts across companies without failing the page", async () => {
    const ts = Date.now();
    const a = await seedCompanyWithData({ slug: `ov-skip-a-${ts}`, admins: 1, members: 0, accounts: 2 });
    const b = await seedCompanyWithData({ slug: `ov-skip-b-${ts}`, admins: 1, members: 0, accounts: 1 });

    // a.accounts[0] is left unconfigured (no partner/API key).
    await configureAccount(a.accounts[1].id, `${ts}-ok`);
    await configureAccount(b.accounts[0].id, `${ts}-badkey`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${ts}-ok`) return makePartnerStats({ partner, total_users: 4, total_payments_amount: 40 });
      if (partner === `${ts}-badkey`) throw new InvalidApiKeyError();
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const overview = await getPlatformOverview(testPrisma, su);

    const rowA = overview.companies.find((c) => c.id === a.company.id)!;
    const rowB = overview.companies.find((c) => c.id === b.company.id)!;

    expect(rowA.appUsers).toBe(4);
    expect(rowA.paymentsAmount).toBe(40);
    expect(rowB.appUsers).toBe(0); // its only account's API call failed (bad key)
    expect(rowB.paymentsAmount).toBe(0);

    // 1 not_configured (a.accounts[0]) + 1 API failure (b's account) = 2 skipped, 1 contributed.
    expect(overview.liveData.contributed).toBe(1);
    expect(overview.liveData.skipped).toBe(2);

    // Non-partner counts (accounts/leads/users) are unaffected by the live fan-out outcome.
    expect(rowA.accounts).toBe(2);
    expect(rowB.accounts).toBe(1);
  });

  it("never calls the external API and returns a valid zeroed liveData when no accounts are configured", async () => {
    const ts = Date.now();
    await seedCompanyWithData({ slug: `ov-empty-${ts}`, admins: 1, members: 0, accounts: 1 });

    const overview = await getPlatformOverview(testPrisma, su);

    expect(overview.liveData.contributed).toBe(0);
    expect(overview.liveData.skipped).toBeGreaterThanOrEqual(1);
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("throws ForbiddenError for a non-SUPER_ADMIN caller (company isolation)", async () => {
    const ts = Date.now();
    const a = await seedCompanyWithData({ slug: `ov-forbid-a-${ts}`, admins: 1, members: 0, accounts: 0 });
    await seedCompanyWithData({ slug: `ov-forbid-b-${ts}`, admins: 1, members: 0, accounts: 0 });
    const companyAdmin: SessionUser = { id: "x", companyId: a.company.id, role: "COMPANY_ADMIN" };
    await expect(getPlatformOverview(testPrisma, companyAdmin)).rejects.toThrow(ForbiddenError);
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });
});
