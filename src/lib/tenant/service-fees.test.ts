import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import {
  addServiceFee,
  updateServiceFee,
  deleteServiceFee,
  markFeePaid,
  markFeeUnpaid,
  getAccountServiceFees,
  listCompanyServiceFees,
  generateMonthlyFees,
  setServiceFeeRate,
} from "./service-fees";
import { sortServiceFeeRows, type SortableFeeRow } from "@/lib/service-fee-sort";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { ZodError } from "zod";

async function setup(slug: string) {
  const team = await makeTeam({ name: slug });
  const c = { id: team.companyId };
  const u = await makeUser("COMPANY_ADMIN", team);
  const acc = await testPrisma.account.create({ data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Partner"), name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = su(u);
  // The OWNER: pricing writes (creating a fee row, changing an amount) are SUPER_ADMIN-only. Wired
  // like the seeded owner: a company context, no team.
  const ownerRow = await testPrisma.user.create({
    data: { companyId: c.id, teamId: null, email: `${slug}-owner@test.local`, passwordHash: "x", name: "Owner", role: "SUPER_ADMIN" },
  });
  const owner: SessionUser = su(ownerRow);
  return { c, acc, user, team, owner };
}

describe("service-fees", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("computes totalBilled/totalPaid/totalOutstanding for an account", async () => {
    const { acc, user, owner } = await setup("sf1");
    const f1 = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });
    await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-06-01"), amount: "150" });
    await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-07-01"), amount: "200" });
    await markFeePaid(testPrisma, user, f1.id, { method: "CASH" });

    const s = await getAccountServiceFees(testPrisma, user, acc.id);
    expect(s.fees).toHaveLength(3);
    expect(s.totalBilled).toBe(450);
    expect(s.totalPaid).toBe(100);
    expect(s.totalOutstanding).toBe(350);
    // newest-first by periodMonth
    expect(s.fees[0].periodMonth.getUTCMonth()).toBe(6); // July (0-indexed)
  });

  it("normalizes periodMonth to the first of the month", async () => {
    const { acc, owner } = await setup("sf2");
    const fee = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-15T12:00:00Z"), amount: "100" });
    expect(fee.periodMonth.toISOString()).toBe(new Date("2026-05-01T00:00:00.000Z").toISOString());
  });

  it("rejects a duplicate account+month fee", async () => {
    const { acc, owner } = await setup("sf3");
    await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });
    await expect(addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-10"), amount: "999" })).rejects.toThrow();
  });

  it("markFeePaid sets PAID + paidAt + method; markFeeUnpaid reverses", async () => {
    const { acc, user, owner } = await setup("sf4");
    const fee = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });
    expect(fee.status).toBe("UNPAID");
    expect(fee.paidAt).toBeNull();

    const paid = await markFeePaid(testPrisma, user, fee.id, { method: "BANK_TRANSFER" });
    expect(paid.status).toBe("PAID");
    expect(paid.paidAt).not.toBeNull();
    expect(paid.method).toBe("BANK_TRANSFER");

    const unpaid = await markFeeUnpaid(testPrisma, user, fee.id);
    expect(unpaid.status).toBe("UNPAID");
    expect(unpaid.paidAt).toBeNull();
    expect(unpaid.method).toBeNull();
  });

  it("updateServiceFee edits fields; deleteServiceFee removes it", async () => {
    const { acc, user, owner } = await setup("sf5");
    const fee = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100", note: "orig" });
    const updated = await updateServiceFee(testPrisma, owner, fee.id, { amount: "250", note: "updated" });
    expect(updated.amount.toNumber()).toBe(250);
    expect(updated.note).toBe("updated");

    await deleteServiceFee(testPrisma, user, fee.id);
    const s = await getAccountServiceFees(testPrisma, user, acc.id);
    expect(s.fees).toHaveLength(0);
  });

  it("company rollup totals equal the sum of per-account rows; zero rows included for accounts without fees", async () => {
    const { c, acc, user, team, owner } = await setup("sf6");
    const acc2 = await testPrisma.account.create({ data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Partner 2"), name: "Partner 2", accountManagerId: user.id } });
    await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });
    const f2 = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-06-01"), amount: "200" });
    await markFeePaid(testPrisma, user, f2.id, {});
    // acc2 has no fees at all — should still appear with zeros

    const { totals, rows } = await listCompanyServiceFees(testPrisma, user);
    expect(rows).toHaveLength(2);
    const row1 = rows.find((r) => r.accountId === acc.id)!;
    const row2 = rows.find((r) => r.accountId === acc2.id)!;
    expect(row1.billed).toBe(300);
    expect(row1.paid).toBe(200);
    expect(row1.outstanding).toBe(100);
    expect(row2.billed).toBe(0);
    expect(row2.paid).toBe(0);
    expect(row2.outstanding).toBe(0);

    const sumBilled = rows.reduce((s, r) => s + r.billed, 0);
    const sumPaid = rows.reduce((s, r) => s + r.paid, 0);
    const sumOutstanding = rows.reduce((s, r) => s + r.outstanding, 0);
    expect(totals.billed).toBe(sumBilled);
    expect(totals.paid).toBe(sumPaid);
    expect(totals.outstanding).toBe(sumOutstanding);
  });

  it("filters company rollup by status", async () => {
    const { acc, user, owner } = await setup("sf7");
    const f1 = await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });
    await addServiceFee(testPrisma, owner, acc.id, { periodMonth: new Date("2026-06-01"), amount: "200" });
    await markFeePaid(testPrisma, user, f1.id, {});

    const unpaidOnly = await listCompanyServiceFees(testPrisma, user, { status: "UNPAID" });
    expect(unpaidOnly.totals.billed).toBe(200);
    expect(unpaidOnly.totals.paid).toBe(0);
  });

  it("tenant isolation: company B cannot read or modify company A's fees", async () => {
    const A = await setup("sf8");
    const B = await setup("sf9");
    const fee = await addServiceFee(testPrisma, A.owner, A.acc.id, { periodMonth: new Date("2026-05-01"), amount: "100" });

    await expect(getAccountServiceFees(testPrisma, B.user, A.acc.id)).rejects.toThrow();
    await expect(markFeePaid(testPrisma, B.user, fee.id, {})).rejects.toThrow();
    await expect(markFeeUnpaid(testPrisma, B.user, fee.id)).rejects.toThrow();
    await expect(updateServiceFee(testPrisma, B.owner, fee.id, { amount: "1" })).rejects.toThrow();
    await expect(deleteServiceFee(testPrisma, B.user, fee.id)).rejects.toThrow();

    const sumB = await listCompanyServiceFees(testPrisma, B.user);
    expect(sumB.totals.billed).toBe(0);
  });
});

// ============================================================================================
// Per-building rate, monthly generation, filters, and the pricing gate.
// ============================================================================================

// One company, two teams, every role, and accounts spread across them.
async function world() {
  const teamA = await makeTeam({ name: "Team A" });
  const companyId = teamA.companyId;
  const teamB = await makeTeam({ companyId, name: "Team B" });
  const adminA = await makeUser("COMPANY_ADMIN", teamA);
  const memberA = await makeUser("MEMBER", teamA);
  const memberA2 = await makeUser("MEMBER", teamA);
  const adminB = await makeUser("COMPANY_ADMIN", teamB);
  const onboarder = await makeUser("ONBOARDING", teamA);
  // Wired like the seeded owner: a company context, no team.
  const owner = await testPrisma.user.create({
    data: { companyId, teamId: null, email: `owner-${companyId}@test.local`, passwordHash: "x", name: "Owner", role: "SUPER_ADMIN" },
  });
  const mk = (team: { id: string }, managerId: string, name: string, extra: Record<string, unknown> = {}) =>
    testPrisma.account.create({
      data: { companyId, teamId: team.id, buildingKey: buildingKey(name), name, accountManagerId: managerId, ...extra },
    });
  return {
    companyId, teamA, teamB, mk,
    suAdminA: su(adminA), suMemberA: su(memberA), suMemberA2: su(memberA2), suAdminB: su(adminB),
    suOnboarder: su(onboarder), suOwner: su(owner),
    adminA, memberA, memberA2, adminB,
  };
}

const feeRow = (companyId: string, accountId: string, month: string, extra: Record<string, unknown> = {}) =>
  testPrisma.serviceFee.create({
    data: { companyId, accountId, periodMonth: new Date(`${month}-01T00:00:00Z`), amount: "100", createdById: "t", ...extra },
  });

describe("service fees: per-building rate", () => {
  beforeEach(resetDb);

  it("setServiceFeeRate stores the exact decimal string and round-trips it; null clears", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.adminA.id, "Alpha");
    const out = await setServiceFeeRate(testPrisma, w.suOwner, acc.id, "1234.50");
    expect(out).toEqual({ accountId: acc.id, monthlyServiceFee: "1234.50" });
    const row = await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.monthlyServiceFee!.toFixed(2)).toBe("1234.50");
    // A float-hostile value survives exactly (no binary floating point on the way in).
    await setServiceFeeRate(testPrisma, w.suOwner, acc.id, "0.30");
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).monthlyServiceFee!.toString()).toBe("0.3");
    expect((await setServiceFeeRate(testPrisma, w.suOwner, acc.id, null)).monthlyServiceFee).toBeNull();
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).monthlyServiceFee).toBeNull();
  });

  it("rejects negatives, zero, >2 decimals, non-numeric, and number-typed (float) amounts", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.adminA.id, "Alpha");
    await setServiceFeeRate(testPrisma, w.suOwner, acc.id, "50");
    const bad: unknown[] = ["-5", "0", "0.00", "1.234", "abc", "", "1e3", " 12", "12.", "1,5", "+5", "1234567890123", 12.5, 0.1 + 0.2, 100, undefined];
    for (const v of bad) {
      await expect(setServiceFeeRate(testPrisma, w.suOwner, acc.id, v as never), `value ${String(v)}`).rejects.toBeInstanceOf(ZodError);
    }
    // Every rejected write left the stored rate untouched.
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).monthlyServiceFee!.toFixed(2)).toBe("50.00");
    for (const ok of ["10", "0.5", "1234.50", "999999999999.99"]) {
      await expect(setServiceFeeRate(testPrisma, w.suOwner, acc.id, ok)).resolves.toBeTruthy();
    }
  });

  it("is refused for COMPANY_ADMIN, MEMBER, ONBOARDING and PARTNER_VIEWER; nothing is written", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.memberA.id, "Alpha");
    const partner = await makeUser("PARTNER_VIEWER", undefined, { accountId: acc.id });
    const partnerSu: SessionUser = { ...su(partner), companyId: w.companyId };
    for (const [role, u] of [["COMPANY_ADMIN", w.suAdminA], ["MEMBER", w.suMemberA], ["ONBOARDING", w.suOnboarder], ["PARTNER_VIEWER", partnerSu]] as const) {
      await expect(setServiceFeeRate(testPrisma, u, acc.id, "99.00"), role).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setServiceFeeRate(testPrisma, u, "no-such-id", "99.00"), `${role} ghost`).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).monthlyServiceFee).toBeNull();
  });

  it("another company's account and a missing id are the same NotFoundError", async () => {
    const w = await world();
    const other = await makeTeam({ name: "Other Co" });
    const otherMgr = await makeUser("COMPANY_ADMIN", other);
    const foreign = await testPrisma.account.create({
      data: { companyId: other.companyId, teamId: other.id, buildingKey: buildingKey("Foreign"), name: "Foreign", accountManagerId: otherMgr.id },
    });
    const a = await setServiceFeeRate(testPrisma, w.suOwner, foreign.id, "10").catch((e) => e);
    const b = await setServiceFeeRate(testPrisma, w.suOwner, "no-such-id", "10").catch((e) => e);
    expect(a).toBeInstanceOf(NotFoundError);
    expect(b).toBeInstanceOf(NotFoundError);
    expect(a.message).toBe(b.message);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: foreign.id } })).monthlyServiceFee).toBeNull();
  });
});

describe("service fees: monthly generation", () => {
  beforeEach(resetDb);

  it("creates UNPAID rows at the rate with a Baku end-of-month due date, then is a no-op the second time", async () => {
    const w = await world();
    const a = await w.mk(w.teamA, w.adminA.id, "Alpha", { monthlyServiceFee: "1234.50" });
    await w.mk(w.teamB, w.adminB.id, "Beta", { monthlyServiceFee: "0.30" });
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-02")).toEqual({ created: 2, skipped: 0 });
    const rows = await testPrisma.serviceFee.findMany({ orderBy: { amount: "desc" } });
    expect(rows.map((r) => r.amount.toString())).toEqual(["1234.5", "0.3"]);
    for (const r of rows) {
      expect(r.status).toBe("UNPAID");
      expect(r.periodMonth.toISOString()).toBe("2026-02-01T00:00:00.000Z");
      // Last millisecond of 28 Feb in Baku (UTC+4) = 19:59:59.999Z the same calendar date.
      expect(r.dueDate!.toISOString()).toBe("2026-02-28T19:59:59.999Z");
    }
    // A rate change and a mark-paid between runs must not be touched by the re-run.
    await setServiceFeeRate(testPrisma, w.suOwner, a.id, "9999.00");
    await markFeePaid(testPrisma, w.suAdminA, rows.find((r) => r.accountId === a.id)!.id, {});
    const snapshot = await testPrisma.serviceFee.findMany({ orderBy: { id: "asc" } });
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-02")).toEqual({ created: 0, skipped: 2 });
    expect(await testPrisma.serviceFee.findMany({ orderBy: { id: "asc" } })).toEqual(snapshot);
    expect(snapshot.find((r) => r.accountId === a.id)!.amount.toString()).toBe("1234.5"); // not rewritten to 9999
    // A different month bills at the NEW rate.
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-03")).toEqual({ created: 2, skipped: 0 });
    const march = await testPrisma.serviceFee.findFirstOrThrow({ where: { accountId: a.id, periodMonth: new Date("2026-03-01T00:00:00Z") } });
    expect(march.amount.toString()).toBe("9999");
    expect(march.dueDate!.toISOString()).toBe("2026-03-31T19:59:59.999Z");
  });

  it("never overwrites a pre-existing manual row for the month", async () => {
    const w = await world();
    const a = await w.mk(w.teamA, w.adminA.id, "Alpha", { monthlyServiceFee: "100" });
    const manual = await feeRow(w.companyId, a.id, "2026-05", { amount: "777", note: "negotiated" });
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-05")).toEqual({ created: 0, skipped: 1 });
    const after = await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: manual.id } });
    expect(after.amount.toString()).toBe("777");
    expect(after.note).toBe("negotiated");
  });

  it("skips NULL-rate and non-ACTIVE accounts; bills a SELF-collecting ACTIVE one", async () => {
    const w = await world();
    const trial = { trialStartsAt: new Date("2026-01-01"), trialEndsAt: new Date("2026-02-01") };
    const noRate = await w.mk(w.teamA, w.adminA.id, "NoRate", { status: "ACTIVE" });
    const demo = await w.mk(w.teamA, w.adminA.id, "Demo", { status: "DEMO", monthlyServiceFee: "10", ...trial });
    const atRisk = await w.mk(w.teamA, w.adminA.id, "AtRisk", { status: "AT_RISK", monthlyServiceFee: "10" });
    const churned = await w.mk(w.teamA, w.adminA.id, "Churned", { status: "CHURNED", monthlyServiceFee: "10" });
    const self = await w.mk(w.teamA, w.adminA.id, "Self", { status: "ACTIVE", collectionMode: "SELF", monthlyServiceFee: "55.00" });
    const normal = await w.mk(w.teamB, w.adminB.id, "Normal", { status: "ACTIVE", monthlyServiceFee: "20" });
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-04")).toEqual({ created: 2, skipped: 0 });
    const billed = (await testPrisma.serviceFee.findMany()).map((r) => r.accountId).sort();
    expect(billed).toEqual([self.id, normal.id].sort());
    for (const skipped of [noRate, demo, atRisk, churned]) {
      expect(billed).not.toContain(skipped.id);
    }
  });

  it("never creates rows outside the caller's scope (another company's accounts are untouched)", async () => {
    const w = await world();
    await w.mk(w.teamA, w.adminA.id, "Mine", { monthlyServiceFee: "10" });
    const other = await makeTeam({ name: "Other Co" });
    const otherMgr = await makeUser("COMPANY_ADMIN", other);
    const foreign = await testPrisma.account.create({
      data: { companyId: other.companyId, teamId: other.id, buildingKey: buildingKey("Foreign"), name: "Foreign", accountManagerId: otherMgr.id, monthlyServiceFee: "10" },
    });
    expect(await generateMonthlyFees(testPrisma, w.suOwner, "2026-04")).toEqual({ created: 1, skipped: 0 });
    expect(await testPrisma.serviceFee.count({ where: { accountId: foreign.id } })).toBe(0);
    // And the owner of the other company bills only its own.
    const otherOwner = await testPrisma.user.create({
      data: { companyId: other.companyId, teamId: null, email: "o2@test.local", passwordHash: "x", name: "O2", role: "SUPER_ADMIN" },
    });
    expect(await generateMonthlyFees(testPrisma, su(otherOwner), "2026-04")).toEqual({ created: 1, skipped: 0 });
    expect(await testPrisma.serviceFee.count()).toBe(2);
  });

  it("is refused for COMPANY_ADMIN, MEMBER, ONBOARDING and PARTNER_VIEWER; nothing is written", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.memberA.id, "Alpha", { monthlyServiceFee: "10" });
    const partner = await makeUser("PARTNER_VIEWER", undefined, { accountId: acc.id });
    const partnerSu: SessionUser = { ...su(partner), companyId: w.companyId };
    for (const [role, u] of [["COMPANY_ADMIN", w.suAdminA], ["MEMBER", w.suMemberA], ["ONBOARDING", w.suOnboarder], ["PARTNER_VIEWER", partnerSu]] as const) {
      await expect(generateMonthlyFees(testPrisma, u, "2026-04"), role).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await testPrisma.serviceFee.count()).toBe(0);
  });

  it("rejects a malformed month", async () => {
    const w = await world();
    for (const m of ["2026-13", "2026-00", "26-04", "2026-4", "2026-04-01", "", "abcd-ef", "1999-01"]) {
      await expect(generateMonthlyFees(testPrisma, w.suOwner, m), m).rejects.toBeInstanceOf(ZodError);
    }
  });
});

describe("service fees: filters, OVERDUE and rate column", () => {
  beforeEach(resetDb);

  it("OVERDUE is unpaid AND past due; paid, future-due and NULL-dueDate fees are never overdue", async () => {
    const w = await world();
    const a = await w.mk(w.teamA, w.adminA.id, "Alpha", { monthlyServiceFee: "50.00" });
    const now = new Date("2026-03-15T10:00:00Z"); // 14:00 Baku, 15 March
    const past = await feeRow(w.companyId, a.id, "2026-01", { amount: "10", dueDate: new Date("2026-01-31T19:59:59.999Z") });
    await feeRow(w.companyId, a.id, "2026-02", { amount: "20", dueDate: new Date("2026-02-28T19:59:59.999Z"), status: "PAID", paidAt: now });
    await feeRow(w.companyId, a.id, "2026-03", { amount: "40", dueDate: new Date("2026-03-31T19:59:59.999Z") });
    await feeRow(w.companyId, a.id, "2026-04", { amount: "80", dueDate: null });
    const all = await listCompanyServiceFees(testPrisma, w.suAdminA, { now });
    expect(all.totals.overdue).toBe(10);
    expect(all.totals.billed).toBe(150);
    expect(all.rows[0].overdue).toBe(10);
    expect(all.rows[0].monthlyServiceFee).toBe("50.00");
    const od = await listCompanyServiceFees(testPrisma, w.suAdminA, { now, status: "OVERDUE" });
    expect(od.totals.billed).toBe(10);
    expect(od.totals.outstanding).toBe(10);
    // With the genuinely overdue fee gone, the NULL-dueDate fee alone is never overdue.
    await testPrisma.serviceFee.deleteMany({ where: { id: past.id } });
    const none = await listCompanyServiceFees(testPrisma, w.suAdminA, { now, status: "OVERDUE" });
    expect(none.totals.billed).toBe(0);
    // Far in the future the dated unpaid fee (40) is overdue, still not the NULL one (80).
    const later = await listCompanyServiceFees(testPrisma, w.suAdminA, { now: new Date("2027-01-01T00:00:00Z"), status: "OVERDUE" });
    expect(later.totals.billed).toBe(40);
    const paid = await listCompanyServiceFees(testPrisma, w.suAdminA, { now, status: "PAID" });
    expect(paid.totals.billed).toBe(20);
    expect(paid.totals.overdue).toBe(0);
  });

  it("'today' is the Baku day: due 23:59:59.999 Baku is overdue from Baku midnight, not UTC midnight", async () => {
    const w = await world();
    const a = await w.mk(w.teamA, w.adminA.id, "Alpha");
    await feeRow(w.companyId, a.id, "2026-03", { dueDate: new Date("2026-03-14T19:59:59.999Z") }); // end of 14 Mar, Baku
    const dayOf = (iso: string) => listCompanyServiceFees(testPrisma, w.suAdminA, { now: new Date(iso), status: "OVERDUE" });
    expect((await dayOf("2026-03-14T19:59:00Z")).totals.billed).toBe(0);  // still 14 Mar in Baku (23:59)
    expect((await dayOf("2026-03-14T20:00:00Z")).totals.billed).toBe(100); // 15 Mar 00:00 Baku
  });

  it("the q filter cannot widen a MEMBER's or COMPANY_ADMIN's scope", async () => {
    const w = await world();
    const mine = await w.mk(w.teamA, w.memberA.id, "Alpha Tower");
    const peers = await w.mk(w.teamA, w.memberA2.id, "Alpha Plaza");
    const otherTeam = await w.mk(w.teamB, w.adminB.id, "Alpha Heights");
    await w.mk(w.teamA, w.memberA.id, "Zeta");
    const names = async (u: SessionUser, o?: Parameters<typeof listCompanyServiceFees>[2]) =>
      (await listCompanyServiceFees(testPrisma, u, o)).rows.map((r) => r.accountName).sort();
    // Member: own only, with and without the filter (the membership AND is not clobbered).
    expect(await names(w.suMemberA)).toEqual(["Alpha Tower", "Zeta"]);
    expect(await names(w.suMemberA, { q: "alpha" })).toEqual(["Alpha Tower"]);
    expect(await names(w.suMemberA, { q: "ALPHA PLAZA" })).toEqual([]);
    // Naming another member's / team's account id cannot reach it either.
    expect(await names(w.suMemberA, { accountId: peers.id })).toEqual([]);
    expect(await names(w.suMemberA, { accountId: otherTeam.id, q: "alpha" })).toEqual([]);
    expect(await names(w.suMemberA, { accountId: mine.id })).toEqual(["Alpha Tower"]);
    // Team admin: own team only.
    expect(await names(w.suAdminA, { q: "alpha" })).toEqual(["Alpha Plaza", "Alpha Tower"]);
    expect(await names(w.suAdminA, { accountId: otherTeam.id })).toEqual([]);
    expect(await names(w.suAdminB, { q: "alpha" })).toEqual(["Alpha Heights"]);
    // An assigned account is inside the member's scope, and the filter still narrows it.
    await testPrisma.accountAssignment.create({ data: { companyId: w.companyId, accountId: peers.id, userId: w.memberA.id, createdById: w.adminA.id } });
    expect(await names(w.suMemberA, { q: "alpha" })).toEqual(["Alpha Plaza", "Alpha Tower"]);
    expect(await names(w.suMemberA, { q: "zeta" })).toEqual(["Zeta"]);
  });

  it("filters by account and period together", async () => {
    const w = await world();
    const a = await w.mk(w.teamA, w.adminA.id, "Alpha");
    const b = await w.mk(w.teamA, w.adminA.id, "Beta");
    await feeRow(w.companyId, a.id, "2026-01", { amount: "1" });
    await feeRow(w.companyId, a.id, "2026-02", { amount: "2" });
    await feeRow(w.companyId, b.id, "2026-02", { amount: "4" });
    const r = await listCompanyServiceFees(testPrisma, w.suAdminA, { accountId: a.id, from: new Date("2026-02-01T00:00:00Z") });
    expect(r.rows).toHaveLength(1);
    expect(r.totals.billed).toBe(2);
  });
});

describe("service fees: the pricing gate on fee-amount writes", () => {
  beforeEach(resetDb);

  it("a MEMBER and a team admin can no longer create a fee or change an amount; the refusal says why", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.memberA.id, "Alpha");
    const fee = await feeRow(w.companyId, acc.id, "2026-01", { amount: "100" });
    for (const u of [w.suMemberA, w.suAdminA]) {
      const c = await addServiceFee(testPrisma, u, acc.id, { periodMonth: new Date("2026-02-01"), amount: "1" }).catch((e) => e);
      expect(c).toBeInstanceOf(ForbiddenError);
      expect(c.message).toMatch(/owner|super admin/i);
      expect(c.message).toMatch(/payment/i);
      const e = await updateServiceFee(testPrisma, u, fee.id, { amount: "1" }).catch((x) => x);
      expect(e).toBeInstanceOf(ForbiddenError);
      // Same refusal for a real fee id and an invented one: no id-probing oracle.
      const ghost = await updateServiceFee(testPrisma, u, "no-such-fee", { amount: "1" }).catch((x) => x);
      expect(ghost).toBeInstanceOf(ForbiddenError);
      expect(ghost.message).toBe(e.message);
    }
    expect(await testPrisma.serviceFee.count()).toBe(1);
    expect((await testPrisma.serviceFee.findUniqueOrThrow({ where: { id: fee.id } })).amount.toString()).toBe("100");
  });

  it("recording a payment and non-amount edits stay at the existing gate (MEMBER keeps them)", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.memberA.id, "Alpha");
    const fee = await feeRow(w.companyId, acc.id, "2026-01", { amount: "100" });
    const paid = await markFeePaid(testPrisma, w.suMemberA, fee.id, { method: "CASH" });
    expect(paid.status).toBe("PAID");
    expect((await markFeeUnpaid(testPrisma, w.suMemberA, fee.id)).status).toBe("UNPAID");
    const edited = await updateServiceFee(testPrisma, w.suMemberA, fee.id, { note: "called them", dueDate: new Date("2026-02-10T00:00:00Z") });
    expect(edited.note).toBe("called them");
    expect(edited.amount.toString()).toBe("100");
    // ...but ONBOARDING still cannot, and another member's building is still a 404.
    await expect(markFeePaid(testPrisma, w.suOnboarder, fee.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(markFeePaid(testPrisma, w.suMemberA2, fee.id, {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the owner (SUPER_ADMIN) can still create and re-price a fee", async () => {
    const w = await world();
    const acc = await w.mk(w.teamA, w.memberA.id, "Alpha");
    const fee = await addServiceFee(testPrisma, w.suOwner, acc.id, { periodMonth: new Date("2026-02-14"), amount: "120" });
    expect(fee.amount.toString()).toBe("120");
    expect((await updateServiceFee(testPrisma, w.suOwner, fee.id, { amount: "130" })).amount.toString()).toBe("130");
  });
});

describe("sortServiceFeeRows", () => {
  const row = (accountId: string, accountName: string, rate: string | null, billed: number, paid: number): SortableFeeRow =>
    ({ accountId, accountName, monthlyServiceFee: rate, billed, paid, outstanding: billed - paid });
  const rows = [
    row("1", "charlie", "20.00", 300, 100),
    row("2", "Alpha", null, 100, 100),
    row("3", "bravo", "5.50", 200, 0),
    row("4", "Delta", null, 0, 0),
    row("5", "echo", "100.00", 300, 50),
  ];
  const ids = (r: SortableFeeRow[]) => r.map((x) => x.accountId).join(",");

  it("sorts by name case-insensitively, both directions", () => {
    expect(ids(sortServiceFeeRows(rows, "name", "asc"))).toBe("2,3,1,4,5");
    expect(ids(sortServiceFeeRows(rows, "name", "desc"))).toBe("5,4,1,3,2");
  });

  it("sorts the rate numerically, with no-rate rows LAST in both directions", () => {
    expect(ids(sortServiceFeeRows(rows, "rate", "asc"))).toBe("3,1,5,2,4");
    expect(ids(sortServiceFeeRows(rows, "rate", "desc"))).toBe("5,1,3,2,4");
  });

  it("sorts billed / paid / outstanding with a stable name tie-break", () => {
    expect(ids(sortServiceFeeRows(rows, "billed", "desc"))).toBe("1,5,3,2,4");
    expect(ids(sortServiceFeeRows(rows, "billed", "asc"))).toBe("4,2,3,1,5");
    expect(ids(sortServiceFeeRows(rows, "paid", "asc"))).toBe("3,4,5,2,1");
    expect(ids(sortServiceFeeRows(rows, "outstanding", "desc"))).toBe("5,3,1,2,4");
  });

  it("does not mutate its input and handles empty input", () => {
    const copy = [...rows];
    sortServiceFeeRows(rows, "billed", "asc");
    expect(rows).toEqual(copy);
    expect(sortServiceFeeRows([], "name", "asc")).toEqual([]);
  });
});
