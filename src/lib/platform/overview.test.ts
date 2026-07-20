import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getPlatformOverview } from "./overview";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };

async function seedCompanyWithData(opts: {
  slug: string;
  admins: number;
  members: number;
  accounts: number;
  leadsPerAccount?: number;
  paymentAmounts?: number[];
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

  if (opts.paymentAmounts?.length && accounts.length) {
    const appUser = await testPrisma.partnerAppUser.create({
      data: { companyId: company.id, accountId: accounts[0].id, externalId: `ext-${opts.slug}`, name: "App user", joinedAt: new Date() },
    });
    for (const amount of opts.paymentAmounts) {
      await testPrisma.partnerPayment.create({
        data: {
          companyId: company.id, accountId: accounts[0].id, appUserId: appUser.id,
          occurredAt: new Date(), amount, method: "CARD", category: "APARTMENT",
        },
      });
    }
  }

  return company;
}

describe("getPlatformOverview", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns correct per-company counts and platform totals across two companies", async () => {
    const ts = Date.now();
    const a = await seedCompanyWithData({
      slug: `ov-a-${ts}`, admins: 1, members: 2, accounts: 2, leadsPerAccount: 1, paymentAmounts: [100, 50],
    });
    const b = await seedCompanyWithData({
      slug: `ov-b-${ts}`, admins: 1, members: 0, accounts: 1, leadsPerAccount: 3, paymentAmounts: [25],
    });

    const overview = await getPlatformOverview(testPrisma, su);

    const rowA = overview.companies.find((c) => c.id === a.id)!;
    const rowB = overview.companies.find((c) => c.id === b.id)!;

    expect(rowA.users).toBe(3); // 1 admin + 2 members
    expect(rowA.admins).toBe(1);
    expect(rowA.members).toBe(2);
    expect(rowA.accounts).toBe(2);
    expect(rowA.leads).toBe(2); // 1 lead per account x 2 accounts
    expect(rowA.appUsers).toBe(1);
    expect(rowA.paymentsAmount).toBe(150);

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
    expect(overview.totals.appUsers).toBe(2);
    expect(overview.totals.paymentsAmount).toBe(175);
  });

  it("throws ForbiddenError for a non-SUPER_ADMIN caller (company isolation)", async () => {
    const ts = Date.now();
    const a = await seedCompanyWithData({ slug: `ov-forbid-a-${ts}`, admins: 1, members: 0, accounts: 0 });
    await seedCompanyWithData({ slug: `ov-forbid-b-${ts}`, admins: 1, members: 0, accounts: 0 });
    const companyAdmin: SessionUser = { id: "x", companyId: a.id, role: "COMPANY_ADMIN" };
    await expect(getPlatformOverview(testPrisma, companyAdmin)).rejects.toThrow(ForbiddenError);
  });
});
