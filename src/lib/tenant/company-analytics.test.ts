import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getCompanyAnalytics } from "./company-analytics";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import { makePartnerStats } from "@/test/partner-stats-fixture";
import { dbWithPhantomPartnerKey } from "@/test/duplicate-partner-db";
import { makeTeam, makeUser, su, uniq, buildingKey } from "@/test/fixtures";

// Company analytics is now a LIVE fan-out: never reads persisted payment/debt tables, just
// calls the external Partner API once per configured account and aggregates in memory. So the
// external client is mocked here — a real network call would make these tests flaky and slow.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };
const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";

// "Configured" now means only a partner NAME — the account goes live off the shared
// PARTNER_API_KEY env var (set in beforeEach below); there is no per-account key entry anymore.
// Accounts need a teamId + buildingKey; both follow the manager so the row is consistent with the
// team wiring. `partnerKey` omitted = a not-linked account.
async function makeAccount(managerId: string, name: string, partnerKey?: string) {
  const m = await testPrisma.user.findUniqueOrThrow({ where: { id: managerId } });
  return testPrisma.account.create({
    data: {
      companyId: m.companyId!, teamId: m.teamId!, buildingKey: buildingKey(`${name}-${uniq()}`),
      name, accountManagerId: managerId,
      ...(partnerKey ? { externalPartnerKey: partnerKey } : {}),
    },
  });
}

async function makeConfiguredAccount(_companyId: string, managerId: string, name: string, partnerKey: string) {
  return makeAccount(managerId, name, partnerKey);
}

async function makeCompanyAndAdmin(_slug: string) {
  const team = await makeTeam();
  const u = await makeUser("COMPANY_ADMIN", team);
  return { c: { id: team.companyId }, team, u, user: su(u) };
}

describe("company analytics (live fan-out)", () => {
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

  // Defence in depth for a duplicate that predates @@unique([externalPartnerKey]): every figure
  // here is a plain SUM, so two accounts on one complex would double the whole page. A real
  // duplicate row is uninsertable now, so the second claim is injected at the query boundary —
  // see src/test/duplicate-partner-db.ts.
  it("counts a partner ONCE when two accounts hold the same externalPartnerKey", async () => {
    const slug = `ca-dupe-${Date.now()}-${Math.random()}`;
    const { c, u, user } = await makeCompanyAndAdmin(slug);
    const partnerKey = `${slug}-shared`;
    await makeConfiguredAccount(c.id, u.id, "Account A", partnerKey);
    const b = await makeAccount(u.id, "Account B");
    const db = dbWithPhantomPartnerKey(b.id, partnerKey); // same partner, second claim

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) =>
      makePartnerStats({ partner, total_users: 10, total_payments_amount: 100, total_payments_count: 2 }),
    );

    const a = await getCompanyAnalytics(db, user, range);

    // One upstream call, one contribution, one partner row — not two of each.
    expect(vi.mocked(fetchPartnerStats)).toHaveBeenCalledTimes(1);
    expect(a.totals.appUsers).toBe(10);
    expect(a.totals.paymentsAmount).toBe(100);
    expect(a.totals.accounts).toBe(1);
    expect(a.partners).toHaveLength(1);
    // The loser is reported rather than silently dropped, so the coverage line stays honest.
    expect(a.contributed).toBe(1);
    expect(a.skipped).toBe(1);
    expect(a.accountStatuses.filter((st) => st.reason === "duplicate_partner")).toHaveLength(1);
  });

  it("aggregates totals/byMethod/byCategory/partners across configured accounts and skips unconfigured ones", async () => {
    const slug = `ca-agg-${Date.now()}-${Math.random()}`;
    const { c, u, user } = await makeCompanyAndAdmin(slug);
    const acc1 = await makeConfiguredAccount(c.id, u.id, "Partner One", `${slug}-p1`);
    const acc2 = await makeConfiguredAccount(c.id, u.id, "Partner Two", `${slug}-p2`);
    const acc3 = await makeAccount(u.id, "Not Linked"); // no partner key/API key

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-p1`) {
        return makePartnerStats({
          partner,
          total_users: 10,
          active_users: 8,
          engaged_users: 6,
          total_debt: 40,
          total_installations: 5,
          ios_installations: 3,
          android_installations: 2,
          logged_in_users: 4,
          total_payments_count: 3,
          total_payments_amount: 180,
          amount_by_card: 130,
          amount_by_manual: 0,
          amount_by_cash: 50,
          utility_payments_count: 2,
          utility_payments_amount: 130,
          apartment_payments_amount: 50,
          parking_payments_amount: 0,
          property_payments_amount: 0,
          office_payments_amount: 0,
        });
      }
      if (partner === `${slug}-p2`) {
        return makePartnerStats({
          partner,
          total_users: 1,
          active_users: 1,
          engaged_users: 1,
          total_debt: 5,
          total_installations: 0,
          ios_installations: 0,
          android_installations: 0,
          logged_in_users: 0,
          total_payments_count: 1,
          total_payments_amount: 20,
          amount_by_card: 0,
          amount_by_manual: 20,
          amount_by_cash: 0,
          utility_payments_count: 0,
          utility_payments_amount: 0,
          apartment_payments_amount: 0,
          parking_payments_amount: 20,
          property_payments_amount: 0,
          office_payments_amount: 0,
        });
      }
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const a = await getCompanyAnalytics(testPrisma, user, range);

    expect(a.totals.accounts).toBe(2);
    expect(a.totals.appUsers).toBe(11);
    expect(a.totals.activeUsers).toBe(9);
    expect(a.totals.engagedUsers).toBe(7);
    expect(a.totals.totalDebt).toBe(45);
    expect(a.totals.installs).toBe(5);
    expect(a.totals.iosInstalls).toBe(3);
    expect(a.totals.androidInstalls).toBe(2);
    expect(a.totals.loggedInUsers).toBe(4);
    expect(a.totals.activationRate).toBeCloseTo((4 / 5) * 100, 1);
    expect(a.totals.paymentsCount).toBe(4);
    expect(a.totals.paymentsAmount).toBe(200);
    expect(a.totals.utilityCount).toBe(2);
    expect(a.totals.utilityAmount).toBe(130);

    // byMethod: fixed order, amounts only (no `.count` — the aggregate endpoint reports amounts only)
    expect(a.byMethod.map((m) => m.method)).toEqual(["CARD", "MANUAL", "CASH"]);
    expect(a.byMethod.find((m) => m.method === "CARD")!.amount).toBe(130);
    expect(a.byMethod.find((m) => m.method === "CASH")!.amount).toBe(50);
    expect(a.byMethod.find((m) => m.method === "MANUAL")!.amount).toBe(20);

    // byCategory: fixed order across all five categories
    expect(a.byCategory.map((cc) => cc.category)).toEqual([
      "APARTMENT", "PARKING", "PROPERTY", "OFFICE", "UTILITY",
    ]);
    expect(a.byCategory.find((cc) => cc.category === "APARTMENT")!.amount).toBe(50);
    expect(a.byCategory.find((cc) => cc.category === "PARKING")!.amount).toBe(20);
    expect(a.byCategory.find((cc) => cc.category === "PROPERTY")!.amount).toBe(0);
    expect(a.byCategory.find((cc) => cc.category === "OFFICE")!.amount).toBe(0);
    expect(a.byCategory.find((cc) => cc.category === "UTILITY")!.amount).toBe(130);

    // partners: per-account rows, sorted desc by paymentsAmount
    expect(a.partners).toHaveLength(2);
    expect(a.partners[0].accountId).toBe(acc1.id);
    expect(a.partners[0].accountName).toBe("Partner One");
    expect(a.partners[0].paymentsAmount).toBe(180);
    expect(a.partners[1].accountId).toBe(acc2.id);
    expect(a.partners[1].paymentsAmount).toBe(20);

    // accountStatuses / contributed / skipped — the fan-out status report
    expect(a.contributed).toBe(2);
    expect(a.skipped).toBe(1);
    expect(a.accountStatuses).toHaveLength(3);
    const skippedStatus = a.accountStatuses.find((s) => s.accountId === acc3.id)!;
    expect(skippedStatus.status).toBe("skipped");
    expect(skippedStatus.reason).toBe("not_configured");
    const okAccountIds = a.accountStatuses.filter((s) => s.status === "ok").map((s) => s.accountId).sort();
    expect(okAccountIds).toEqual([acc1.id, acc2.id].sort());

    // the resolved YYYY-MM-DD range bounds were forwarded to the client
    expect(fetchPartnerStats).toHaveBeenCalledWith(
      expect.objectContaining({ partner: `${slug}-p1`, dateFrom: "2026-07-01", dateTo: "2026-07-31" }),
    );
  });

  it("isolates one account's failure from the rest and reports the specific skip reason per error type", async () => {
    const slug = `ca-fail-${Date.now()}-${Math.random()}`;
    const { c, u, user } = await makeCompanyAndAdmin(slug);
    const ok = await makeConfiguredAccount(c.id, u.id, "OK", `${slug}-ok`);
    const badKey = await makeConfiguredAccount(c.id, u.id, "Bad Key", `${slug}-badkey`);
    const unknown = await makeConfiguredAccount(c.id, u.id, "Unknown", `${slug}-unknown`);
    const down = await makeConfiguredAccount(c.id, u.id, "Down", `${slug}-down`);
    const boom = await makeConfiguredAccount(c.id, u.id, "Boom", `${slug}-boom`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === `${slug}-ok`) return makePartnerStats({ partner, total_payments_amount: 99 });
      if (partner === `${slug}-badkey`) throw new InvalidApiKeyError();
      if (partner === `${slug}-unknown`) throw new UnknownPartnerError();
      if (partner === `${slug}-down`) throw new PartnerApiUnavailableError();
      if (partner === `${slug}-boom`) throw new Error("zod validation blew up");
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const a = await getCompanyAnalytics(testPrisma, user, range);

    expect(a.contributed).toBe(1);
    expect(a.skipped).toBe(4);
    expect(a.totals.accounts).toBe(1);
    expect(a.totals.paymentsAmount).toBe(99);
    expect(a.partners).toHaveLength(1);
    expect(a.partners[0].accountId).toBe(ok.id);

    const reason = (id: string) => a.accountStatuses.find((s) => s.accountId === id)!.reason;
    expect(reason(badKey.id)).toBe("invalid_key");
    expect(reason(unknown.id)).toBe("unknown_partner");
    expect(reason(down.id)).toBe("unavailable");
    expect(reason(boom.id)).toBe("error");
    expect(a.accountStatuses.find((s) => s.accountId === ok.id)!.status).toBe("ok");
  });

  it("opts.accountId scopes the fan-out to a single account and fetches only that one", async () => {
    const slug = `ca-single-${Date.now()}-${Math.random()}`;
    const { c, u, user } = await makeCompanyAndAdmin(slug);
    await makeConfiguredAccount(c.id, u.id, "Partner One", `${slug}-p1`);
    const acc2 = await makeConfiguredAccount(c.id, u.id, "Partner Two", `${slug}-p2`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) =>
      makePartnerStats({ partner, total_payments_amount: partner === `${slug}-p2` ? 20 : 180 }),
    );

    const a = await getCompanyAnalytics(testPrisma, user, range, { accountId: acc2.id });

    expect(a.totals.accounts).toBe(1);
    expect(a.partners).toHaveLength(1);
    expect(a.partners[0].accountId).toBe(acc2.id);
    expect(a.partners[0].paymentsAmount).toBe(20);
    expect(fetchPartnerStats).toHaveBeenCalledTimes(1);
    expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ partner: `${slug}-p2` }));
  });

  it("never fetches or aggregates another tenant's accounts", async () => {
    const slugA = `ca-tenA-${Date.now()}-${Math.random()}`;
    const slugB = `ca-tenB-${Date.now()}-${Math.random()}`;
    const { c: cA, u: uA, user: userA } = await makeCompanyAndAdmin(slugA);
    const { c: cB, u: uB } = await makeCompanyAndAdmin(slugB);
    const accA = await makeConfiguredAccount(cA.id, uA.id, "A Partner", `${slugA}-p1`);
    const accB = await makeConfiguredAccount(cB.id, uB.id, "B Partner", `${slugB}-p1`);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) =>
      makePartnerStats({ partner, total_payments_amount: partner === `${slugB}-p1` ? 999999 : 10 }),
    );

    const a = await getCompanyAnalytics(testPrisma, userA, range);
    expect(a.totals.accounts).toBe(1);
    expect(a.partners).toHaveLength(1);
    expect(a.partners[0].accountId).toBe(accA.id);
    expect(a.totals.paymentsAmount).toBe(10);
    expect(fetchPartnerStats).not.toHaveBeenCalledWith(expect.objectContaining({ partner: `${slugB}-p1` }));
    expect(a.partners.some((p) => p.accountId === accB.id)).toBe(false);
  });

  it("returns a valid zeroed result and never calls the API when the company has no accounts", async () => {
    const slug = `ca-empty-${Date.now()}-${Math.random()}`;
    const { user } = await makeCompanyAndAdmin(slug);

    const a = await getCompanyAnalytics(testPrisma, user, range);

    expect(a.totals.accounts).toBe(0);
    expect(a.contributed).toBe(0);
    expect(a.skipped).toBe(0);
    expect(a.partners).toEqual([]);
    expect(a.accountStatuses).toEqual([]);
    expect(a.totals.activationRate).toBe(0); // guarded against /0
    expect(a.byMethod.every((m) => m.amount === 0)).toBe(true);
    expect(a.byCategory.every((cc) => cc.amount === 0)).toBe(true);
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("scopes the fan-out: member = managed accounts only, team admin = own team only", async () => {
    const slug = `ca-scope-${Date.now()}-${Math.random()}`;
    const { team, u: admin, user: adminUser } = await makeCompanyAndAdmin(slug);
    const member = await makeUser("MEMBER", team);
    const otherMember = await makeUser("MEMBER", team);
    const sibling = await makeTeam({ companyId: team.companyId });
    const siblingAdmin = await makeUser("COMPANY_ADMIN", sibling);
    const mine = await makeAccount(member.id, "Mine", `${slug}-mine`);
    const theirs = await makeAccount(otherMember.id, "Theirs", `${slug}-theirs`);
    const foreign = await makeAccount(siblingAdmin.id, "Foreign", `${slug}-foreign`);
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => makePartnerStats({ partner, total_payments_amount: 10 }));

    const m = await getCompanyAnalytics(testPrisma, su(member), range);
    expect(m.partners.map((p) => p.accountId)).toEqual([mine.id]);

    vi.mocked(fetchPartnerStats).mockClear();
    const a = await getCompanyAnalytics(testPrisma, adminUser, range);
    expect(a.partners.map((p) => p.accountId).sort()).toEqual([mine.id, theirs.id].sort());
    expect(fetchPartnerStats).not.toHaveBeenCalledWith(expect.objectContaining({ partner: `${slug}-foreign` }));

    // single-account filter cannot reach out of scope either
    await expect(getCompanyAnalytics(testPrisma, su(member), range, { accountId: theirs.id })).rejects.toThrow();
    await expect(getCompanyAnalytics(testPrisma, adminUser, range, { accountId: foreign.id })).rejects.toThrow();
    void admin;
  });
});
