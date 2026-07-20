import type { PrismaClient, CompanyStatus } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";

const num = (d: { toNumber: () => number } | null | undefined) => (d ? d.toNumber() : 0);

export type PlatformCompanyRow = {
  id: string;
  name: string;
  slug: string;
  status: CompanyStatus;
  createdAt: Date;
  users: number;
  members: number;
  admins: number;
  accounts: number;
  leads: number;
  appUsers: number;
  paymentsAmount: number;
};

export type PlatformOverview = {
  totals: {
    companies: number;
    users: number;
    accounts: number;
    leads: number;
    appUsers: number;
    paymentsAmount: number;
  };
  companies: PlatformCompanyRow[];
};

// The one sanctioned cross-company read in the app: every other tenant-scoped query in
// src/lib/tenant/* filters by companyId, but a super admin legitimately needs to see across
// all tenants. Gated by assertRole so a COMPANY_ADMIN calling this directly still gets
// ForbiddenError instead of silently seeing other companies' data.
export async function getPlatformOverview(db: PrismaClient, actor: SessionUser): Promise<PlatformOverview> {
  assertRole(actor, ["SUPER_ADMIN"]);

  const [companies, userCounts, adminCounts, memberCounts, accountCounts, leadCounts, appUserCounts, paymentSums] =
    await Promise.all([
      db.company.findMany({ orderBy: { createdAt: "desc" } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null } } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null }, role: "COMPANY_ADMIN" } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null }, role: "MEMBER" } }),
      db.account.groupBy({ by: ["companyId"], _count: { _all: true } }),
      db.lead.groupBy({ by: ["companyId"], _count: { _all: true } }),
      db.partnerAppUser.groupBy({ by: ["companyId"], _count: { _all: true } }),
      db.partnerPayment.groupBy({ by: ["companyId"], _sum: { amount: true } }),
    ]);

  const toMap = <T extends { companyId: string | null }>(rows: T[]) =>
    new Map(rows.map((r) => [r.companyId as string, r]));
  const userMap = toMap(userCounts);
  const adminMap = toMap(adminCounts);
  const memberMap = toMap(memberCounts);
  const accountMap = toMap(accountCounts);
  const leadMap = toMap(leadCounts);
  const appUserMap = toMap(appUserCounts);
  const paymentMap = toMap(paymentSums);

  const companyRows: PlatformCompanyRow[] = companies.map((c) => ({
    id: c.id,
    name: c.name,
    slug: c.slug,
    status: c.status,
    createdAt: c.createdAt,
    users: userMap.get(c.id)?._count._all ?? 0,
    members: memberMap.get(c.id)?._count._all ?? 0,
    admins: adminMap.get(c.id)?._count._all ?? 0,
    accounts: accountMap.get(c.id)?._count._all ?? 0,
    leads: leadMap.get(c.id)?._count._all ?? 0,
    appUsers: appUserMap.get(c.id)?._count._all ?? 0,
    paymentsAmount: num(paymentMap.get(c.id)?._sum.amount),
  }));

  const totals = companyRows.reduce(
    (acc, c) => {
      acc.companies += 1;
      acc.users += c.users;
      acc.accounts += c.accounts;
      acc.leads += c.leads;
      acc.appUsers += c.appUsers;
      acc.paymentsAmount += c.paymentsAmount;
      return acc;
    },
    { companies: 0, users: 0, accounts: 0, leads: 0, appUsers: 0, paymentsAmount: 0 },
  );

  return { totals, companies: companyRows };
}
