import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import {
  addServiceFee,
  updateServiceFee,
  deleteServiceFee,
  markFeePaid,
  markFeeUnpaid,
  getAccountServiceFees,
  listCompanyServiceFees,
} from "./service-fees";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("service-fees", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("computes totalBilled/totalPaid/totalOutstanding for an account", async () => {
    const { acc, user } = await setup("sf1");
    const f1 = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });
    await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-06-01"), amount: 150 });
    await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-07-01"), amount: 200 });
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
    const { acc, user } = await setup("sf2");
    const fee = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-15T12:00:00Z"), amount: 100 });
    expect(fee.periodMonth.toISOString()).toBe(new Date("2026-05-01T00:00:00.000Z").toISOString());
  });

  it("rejects a duplicate account+month fee", async () => {
    const { acc, user } = await setup("sf3");
    await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });
    await expect(addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-10"), amount: 999 })).rejects.toThrow();
  });

  it("markFeePaid sets PAID + paidAt + method; markFeeUnpaid reverses", async () => {
    const { acc, user } = await setup("sf4");
    const fee = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });
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
    const { acc, user } = await setup("sf5");
    const fee = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100, note: "orig" });
    const updated = await updateServiceFee(testPrisma, user, fee.id, { amount: 250, note: "updated" });
    expect(updated.amount.toNumber()).toBe(250);
    expect(updated.note).toBe("updated");

    await deleteServiceFee(testPrisma, user, fee.id);
    const s = await getAccountServiceFees(testPrisma, user, acc.id);
    expect(s.fees).toHaveLength(0);
  });

  it("company rollup totals equal the sum of per-account rows; zero rows included for accounts without fees", async () => {
    const { c, acc, user } = await setup("sf6");
    const acc2 = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner 2", accountManagerId: user.id } });
    await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });
    const f2 = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-06-01"), amount: 200 });
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
    const { acc, user } = await setup("sf7");
    const f1 = await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });
    await addServiceFee(testPrisma, user, acc.id, { periodMonth: new Date("2026-06-01"), amount: 200 });
    await markFeePaid(testPrisma, user, f1.id, {});

    const unpaidOnly = await listCompanyServiceFees(testPrisma, user, { status: "UNPAID" });
    expect(unpaidOnly.totals.billed).toBe(200);
    expect(unpaidOnly.totals.paid).toBe(0);
  });

  it("tenant isolation: company B cannot read or modify company A's fees", async () => {
    const A = await setup("sf8");
    const B = await setup("sf9");
    const fee = await addServiceFee(testPrisma, A.user, A.acc.id, { periodMonth: new Date("2026-05-01"), amount: 100 });

    await expect(getAccountServiceFees(testPrisma, B.user, A.acc.id)).rejects.toThrow();
    await expect(markFeePaid(testPrisma, B.user, fee.id, {})).rejects.toThrow();
    await expect(markFeeUnpaid(testPrisma, B.user, fee.id)).rejects.toThrow();
    await expect(updateServiceFee(testPrisma, B.user, fee.id, { amount: 1 })).rejects.toThrow();
    await expect(deleteServiceFee(testPrisma, B.user, fee.id)).rejects.toThrow();

    const sumB = await listCompanyServiceFees(testPrisma, B.user);
    expect(sumB.totals.billed).toBe(0);
  });
});
