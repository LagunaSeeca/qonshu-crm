import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import {
  addSettlementEntry,
  updateSettlementEntry,
  deleteSettlementEntry,
  getAccountSettlement,
  listCompanySettlements,
  setCollectionMode,
  SelfCollectingError,
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

// A second (third, fourth) building inside an existing tenant, with its own confirmed partner
// link so it can have a Collected of its own. `mode` is the whole point for the SELF cases.
function makeAccount(
  c: { id: string },
  team: { id: string },
  accountManagerId: string,
  name: string,
  partner: string,
  mode: "QONSHU" | "SELF" = "QONSHU",
) {
  return testPrisma.account.create({
    data: {
      companyId: c.id, teamId: team.id, buildingKey: buildingKey(name), name,
      accountManagerId, collectionMode: mode, ...confirmedPartnerLink(partner),
    },
  });
}

// Writes bypass the service where the test is not about the write gate: addSettlementEntry needs
// write_settlements (SUPER_ADMIN only), and most cases below are about arithmetic or reads.
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

  // The upstream filters on inclusive CALENDAR DATES, and every period on this path is a BAKU
  // boundary, so the instants below are Baku March: 1 March 00:00 Baku is 28 Feb 20:00Z, and
  // 31 March 23:59:59.999 Baku is 31 March 19:59:59.999Z.
  //
  // REGRESSION: this used to pass UTC instants and `isoDate` was a plain `toISOString()`. Once the
  // page started resolving Baku periods, a Baku `from` of 2026-10-31T20:00Z was sent as
  // "2026-10-31" and the upstream folded 31 OCTOBER's card payments into November's Collected —
  // inflating Owed by that amount and counting the same money in two months.
  it("the upstream is asked for the period's BAKU calendar bounds, not its UTC ones", async () => {
    const { acc, adminUser, partnerName } = await setup("s-bounds");
    cardByPartner.set(partnerName, 1);
    await getAccountSettlement(testPrisma, adminUser, acc.id, {
      from: new Date("2026-02-28T20:00:00.000Z"),
      to: new Date("2026-03-31T19:59:59.999Z"),
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
    // CHANGED ON PURPOSE: Collected is now OMITTED (not 0) whenever status !== "ok", so an
    // unreachable/unasked upstream cannot be rendered as a money figure.
    expect(s.collected).toBeUndefined();
    expect(s.remaining).toBeUndefined();
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
    // CHANGED ON PURPOSE: a failed fetch omits Collected (and `remaining`/`owed`) instead of
    // reporting 0 / -Transferred, which read as a real balance.
    expect(s.collected).toBeUndefined();
    expect(s.remaining).toBeUndefined();
    expect(s.owed).toBeUndefined();
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
    // The failing account contributes no Collected at all (not a 0), and the totals now SAY so
    // instead of presenting a 1-of-2 sum as the company's position.
    expect(s.rows.find((r) => r.accountId === bad.id)?.collected).toBeUndefined();
    expect(s.totals.partial).toBe(true);
    expect(s.totals.degradedAccountIds).toEqual([bad.id]);
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
    // CHANGED ON PURPOSE: `totals` carries the degraded-data flags now (both empty here — every
    // account answered), so the exact-shape assertion has to list them.
    expect(sumA.totals).toEqual({
      collected: 1000, transferred: 250, remaining: 750, owed: 750,
      // Both accounts here are QONSHU, so the self-collecting base is 0 — not absent. An
      // exact-shape assertion is the point of this test: a new total must be declared here.
      selfCollected: 0,
      partial: false, degradedAccountIds: [],
    });

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

  // `write_settlements` is ["SUPER_ADMIN"] — an explicit product rule: "only superadmin should be
  // able to add settlements transfers". A transfer row moves `remaining`/`owed` directly, i.e.
  // what Qonshu owes a partner, so neither a MEMBER nor a team admin may amend one; a team admin
  // READS settlements (see the read gate above) but cannot write.
  //
  // This capability WAS once widened to COMPANY_ADMIN, because a team admin got a 403 from a
  // transfer control the UI still rendered. The 403 was correct and the UI was the bug (the
  // controls now derive from can(user, "write_settlements"), so they are hidden). If this test is
  // ever failing again, check the product rule before widening the matrix.
  it("WRITES require write_settlements: only the SUPER_ADMIN may write; MEMBER and team admin are Forbidden", async () => {
    const { c, acc, adminUser, memberUser, saUser } = await setup("s-gate-write");
    const seeded = await seedTransfer(c.id, acc.id, saUser.id, 10, inPeriod);

    for (const refused of [memberUser, adminUser]) {
      await expect(
        addSettlementEntry(testPrisma, refused, acc.id, { amount: 5, method: "CASH", occurredAt: inPeriod }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        updateSettlementEntry(testPrisma, refused, seeded.id, { amount: 5 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(deleteSettlementEntry(testPrisma, refused, seeded.id)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Neither of them created, changed or removed anything.
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(1);
    expect(Number((await testPrisma.settlementEntry.findUniqueOrThrow({ where: { id: seeded.id } })).amount)).toBe(10);

    // The owner's writes all land, which is what makes the refusals above a gate rather than a
    // broken code path.
    const added = await addSettlementEntry(testPrisma, saUser, acc.id, {
      amount: 5, method: "CASH", occurredAt: inPeriod,
    });
    await updateSettlementEntry(testPrisma, saUser, seeded.id, { amount: 7 });
    expect(Number((await testPrisma.settlementEntry.findUniqueOrThrow({ where: { id: seeded.id } })).amount)).toBe(7);
    await deleteSettlementEntry(testPrisma, saUser, added.id);
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(1);
  });

  // The caller here must be a role the gate REFUSES, otherwise the test proves nothing. With
  // write_settlements = ["SUPER_ADMIN"] both a MEMBER and a team admin are refused on ROLE before
  // the scope check runs; a MEMBER is used because its refusal has to be indistinguishable
  // between a real id in another tenant and an id that does not exist at all. The cross-team
  // SCOPE check (a refused role never reaches it) is covered in team-isolation.test.ts with a
  // SUPER_ADMIN-shaped caller.
  it("the write gate fires before the scope check, so a wrong-role caller is not an id oracle", async () => {
    const A = await setup("s-oracle-a");
    const B = await setup("s-oracle-b");
    const entry = await seedTransfer(A.c.id, A.acc.id, A.saUser.id, 10, inPeriod);
    // B's member asking about A's entry, and about an id that does not exist, get the SAME answer.
    await expect(deleteSettlementEntry(testPrisma, B.memberUser, entry.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(deleteSettlementEntry(testPrisma, B.memberUser, "does-not-exist")).rejects.toBeInstanceOf(ForbiddenError);
    // ...and A's entry is untouched.
    expect(await testPrisma.settlementEntry.count({ where: { id: entry.id } })).toBe(1);
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

  // --- self-collecting buildings -----------------------------------------------------------

  it("a SELF account keeps Collected but has NO remaining/owed, and is in none of the four totals", async () => {
    const { c, acc, team, adminUser, saUser, partnerName } = await setup("s-self-totals");
    cardByPartner.set(partnerName, 1000);
    await seedTransfer(c.id, acc.id, saUser.id, 250, inPeriod);
    // A building that collects its own residents' money. It has a transfer row of its own
    // (historic), which must NOT be folded into the company's transferred total either.
    const selfAcc = await makeAccount(c, team, adminUser.id, "Zelf Tower", "s-self-totals-self", "SELF");
    cardByPartner.set("s-self-totals-self", 400);
    await seedTransfer(c.id, selfAcc.id, saUser.id, 100, inPeriod);

    const s = await listCompanySettlements(testPrisma, adminUser);
    const selfRow = s.rows.find((r) => r.accountId === selfAcc.id)!;
    expect(selfRow.collectionMode).toBe("SELF");
    expect(selfRow.collected).toBe(400); // the service-fee base is still owed to Qonshu
    expect(selfRow.remaining).toBeUndefined();
    expect(selfRow.owed).toBeUndefined();
    expect(s.rows.find((r) => r.accountId === acc.id)!.collectionMode).toBe("QONSHU");

    // THE REGRESSION: the old `r.collected !== undefined` filter admitted this row and then read
    // its missing `remaining`, so every total came out NaN. Assert the real numbers, and assert
    // they are numbers.
    expect(s.totals).toEqual({
      collected: 1000,
      transferred: 250,
      remaining: 750,
      owed: 750,
      selfCollected: 400,
      partial: false,
      degradedAccountIds: [],
    });
    for (const n of [s.totals.collected, s.totals.transferred, s.totals.remaining, s.totals.owed, s.totals.selfCollected]) {
      expect(Number.isNaN(n)).toBe(false);
    }
  });

  it("selfCollected sums only the SELF rows whose upstream actually answered", async () => {
    const { c, acc, team, adminUser, partnerName } = await setup("s-self-sum");
    cardByPartner.set(partnerName, 100);
    const good = await makeAccount(c, team, adminUser.id, "Self Good", "s-self-sum-good", "SELF");
    const bad = await makeAccount(c, team, adminUser.id, "Self Bad", "s-self-sum-bad", "SELF");
    cardByPartner.set("s-self-sum-good", 300);
    cardByPartner.set("s-self-sum-bad", 9999); // never arrives
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === "s-self-sum-bad") throw new PartnerApiUnavailableError();
      return makePartnerStats({ partner, amount_by_card: cardByPartner.get(partner) ?? 0, total_payments_amount: 999_999 });
    });

    const s = await listCompanySettlements(testPrisma, adminUser);
    expect(s.totals.selfCollected).toBe(300); // not 300 + 9999, and not 300 + 0
    expect(s.totals.collected).toBe(100); // the QONSHU account only
    expect(s.rows.find((r) => r.accountId === good.id)!.collected).toBe(300);
    expect(s.rows.find((r) => r.accountId === bad.id)!.collected).toBeUndefined();
    expect(s.totals.partial).toBe(true);
    expect(s.totals.degradedAccountIds).toEqual([bad.id]);
    expect(s.rows.find((r) => r.accountId === acc.id)!.collected).toBe(100);
  });

  it("a transfer against a SELF account is refused, and the transfers it already had still list", async () => {
    const { c, acc, adminUser, saUser, partnerName } = await setup("s-self-transfer");
    cardByPartner.set(partnerName, 500);
    // Recorded while the building was still QONSHU - real money that really moved.
    await seedTransfer(c.id, acc.id, saUser.id, 200, inPeriod);
    await setCollectionMode(testPrisma, saUser, acc.id, "SELF");

    await expect(
      addSettlementEntry(testPrisma, saUser, acc.id, { amount: 10, method: "CASH", occurredAt: inPeriod }),
    ).rejects.toBeInstanceOf(SelfCollectingError);
    // Machine-readable, so the UI explains the state instead of printing a parsed sentence.
    await expect(
      addSettlementEntry(testPrisma, saUser, acc.id, { amount: 10, method: "CASH", occurredAt: inPeriod }),
    ).rejects.toMatchObject({ reason: "self_collecting" });
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(1);

    const s = await getAccountSettlement(testPrisma, adminUser, acc.id);
    expect(s.collectionMode).toBe("SELF");
    expect(s.transfers).toHaveLength(1);
    expect(s.transferred).toBe(200);
    expect(s.transferredByMethod).toEqual({ CASH: 200, BANK_TRANSFER: 0, MANUAL: 0 });
    expect(s.collected).toBe(500);
    expect(s.remaining).toBeUndefined();
    expect(s.owed).toBeUndefined();
  });

  // --- setCollectionMode -------------------------------------------------------------------

  it("setCollectionMode is SUPER_ADMIN only: team admin, member, onboarding and partner are refused", async () => {
    const { acc, team, adminUser, memberUser, saUser } = await setup("s-mode-gate");
    const onboarder = su(await makeUser("ONBOARDING", team));
    const partner = su(await makeUser("PARTNER_VIEWER", team, { accountId: acc.id }));

    for (const refused of [adminUser, memberUser, onboarder, partner]) {
      await expect(setCollectionMode(testPrisma, refused, acc.id, "SELF")).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Nothing moved: the flag decides whether Qonshu owes this building anything at all.
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).collectionMode).toBe("QONSHU");

    // ...and the owner's write does land, so the refusals above are a gate, not a broken path.
    expect(await setCollectionMode(testPrisma, saUser, acc.id, "SELF")).toEqual({ id: acc.id, collectionMode: "SELF" });
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).collectionMode).toBe("SELF");
    expect(await setCollectionMode(testPrisma, saUser, acc.id, "QONSHU")).toEqual({ id: acc.id, collectionMode: "QONSHU" });
  });

  it("setCollectionMode gives the SAME 404 for another tenant's account and for an id that does not exist", async () => {
    const A = await setup("s-mode-404-a");
    const B = await setup("s-mode-404-b");
    // A SUPER_ADMIN acting INSIDE a company context (the shape scope.ts sanctions). A teamless
    // super admin is above every company by design, so it is not the caller that can be fenced.
    const scoped: SessionUser = { ...A.saUser, companyId: A.c.id };

    const outside = await setCollectionMode(testPrisma, scoped, B.acc.id, "SELF").catch((e) => e);
    const missing = await setCollectionMode(testPrisma, scoped, "no-such-account", "SELF").catch((e) => e);
    expect(outside).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    // Identical answers: the pair must not be an existence oracle.
    expect(outside.constructor).toBe(missing.constructor);
    expect(outside.message).toBe(missing.message);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: B.acc.id } })).collectionMode).toBe("QONSHU");
  });

  // --- filters ------------------------------------------------------------------------------

  it("the q filter cannot widen scope: it never reaches another tenant's building", async () => {
    const A = await setup("s-q-a");
    const B = await setup("s-q-b");
    const mine = await makeAccount(A.c, A.team, A.adminUser.id, "Zebra House", "s-q-a-zebra");
    cardByPartner.set("s-q-a-zebra", 42);

    // A team admin in the other tenant searching for it by name gets nothing at all - the filter
    // is ANDed INSIDE the scope, never spread over it.
    const other = await listCompanySettlements(testPrisma, B.adminUser, undefined, { q: "Zebra" });
    expect(other.rows).toEqual([]);
    expect(other.totals.collected).toBe(0);

    // A MEMBER never gets as far as a filter: view_settlements excludes the role outright.
    await expect(
      listCompanySettlements(testPrisma, B.memberUser, undefined, { q: "Zebra" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      listCompanySettlements(testPrisma, A.memberUser, undefined, { q: "Zebra" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // A partner login is confined to its ONE account, filter or no filter.
    const partner = su(await makeUser("PARTNER_VIEWER", A.team, { accountId: A.acc.id }));
    expect((await listCompanySettlements(testPrisma, partner, undefined, { q: "Zebra" })).rows).toEqual([]);

    // The owning tenant does find it, which is what makes the two empties above a scope result.
    const ownTenant = await listCompanySettlements(testPrisma, A.adminUser, undefined, { q: "zebra" });
    expect(ownTenant.rows.map((r) => r.accountId)).toEqual([mine.id]); // and case-insensitive
  });

  it("filters are applied to the ACCOUNT query, so the upstream is not asked about filtered-out buildings", async () => {
    const { c, acc, team, adminUser, partnerName } = await setup("s-filter-traffic");
    cardByPartner.set(partnerName, 10);
    const other = await makeAccount(c, team, adminUser.id, "Other Bldg", "s-filter-traffic-other");
    cardByPartner.set("s-filter-traffic-other", 20);

    const s = await listCompanySettlements(testPrisma, adminUser, undefined, { accountId: other.id });
    expect(s.rows.map((r) => r.accountId)).toEqual([other.id]);
    expect(s.totals.collected).toBe(20);
    expect(fetchPartnerStats).toHaveBeenCalledTimes(1);
    expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ partner: "s-filter-traffic-other" }));
    expect(acc.id).not.toBe(other.id);
  });

  it("each status bucket: owed, settled, and the rows that belong to neither", async () => {
    const { c, acc, team, adminUser, saUser, partnerName } = await setup("s-status");
    cardByPartner.set(partnerName, 1000); // "Partner": owed 1000

    const settled = await makeAccount(c, team, adminUser.id, "Settled Bldg", "s-status-settled");
    cardByPartner.set("s-status-settled", 300);
    await seedTransfer(c.id, settled.id, saUser.id, 300, inPeriod); // remaining 0 -> settled

    const over = await makeAccount(c, team, adminUser.id, "Over Bldg", "s-status-over");
    cardByPartner.set("s-status-over", 100);
    await seedTransfer(c.id, over.id, saUser.id, 250, inPeriod); // remaining -150 -> settled

    const dark = await makeAccount(c, team, adminUser.id, "Dark Bldg", "s-status-dark");
    const selfAcc = await makeAccount(c, team, adminUser.id, "Self Bldg", "s-status-self", "SELF");
    cardByPartner.set("s-status-self", 50);
    vi.mocked(fetchPartnerStats).mockImplementation(async ({ partner }) => {
      if (partner === "s-status-dark") throw new PartnerApiUnavailableError();
      return makePartnerStats({ partner, amount_by_card: cardByPartner.get(partner) ?? 0, total_payments_amount: 999_999 });
    });

    const all = await listCompanySettlements(testPrisma, adminUser);
    expect(all.rows).toHaveLength(5);

    const owed = await listCompanySettlements(testPrisma, adminUser, undefined, { status: "owed" });
    expect(owed.rows.map((r) => r.accountId)).toEqual([acc.id]);
    // Totals reflect the FILTERED rows — but `partial`/`degradedAccountIds` DO NOT.
    //
    // REGRESSION: they were computed off the filtered rows, so applying a status filter made
    // `partial` go false. A row with an unknown Collected has no `remaining`, so the filter drops
    // it — and with it the only signal that the totals are incomplete. The page showed "covers
    // only the accounts that responded" unfiltered, then presented a knowingly short cash
    // position as the company's complete one the moment you clicked "Owed".
    expect(owed.totals).toEqual({
      collected: 1000, transferred: 0, remaining: 1000, owed: 1000,
      selfCollected: 0, partial: true, degradedAccountIds: [dark.id],
    });

    const done = await listCompanySettlements(testPrisma, adminUser, undefined, { status: "settled" });
    expect(done.rows.map((r) => r.accountId).sort()).toEqual([over.id, settled.id].sort());
    expect(done.totals.collected).toBe(400);
    expect(done.totals.transferred).toBe(550);
    expect(done.totals.remaining).toBe(-150);
    // The incompleteness disclosure survives this filter too.
    expect(done.totals.partial).toBe(true);
    expect(done.totals.degradedAccountIds).toEqual([dark.id]);

    // An unknown Collected and a SELF row have no `remaining` to bucket, so they appear under
    // neither value and only show up when no status filter is set.
    for (const bucket of ["owed", "settled"] as const) {
      const s = await listCompanySettlements(testPrisma, adminUser, undefined, { status: bucket });
      expect(s.rows.map((r) => r.accountId)).not.toContain(dark.id);
      expect(s.rows.map((r) => r.accountId)).not.toContain(selfAcc.id);
    }
    expect(all.rows.map((r) => r.accountId)).toEqual(expect.arrayContaining([dark.id, selfAcc.id]));
    expect(all.totals.selfCollected).toBe(50);
  });

  it("PINNED: the roll-up's Collected is amount_by_card alone, for QONSHU and SELF rows alike", async () => {
    const { c, acc, team, adminUser, partnerName } = await setup("s-card-pin");
    const selfAcc = await makeAccount(c, team, adminUser.id, "Zelf Pin", "s-card-pin-self", "SELF");
    cardByPartner.set(partnerName, 1200);
    cardByPartner.set("s-card-pin-self", 90);

    const s = await listCompanySettlements(testPrisma, adminUser);
    // The mock returns total_payments_amount 999_999, amount_by_cash 777_777 and
    // amount_by_manual 555_555 on every call. If any of those is ever substituted for (or added
    // to) amount_by_card, these numbers move. DO NOT "fix" this test by updating the figures:
    // cash the building took directly never passed through Qonshu, so it is not ours to settle.
    expect(s.rows.find((r) => r.accountId === acc.id)!.collected).toBe(1200);
    expect(s.rows.find((r) => r.accountId === selfAcc.id)!.collected).toBe(90);
    expect(s.totals.collected).toBe(1200);
    expect(s.totals.selfCollected).toBe(90);
    // And it is read off the AGGREGATE, with no payment rows dragged across the wire - summing
    // `method === "CARD"` payments out of a paged list would silently truncate a busy building.
    expect(fetchPartnerStats).toHaveBeenCalledWith(expect.objectContaining({ page: 1, pageSize: 1 }));
  });

  // --- period resolution -------------------------------------------------------------------

  describe("resolveSettlementPeriod", () => {
    // BAKU months (UTC+4), not UTC ones — the business is in Baku and the user chose Baku billing
    // periods. Every period on this path must share one timezone: the page resolves Baku presets,
    // so leaving these two helpers on UTC meant the same "this month" disagreed between the page,
    // the API and the dashboard, and sent the wrong calendar date upstream.
    it("defaults to the whole current BAKU month", () => {
      const p = resolveSettlementPeriod({}, new Date("2026-02-17T09:30:00.000Z"));
      // 1 Feb 00:00 Baku = 31 Jan 20:00Z; 28 Feb 23:59:59.999 Baku = 28 Feb 19:59:59.999Z.
      expect(p.from.toISOString()).toBe("2026-01-31T20:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-02-28T19:59:59.999Z"); // 2026 is not a leap year
    });

    it("takes inclusive YYYY-MM-DD bounds as BAKU days", () => {
      const p = resolveSettlementPeriod({ from: "2026-03-01", to: "2026-03-31" });
      expect(p.from.toISOString()).toBe("2026-02-28T20:00:00.000Z");
      expect(p.to.toISOString()).toBe("2026-03-31T19:59:59.999Z");
    });

    it("round-trips through isoDate: a Baku period names the Baku dates upstream", () => {
      // The two must compose — this is the pairing that was broken. Resolving "March" and then
      // formatting it for the partner API must give back exactly March's calendar dates.
      const p = resolveSettlementPeriod({}, new Date("2026-03-17T09:30:00.000Z"));
      expect(p.from.toISOString().slice(0, 10)).toBe("2026-02-28"); // the raw UTC date is NOT March
      expect(new Date(p.from.getTime() + 4 * 3_600_000).toISOString().slice(0, 10)).toBe("2026-03-01");
      expect(new Date(p.to.getTime() + 4 * 3_600_000).toISOString().slice(0, 10)).toBe("2026-03-31");
    });

    it("throws rather than widening on a bad or inverted pair", () => {
      expect(() => resolveSettlementPeriod({ from: "nonsense", to: "2026-03-31" })).toThrow(RangeError);
      expect(() => resolveSettlementPeriod({ from: "2026-04-01", to: "2026-03-31" })).toThrow(RangeError);
    });
  });
});
