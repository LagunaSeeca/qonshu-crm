import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getReport, toCsv } from "./reports";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import { makePartnerStats, makePartnerPayment } from "@/test/partner-stats-fixture";
import { dbWithPhantomPartnerKey } from "@/test/duplicate-partner-db";
import { makeTeam, makeUser, su, uniq, buildingKey, confirmedPartnerLink } from "@/test/fixtures";

// Reports are a LIVE read of the external Partner API (paginated payments), so the client is
// mocked here — a real network call would make these tests flaky and slow. The DB is still used
// for accounts / settlements / dashboard KPIs.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };
const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";

// "Configured" now means only a partner NAME — the account goes live off the shared
// PARTNER_API_KEY env var (set in beforeEach below); there is no per-account key entry anymore.
// Accounts need a teamId + buildingKey; both follow the manager so the row is consistent with the
// team wiring. `partnerKey` omitted = a not-linked account; supplied = a CONFIRMED link, which
// is what these fan-outs are about (a PENDING link is skipped as not_configured — see
// ./partner-link-approval.test.ts).
async function makeAccount(managerId: string, name: string, partnerKey?: string) {
  const m = await testPrisma.user.findUniqueOrThrow({ where: { id: managerId } });
  return testPrisma.account.create({
    data: {
      companyId: m.companyId!, teamId: m.teamId!, buildingKey: buildingKey(`${name}-${uniq()}`),
      name, accountManagerId: managerId,
      ...(partnerKey ? confirmedPartnerLink(partnerKey) : {}),
    },
  });
}

async function mkAdmin() {
  const team = await makeTeam();
  const u = await makeUser("COMPANY_ADMIN", team);
  return { team, u, user: su(u) };
}

async function setup(slug: string, opts?: { configured?: boolean; partnerKey?: string }) {
  const { team, u, user } = await mkAdmin();
  const acc = await makeAccount(u.id, "Partner, Inc", opts?.configured ? (opts.partnerKey ?? `${slug}-p1`) : undefined);
  return { c: { id: team.companyId }, u, acc, user };
}

describe("reports (live partner API)", () => {
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

  it("ALL scope lists partner rows; CSV escapes commas and includes the payment-detail section", async () => {
    const { user } = await setup("r1", { configured: true, partnerKey: "r1-p1" });
    vi.mocked(fetchPartnerStats).mockResolvedValue(
      makePartnerStats({
        partner: "r1-p1",
        total_payments_count: 2,
        total_payments_amount: 300,
        payments: [
          makePartnerPayment({ id: "pay-1", user_name: "Alice", amount: 100, method: "CARD", category: "APARTMENT" }),
          makePartnerPayment({ id: "pay-2", user_name: "Bob", amount: 200, method: "CASH", category: "PARKING" }),
        ],
        payments_page: 1,
        payments_page_count: 1,
        payments_total_count: 2,
      }),
    );

    const r = await getReport(testPrisma, user, { range, label: "July 2026" });
    expect(r.scope).toBe("ALL");
    expect(r.partnerRows.length).toBe(1);
    expect(r.partnerRows[0].paymentsCount).toBe(2);
    expect(r.partnerRows[0].paymentsAmount).toBe(300);
    expect(r.payments.length).toBe(2);
    expect(r.accountStatuses[0].status).toBe("ok");

    const csv = toCsv(r);
    expect(csv).toContain("Partner,Payments,Payments Amount,Collected,Transferred,Owed");
    expect(csv).toContain('"Partner, Inc"');
    expect(csv).toContain("Account,Payment ID,User ID,User Name,Date,Amount,Method,Category");
    expect(csv).toContain("pay-1");
    expect(csv).toContain("Alice");

    // Live range bounds forwarded as YYYY-MM-DD.
    expect(fetchPartnerStats).toHaveBeenCalledWith(
      expect.objectContaining({ partner: "r1-p1", dateFrom: "2026-07-01", dateTo: "2026-07-31" }),
    );
  });

  it("pages through all payment pages and flattens them, using summary totals for the aggregate", async () => {
    const { user } = await setup("rpage", { configured: true, partnerKey: "rpage-p1" });
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ page }) =>
      makePartnerStats({
        partner: "rpage-p1",
        total_payments_count: 3,
        total_payments_amount: 600,
        payments_page: page ?? 1,
        payments_page_count: 3,
        payments_total_count: 3,
        payments: [makePartnerPayment({ id: `p-${page}`, amount: 200 })],
      }),
    );

    const r = await getReport(testPrisma, user, { range, label: "July 2026" });

    // Isolate the report's own paginated calls (page-less calls come from the live KPI/analytics
    // fan-out inside getDashboardStats). Report pagination = page 1 + the 2 remaining pages, all
    // at the 500 max page size.
    const pagedCalls = vi
      .mocked(fetchPartnerStats)
      .mock.calls.map((c) => c[0] as { page?: number; pageSize?: number })
      .filter((a) => a.page !== undefined);
    expect(pagedCalls.map((a) => a.page).sort()).toEqual([1, 2, 3]);
    expect(pagedCalls.every((a) => a.pageSize === 500)).toBe(true);
    // flattened detail = one row per page
    expect(r.payments.map((p) => p.id).sort()).toEqual(["p-1", "p-2", "p-3"]);
    // aggregate comes from the summary totals (not the page count)
    expect(r.partnerRows[0].paymentsCount).toBe(3);
    expect(r.partnerRows[0].paymentsAmount).toBe(600);
    expect(r.accountStatuses[0].status).toBe("ok");
  });

  it("flags an account partial when a later page fails but keeps the aggregate + other pages", async () => {
    const { user } = await setup("rpart", { configured: true, partnerKey: "rpart-p1" });
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ page }) => {
      if (page === 2) throw new PartnerApiUnavailableError();
      return makePartnerStats({
        partner: "rpart-p1",
        total_payments_count: 2,
        total_payments_amount: 250,
        payments_page: page ?? 1,
        payments_page_count: 2,
        payments_total_count: 2,
        payments: [makePartnerPayment({ id: `p-${page}` })],
      });
    });

    const r = await getReport(testPrisma, user, { range, label: "July 2026" });
    expect(r.accountStatuses[0].status).toBe("partial");
    expect(r.accountStatuses[0].reason).toBe("partial");
    // aggregate still authoritative; only page 1's detail survived
    expect(r.partnerRows[0].paymentsCount).toBe(2);
    expect(r.partnerRows[0].paymentsAmount).toBe(250);
    expect(r.payments.map((p) => p.id)).toEqual(["p-1"]);
    expect(toCsv(r)).toContain("Skipped accounts");
  });

  it("skips unconfigured accounts and isolates per-error reasons; one bad account never fails the export", async () => {
    const { u, user } = await mkAdmin();
    const mk = (name: string, partnerKey?: string) => makeAccount(u.id, name, partnerKey);
    const ok = await mk("OK", "rmix-ok");
    const badKey = await mk("Bad Key", "rmix-badkey");
    const unknown = await mk("Unknown", "rmix-unknown");
    const down = await mk("Down", "rmix-down");
    const boom = await mk("Boom", "rmix-boom");
    const notConfigured = await mk("Not Linked");

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === "rmix-ok") return makePartnerStats({ partner, total_payments_count: 1, total_payments_amount: 99 });
      if (partner === "rmix-badkey") throw new InvalidApiKeyError();
      if (partner === "rmix-unknown") throw new UnknownPartnerError();
      if (partner === "rmix-down") throw new PartnerApiUnavailableError();
      if (partner === "rmix-boom") throw new Error("zod validation blew up");
      throw new Error(`unexpected partner key: ${partner}`);
    });

    const r = await getReport(testPrisma, user, { range, label: "July 2026" });

    // every account is still a row (shape preserved), errored/unconfigured show 0 payments
    expect(r.partnerRows.length).toBe(6);
    const reason = (id: string) => r.accountStatuses.find((s) => s.accountId === id)!.reason;
    expect(reason(badKey.id)).toBe("invalid_key");
    expect(reason(unknown.id)).toBe("unknown_partner");
    expect(reason(down.id)).toBe("unavailable");
    expect(reason(boom.id)).toBe("error");
    expect(reason(notConfigured.id)).toBe("not_configured");
    expect(r.accountStatuses.find((s) => s.accountId === ok.id)!.status).toBe("ok");
    const okRow = r.partnerRows.find((row) => row.accountId === ok.id)!;
    expect(okRow.paymentsAmount).toBe(99);
    // not-configured accounts never hit the network
    expect(fetchPartnerStats).not.toHaveBeenCalledWith(expect.objectContaining({ partner: undefined }));
  });

  // Defence in depth for a duplicate that predates @@unique([externalPartnerKey]): two accounts on
  // one complex would double both the aggregate row and the flattened payment detail, since
  // paymentsCount/paymentsAmount are plain sums. The constraint makes a real duplicate row
  // uninsertable now, so the second claim is injected at the query boundary — see
  // src/test/duplicate-partner-db.ts. Same dedup approach as company-analytics.ts / overview.ts.
  it("counts a partner ONCE when two accounts hold the same externalPartnerKey", async () => {
    const slug = `r-dupe-${Date.now()}-${Math.random()}`;
    const { u, user } = await mkAdmin();
    const partnerKey = `${slug}-shared`;
    await makeAccount(u.id, "Account A", partnerKey);
    const b = await makeAccount(u.id, "Account B");
    const db = dbWithPhantomPartnerKey(b.id, partnerKey);

    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner, page }) =>
      makePartnerStats({
        partner,
        total_payments_count: 2,
        total_payments_amount: 100,
        payments_page: page ?? 1,
        payments_page_count: 1,
        payments_total_count: 2,
        payments: [makePartnerPayment({ id: `pay-${partner}` })],
      }),
    );

    const r = await getReport(db, user, { range, label: "July 2026" });

    // Isolate this report's own paginated calls from the page-less calls made by
    // getDashboardStats' internal getCompanyAnalytics fan-out (which already dedups on its own —
    // see company-analytics.test.ts). Only one account should ever be fetched, not two.
    const pagedCalls = vi
      .mocked(fetchPartnerStats)
      .mock.calls.map((call) => call[0] as { page?: number })
      .filter((a) => a.page !== undefined);
    expect(pagedCalls).toHaveLength(1);

    // Every account is still a row (shape preserved) — the loser shows 0, not hidden, and the
    // totals across both rows reflect ONE partner's figures, not two.
    expect(r.partnerRows).toHaveLength(2);
    expect(r.partnerRows.reduce((sum, row) => sum + row.paymentsAmount, 0)).toBe(100);
    expect(r.partnerRows.reduce((sum, row) => sum + row.paymentsCount, 0)).toBe(2);
    expect(r.payments).toHaveLength(1);

    // The loser is reported rather than silently dropped, so the CSV export stays honest.
    const dupeStatus = r.accountStatuses.find((s) => s.reason === "duplicate_partner");
    expect(dupeStatus).toBeDefined();
    expect(r.accountStatuses.filter((s) => s.status === "ok")).toHaveLength(1);

    const csv = toCsv(r);
    expect(csv).toContain("Skipped accounts");
    expect(csv).toContain(`${dupeStatus!.accountName},duplicate partner`);
  });

  it("PARTNER scope rejects another tenant's account", async () => {
    const A = await setup("r2", { configured: true });
    const B = await setup("r3", { configured: true });
    await expect(
      getReport(testPrisma, B.user, { range, label: "x", accountId: A.acc.id }),
    ).rejects.toThrow();
  });

  it("ALL scope only reports accounts in the caller's scope (own team; never a sibling team's)", async () => {
    const { team, u, user } = await mkAdmin();
    const sibling = await makeTeam({ companyId: team.companyId });
    const siblingAdmin = await makeUser("COMPANY_ADMIN", sibling);
    const mine = await makeAccount(u.id, "Mine", "rscope-mine");
    const foreign = await makeAccount(siblingAdmin.id, "Foreign", "rscope-foreign");
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) =>
      makePartnerStats({ partner, total_payments_count: 1, total_payments_amount: 5 }),
    );

    const r = await getReport(testPrisma, user, { range, label: "x" });
    const ids = r.accountStatuses.map((s) => s.accountId);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(foreign.id);
    expect(fetchPartnerStats).not.toHaveBeenCalledWith(expect.objectContaining({ partner: "rscope-foreign" }));
  });
});
