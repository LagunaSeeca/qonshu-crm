import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import {
  addSettlementEntry,
  updateSettlementEntry,
  deleteSettlementEntry,
  getAccountSettlement,
  listCompanySettlements,
  currentSettlementPeriod,
  resolveSettlementPeriod,
} from "./settlements";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { makePartnerStats } from "@/test/partner-stats-fixture";
import { InvalidApiKeyError, PartnerApiUnavailableError, UnknownPartnerError } from "@/lib/partner-api/errors";

// Collected is a LIVE read of the partner API, so the external client is mocked here exactly as
// it is in company-analytics.test.ts / partner-analytics.test.ts. Nothing in this file should
// ever reach the network.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerStats: vi.fn() }));

const SHARED_API_KEY = "test-shared-partner-api-key";
const cardByPartner = new Map<string, number>();

// A date inside the CURRENT settlement period (the default), and one safely outside it.
const period = currentSettlementPeriod();
const inPeriod = new Date(period.from.getTime() + 60_000);
const beforePeriod = new Date(period.from.getTime() - 86_400_000);

async function setup(slug: string, opts: { linked?: boolean } = {}) {
  const team = await makeTeam({ name: slug });
  const c = { id: team.companyId };
  const admin = await makeUser("COMPANY_ADMIN", team);
  const member = await makeUser("MEMBER", team);
  // A SUPER_ADMIN has companyId null; getAccount resolves the account's own company for it, so
  // this is the real shape of the only role that may write settlements.
  const superAdmin = await makeUser("SUPER_ADMIN");
  const partnerName = `${slug}-partner`;
  const acc = await testPrisma.account.create({
    data: {
      companyId: c.id, teamId: team.id, buildingKey: buildingKey("Partner"), name: "Partner",
      accountManagerId: admin.id,
      ...(opts.linked === false ? {} : confirmedPartnerLink(partnerName)),
    },
  });
  return {
    c, acc, team, partnerName,
    adminUser: su(admin) as SessionUser,
    memberUser: su(member) as SessionUser,
    saUser: su(superAdmin) as SessionUser,
  };
}

// Writes bypass the service where the test is not about the write gate: addSettlementEntry is
// SUPER_ADMIN-only, and most cases below are about arithmetic or reads.
function seedTransfer(companyId: string, accountId: string, createdById: string, amount: number, occurredAt: Date, method: "CASH" | "BANK_TRANSFER" | "MANUAL" = "CASH") {
  return testPrisma.settlementEntry.create({
    data: { companyId, accountId, type: "TRANSFER", amount, method, occurredAt, createdById },
  });
}

describe("settlements", () => {
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = SHARED_API_KEY;
    cardByPartner.clear();
    vi.mocked(fetchPartnerStats).mockReset();
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) =>
      makePartnerStats({
        partner,
        amount_by_card: cardByPartner.get(partner) ?? 0,
        // Deliberately large and deliberately ignored: Collected must be amount_by_card alone.
        total_payments_amount: 999_999,
        amount_by_cash: 777_777,
        amount_by_manual: 555_555,
      }),
    );
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
  });
  afterAll(() => testPrisma.$disconnect());

  // --- the core rule ---------------------------------------------------------------------

  it("Collected is the partner API's amount_by_card, NOT total_payments_amount", async () => {
    const { acc, adminUser, partnerName } = await setup("s-card");
    cardByPartner.set(partnerName, 1200);
    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.status).toBe("ok");
    expect(s.collected).toBe(1200); // never 999_999, and never 1200 + cash + manual
    expect(s.remaining).toBe(1200);
  });

  it("Remaining = Collected - transfers in the SAME period; a transfer outside it is ignored", async () => {
    const { c, acc, adminUser, saUser, partnerName } = await setup("s-remaining");
    cardByPartner.set(partnerName, 1000);
    await seedTransfer(c.id, acc.id, saUser.id, 300, inPeriod);
    await seedTransfer(c.id, acc.id, saUser.id, 50, inPeriod, "BANK_TRANSFER");
    await seedTransfer(c.id, acc.id, saUser.id, 900, beforePeriod); // last period — not ours

    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.collected).toBe(1000);
    expect(s.transferred).toBe(350);
    expect(s.remaining).toBe(650);
    expect(s.transfers).toHaveLength(2);
    expect(s.transferredByMethod).toEqual({ CASH: 300, BANK_TRANSFER: 50, MANUAL: 0 });
  });

  it("period membership follows occurredAt, not createdAt", async () => {
    const { c, acc, adminUser, saUser, partnerName } = await setup("s-occurred");
    cardByPartner.set(partnerName, 500);
    // Created NOW (this row's createdAt is inside the current period) but back-dated to the
    // previous one: it must settle the month the money moved, not the month it was keyed in.
    await seedTransfer(c.id, acc.id, saUser.id, 500, beforePeriod);
    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.transferred).toBe(0);
    expect(s.remaining).toBe(500);

    // ...and it IS counted when the period is widened to include it.
    const wide = await getAccountSettlement(testPrisma, adminUser, acc.id, {
      from: beforePeriod, to: period.to,
    });
    expect(wide.transferred).toBe(500);
  });

  it("the live figure is never persisted: no COLLECTED row is written by a read", async () => {
    const { acc, adminUser, partnerName } = await setup("s-nopersist");
    cardByPartner.set(partnerName, 4200);
    await getAccountSettlement(testPrisma, adminUser, acc.id);
    await listCompanySettlements(testPrisma, adminUser);
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("a legacy COLLECTED row is ignored rather than added to the live card total", async () => {
    const { c, acc, adminUser, saUser, partnerName } = await setup("s-legacy");
    cardByPartner.set(partnerName, 100);
    await testPrisma.settlementEntry.create({
      data: { companyId: c.id, accountId: acc.id, type: "COLLECTED", amount: 9999, method: "CASH", occurredAt: inPeriod, createdById: saUser.id },
    });
    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.collected).toBe(100);
    expect(s.transferred).toBe(0);
    expect(s.transfers).toHaveLength(0);
  });

  it("the upstream is asked for exactly the period's calendar bounds", async () => {
    const { acc, adminUser, partnerName } = await setup("s-bounds");
    cardByPartner.set(partnerName, 1);
    await getAccountSettlement(testPrisma, adminUser, acc.id, {
      from: new Date("2026-03-01T00:00:00.000Z"),
      to: new Date("2026-03-31T23:59:59.999Z"),
    });
    expect(fetchPartnerStats).toHaveBeenCalledWith(
      expect.objectContaining({ partner: partnerName, dateFrom: "2026-03-01", dateTo: "2026-03-31" }),
    );
  });

  // --- upstream failure modes ------------------------------------------------------------

  it("an unlinked account never calls the upstream and reports not-configured", async () => {
    const { acc, adminUser } = await setup("s-unlinked", { linked: false });
    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.status).toBe("not-configured");
    expect(s.collected).toBe(0);
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("a PENDING (unconfirmed) partner link is treated exactly like no link", async () => {
    const { c, team, adminUser } = await setup("s-pending", { linked: false });
    const pending = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Pending Bldg"), name: "Pending Bldg",
        accountManagerId: adminUser.id, externalPartnerKey: "s-pending-unconfirmed",
      },
    });
    const s = await getAccountSettlement(testPrisma, adminUser, pending.id);
    expect(s.status).toBe("not-configured");
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidApiKeyError(), "invalid-key"],
    [new UnknownPartnerError(), "unknown-partner"],
    [new PartnerApiUnavailableError(), "unavailable"],
    [new Error("boom"), "unavailable"],
  ])("an upstream failure yields a status, not a throw (%#)", async (err, status) => {
    const { acc, adminUser } = await setup(`s-err-${status}-${Math.random().toString(36).slice(2, 7)}`);
    vi.mocked(fetchPartnerStats).mockRejectedValue(err);
    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.status).toBe(status);
    expect(s.collected).toBe(0);
  });

  it("one failing account does not sink the company roll-up", async () => {
    const { c, team, acc, adminUser, partnerName } = await setup("s-rollup");
    cardByPartner.set(partnerName, 600);
    const bad = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Bad Bldg"), name: "Bad Bldg",
        accountManagerId: adminUser.id, ...confirmedPartnerLink("s-rollup-bad"),
      },
    });
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === "s-rollup-bad") throw new InvalidApiKeyError();
      return makePartnerStats({ partner, amount_by_card: cardByPartner.get(partner) ?? 0 });
    });

    const s = await listCompanySettlements(testPrisma, adminUser);
    expect(s.rows).toHaveLength(2);
    expect(s.rows.find((r) => r.accountId === bad.id)?.status).toBe("invalid-key");
    expect(s.rows.find((r) => r.accountId === acc.id)?.status).toBe("ok");
    expect(s.totals.collected).toBe(600);
  });

  // --- the roll-up -----------------------------------------------------------------------

  it("company totals match the rows, and are tenant-isolated", async () => {
    const A = await setup("s-tenantA");
    cardByPartner.set(A.partnerName, 1000);
    await seedTransfer(A.c.id, A.acc.id, A.saUser.id, 250, inPeriod);
    const B = await setup("s-tenantB");
    cardByPartner.set(B.partnerName, 70);

    const sumA = await listCompanySettlements(testPrisma, A.adminUser);
    expect(sumA.rows).toHaveLength(1);
    expect(sumA.totals).toEqual({ collected: 1000, transferred: 250, remaining: 750, owed: 750 });

    const sumB = await listCompanySettlements(testPrisma, B.adminUser);
    expect(sumB.rows).toHaveLength(1);
    expect(sumB.totals.collected).toBe(70);
    expect(sumB.totals.transferred).toBe(0);

    await expect(getAccountSettlement(testPrisma, B.adminUser, A.acc.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the roll-up only counts transfers inside the period", async () => {
    const { c, acc, adminUser, saUser, partnerName } = await setup("s-rollup-period");
    cardByPartner.set(partnerName, 800);
    await seedTransfer(c.id, acc.id, saUser.id, 100, inPeriod);
    await seedTransfer(c.id, acc.id, saUser.id, 400, beforePeriod);
    const s = await listCompanySettlements(testPrisma, adminUser);
    expect(s.totals.transferred).toBe(100);
    expect(s.totals.remaining).toBe(700);
  });

  // --- the gates -------------------------------------------------------------------------

  it("READS require view_settlements: a MEMBER gets nothing, not an empty page", async () => {
    const { acc, memberUser, partnerName } = await setup("s-gate-read");
    cardByPartner.set(partnerName, 5000);
    await expect(listCompanySettlements(testPrisma, memberUser)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getAccountSettlement(testPrisma, memberUser, acc.id)).rejects.toBeInstanceOf(ForbiddenError);
    // And the refusal happens BEFORE any upstream call, so a member cannot even make us fetch.
    expect(fetchPartnerStats).not.toHaveBeenCalled();
  });

  it("WRITES require write_settlements: SUPER_ADMIN only — a COMPANY_ADMIN is Forbidden", async () => {
    const { c, acc, adminUser, memberUser, saUser } = await setup("s-gate-write");
    const seeded = await seedTransfer(c.id, acc.id, saUser.id, 10, inPeriod);

    for (const actor of [adminUser, memberUser]) {
      await expect(
        addSettlementEntry(testPrisma, actor, acc.id, { amount: 5, method: "CASH", occurredAt: inPeriod }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        updateSettlementEntry(testPrisma, actor, seeded.id, { amount: 5 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteSettlementEntry(testPrisma, actor, seeded.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Nothing was created, changed or removed by any of that.
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(1);
    expect(Number((await testPrisma.settlementEntry.findUniqueOrThrow({ where: { id: seeded.id } })).amount)).toBe(10);
  });

  it("the write gate fires before the scope check, so a wrong-role caller is not an id oracle", async () => {
    const A = await setup("s-oracle-a");
    const B = await setup("s-oracle-b");
    const entry = await seedTransfer(A.c.id, A.acc.id, A.saUser.id, 10, inPeriod);
    // B's admin asking about A's entry, and about an id that does not exist, get the SAME answer.
    await expect(deleteSettlementEntry(testPrisma, B.adminUser, entry.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSettlementEntry(testPrisma, B.adminUser, "does-not-exist")).rejects.toBeInstanceOf(ForbiddenError);
  });

  // --- the writes a SUPER_ADMIN may make ---------------------------------------------------

  it("a SUPER_ADMIN adds, amends and deletes a transfer, and Remaining follows", async () => {
    const { acc, adminUser, saUser, partnerName } = await setup("s-write-ok");
    cardByPartner.set(partnerName, 1000);

    const entry = await addSettlementEntry(testPrisma, saUser, acc.id, {
      amount: 400, method: "BANK_TRANSFER", occurredAt: inPeriod, note: "July payout",
    });
    expect(entry.type).toBe("TRANSFER"); // the only type a human can create
    expect((await getAccountSettlement(testPrisma, adminUser, acc.id)).remaining).toBe(600);

    await updateSettlementEntry(testPrisma, saUser, entry.id, { amount: 250 });
    expect((await getAccountSettlement(testPrisma, adminUser, acc.id)).remaining).toBe(750);

    // Moving it out of the period removes it from this period's arithmetic.
    await updateSettlementEntry(testPrisma, saUser, entry.id, { occurredAt: beforePeriod });
    expect((await getAccountSettlement(testPrisma, adminUser, acc.id)).transferred).toBe(0);

    await deleteSettlementEntry(testPrisma, saUser, entry.id);
    expect(await testPrisma.settlementEntry.count({ where: { id: entry.id } })).toBe(0);
  });

  it("a SUPER_ADMIN still cannot write against an account that does not exist", async () => {
    const { saUser } = await setup("s-write-ghost");
    await expect(
      addSettlementEntry(testPrisma, saUser, "no-such-account", { amount: 1, method: "CASH", occurredAt: inPeriod }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // --- period resolution -------------------------------------------------------------------

  describe("resolveSettlementPeriod", () => {
    it("defaults to the whole current UTC month", () => {
      const p = resolveSettlementPeriod({}, new Date("2026-02-17T09:30:00.000Z"));
      expect(p.from.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-02-28T23:59:59.999Z"); // 2026 is not a leap year
    });

    it("takes inclusive YYYY-MM-DD bounds", () => {
      const p = resolveSettlementPeriod({ from: "2026-03-01", to: "2026-03-31" });
      expect(p.from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-03-31T23:59:59.999Z");
    });

    it("throws rather than widening on a bad or inverted pair", () => {
      expect(() => resolveSettlementPeriod({ from: "nonsense", to: "2026-03-31" })).toThrow(RangeError);
      expect(() => resolveSettlementPeriod({ from: "2026-04-01", to: "2026-03-31" })).toThrow(RangeError);
    });
  });
});
