import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getAccountAnalytics, listAccountPayments } from "./partner-analytics";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import { makePartnerStats, makePartnerPayment } from "@/test/partner-stats-fixture";
import { NotFoundError } from "@/lib/auth/guards";
import type { SessionUser } from "@/lib/auth/guards";

// Single-account analytics is now LIVE-only: every KPI/breakdown comes straight from the
// external Partner API for the request's range, nothing persisted or cached. Mock the client
// module so these tests never hit the network.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "test-shared-partner-api-key";
const range = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T23:59:59Z") };

// "Configured" now means only a partner NAME — the account goes live off the shared
// PARTNER_API_KEY env var (set in beforeEach below); there is no per-account key entry anymore.
async function seed(slug: string, opts?: { configured?: boolean }) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "MEMBER" },
  });
  const configured = opts?.configured ?? true;
  const acc = await testPrisma.account.create({
    data: {
      companyId: c.id,
      name: "P",
      accountManagerId: u.id,
      ...(configured ? { externalPartnerKey: `${slug}-partner` } : {}),
    },
  });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, acc, user };
}

describe("partner analytics (live)", () => {
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

  describe("getAccountAnalytics", () => {
    it("maps KPIs, installs, and all 5 category breakdowns from the live stats response", async () => {
      const { acc, user } = await seed("pa-map");
      vi.mocked(fetchPartnerStats).mockResolvedValue(
        makePartnerStats({
          total_users: 12,
          active_users: 9,
          total_debt: 456.7,
          total_installations: 8,
          ios_installations: 5,
          android_installations: 3,
          logged_in_users: 6,
          total_payments_count: 4,
          total_payments_amount: 900,
          amount_by_card: 500,
          amount_by_manual: 300,
          amount_by_cash: 100,
          utility_payments_count: 2,
          utility_payments_amount: 300,
          apartment_payments_amount: 200,
          parking_payments_amount: 150,
          property_payments_amount: 100,
          office_payments_amount: 150,
        }),
      );

      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);

      expect(a.status).toBe("ok");
      expect(a.kpis.activeUsers).toBe(9);
      expect(a.kpis.totalUsers).toBe(12);
      expect(a.kpis.totalDebt).toBe(456.7); // from total_debt
      expect(a.kpis.paymentsCount).toBe(4);
      expect(a.kpis.paymentsAmount).toBe(900);
      expect(a.kpis.utilityCount).toBe(2);
      expect(a.kpis.utilityAmount).toBe(300);

      expect(a.installs.total).toBe(8); // from total_installations
      expect(a.installs.ios).toBe(5);
      expect(a.installs.android).toBe(3);
      expect(a.installs.activated).toBe(6); // from logged_in_users
      expect(a.installs.activationRate).toBeCloseTo((6 / 8) * 100, 1);

      expect(a.byMethod).toEqual([
        { method: "CARD", amount: 500 },
        { method: "MANUAL", amount: 300 },
        { method: "CASH", amount: 100 },
      ]);
      expect(a.byCategory.map((cc) => cc.category)).toEqual([
        "APARTMENT", "PARKING", "PROPERTY", "OFFICE", "UTILITY",
      ]);
      expect(a.byCategory.find((cc) => cc.category === "APARTMENT")!.amount).toBe(200);
      expect(a.byCategory.find((cc) => cc.category === "PARKING")!.amount).toBe(150);
      expect(a.byCategory.find((cc) => cc.category === "PROPERTY")!.amount).toBe(100);
      expect(a.byCategory.find((cc) => cc.category === "OFFICE")!.amount).toBe(150);
      expect(a.byCategory.find((cc) => cc.category === "UTILITY")!.amount).toBe(300);

      expect(fetchPartnerStats).toHaveBeenCalledWith(
        expect.objectContaining({
          partner: "pa-map-partner",
          dateFrom: "2026-06-01",
          dateTo: "2026-06-30",
          page: 1,
          pageSize: 1,
        }),
      );
    });

    it("status 'not-configured' when the account has no partner key / API key, and never calls the API", async () => {
      const { acc, user } = await seed("pa-noconf", { configured: false });
      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
      expect(a.status).toBe("not-configured");
      expect(a.kpis.paymentsAmount).toBe(0);
      expect(a.byMethod).toEqual([]);
      expect(fetchPartnerStats).not.toHaveBeenCalled();
    });

    it("status 'invalid-key' when upstream rejects the API key (401)", async () => {
      const { acc, user } = await seed("pa-badkey");
      vi.mocked(fetchPartnerStats).mockRejectedValue(new InvalidApiKeyError());
      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
      expect(a.status).toBe("invalid-key");
    });

    it("status 'unknown-partner' when upstream doesn't recognize the partner (404)", async () => {
      const { acc, user } = await seed("pa-unknown");
      vi.mocked(fetchPartnerStats).mockRejectedValue(new UnknownPartnerError());
      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
      expect(a.status).toBe("unknown-partner");
    });

    it("status 'unavailable' on network failure / 5xx", async () => {
      const { acc, user } = await seed("pa-down");
      vi.mocked(fetchPartnerStats).mockRejectedValue(new PartnerApiUnavailableError());
      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
      expect(a.status).toBe("unavailable");
    });

    it("status 'unavailable' when the stored key fails to decrypt (tampered ciphertext), without calling the API", async () => {
      const { c, user } = await seed("pa-tamper", { configured: false });
      const acc = await testPrisma.account.create({
        data: {
          companyId: c.id,
          name: "Tampered",
          accountManagerId: user.id,
          externalPartnerKey: "tampered-partner",
          externalApiKeyEnc: "not-a-valid-ciphertext",
        },
      });
      const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
      expect(a.status).toBe("unavailable");
      expect(fetchPartnerStats).not.toHaveBeenCalled();
    });

    it("throws NotFoundError for a foreign account", async () => {
      const { acc } = await seed("pa-x1");
      const other = await seed("pa-x2");
      await expect(getAccountAnalytics(testPrisma, other.user, acc.id, range)).rejects.toThrow(NotFoundError);
      expect(fetchPartnerStats).not.toHaveBeenCalled();
    });
  });

  describe("listAccountPayments", () => {
    it("passes through page/pageSize and maps rows + pagination from the live response", async () => {
      const { acc, user } = await seed("pa-pg");
      vi.mocked(fetchPartnerStats).mockResolvedValue(
        makePartnerStats({
          payments: [
            makePartnerPayment({ id: "pay1", user_name: "Jane", amount: 42, method: "CARD", category: "UTILITY", date: "2026-06-05" }),
          ],
          payments_page: 2,
          payments_page_count: 5,
          payments_total_count: 41,
        }),
      );

      const res = await listAccountPayments(testPrisma, user, acc.id, { ...range, page: 2, pageSize: 10 });

      expect(res.status).toBe("ok");
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]).toEqual({
        id: "pay1", occurredAt: "2026-06-05", amount: 42, method: "CARD", category: "UTILITY", userName: "Jane",
      });
      expect(res.total).toBe(41);
      expect(res.page).toBe(2);
      expect(res.pageCount).toBe(5);
      expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 10 }));
    });

    it("returns an empty not-configured page for a cross-tenant account without calling the API", async () => {
      const { acc } = await seed("pa-pg-x1");
      const other = await seed("pa-pg-x2");

      const res = await listAccountPayments(testPrisma, other.user, acc.id, { ...range });

      expect(res.status).toBe("not-configured");
      expect(res.rows).toEqual([]);
      expect(res.total).toBe(0);
      expect(fetchPartnerStats).not.toHaveBeenCalled();
    });

    it("maps upstream failure statuses the same way as getAccountAnalytics", async () => {
      const { acc, user } = await seed("pa-pg-fail");
      vi.mocked(fetchPartnerStats).mockRejectedValue(new UnknownPartnerError());

      const res = await listAccountPayments(testPrisma, user, acc.id, { ...range });

      expect(res.status).toBe("unknown-partner");
      expect(res.rows).toEqual([]);
    });
  });
});
