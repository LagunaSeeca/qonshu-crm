import type { PrismaClient, PaymentMethod, PaymentCategory } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { listAccounts } from "./accounts";

const num = (d: { toNumber: () => number } | null | undefined) => (d ? d.toNumber() : 0);

export async function getCompanyAnalytics(db: PrismaClient, user: SessionUser, range: { from: Date; to: Date }) {
  const companyId = user.companyId!;
  const [accounts, users, payments] = await Promise.all([
    listAccounts(db, user),
    db.partnerAppUser.findMany({ where: { companyId } }),
    db.partnerPayment.findMany({ where: { companyId, occurredAt: { gte: range.from, lte: range.to } } }),
  ]);

  const totalDebt = users.reduce((s, u) => s + num(u.debt), 0);
  const activeUsers = users.filter((u) => u.active).length;
  const installedUsers = users.filter((u) => u.installedAt !== null);
  const installsTotal = installedUsers.length;
  const iosInstalls = installedUsers.filter((u) => u.platform === "IOS").length;
  const androidInstalls = installedUsers.filter((u) => u.platform === "ANDROID").length;
  const loggedInUsers = users.filter((u) => u.lastLoginAt !== null).length;
  const activationRate = installsTotal > 0 ? Math.round((loggedInUsers / installsTotal) * 1000) / 10 : 0;

  const amount = (arr: typeof payments) => arr.reduce((s, p) => s + num(p.amount), 0);
  const util = payments.filter((p) => p.category === "UTILITY");
  const engagedUsers = new Set(payments.map((p) => p.appUserId)).size;

  const groupBy = <K extends string>(key: (p: typeof payments[number]) => K, keys: K[]) =>
    keys.map((k) => { const g = payments.filter((p) => key(p) === k); return { key: k, count: g.length, amount: amount(g) }; });
  const byMethod = groupBy((p) => p.method, ["CARD", "MANUAL", "CASH"] as PaymentMethod[]).map((r) => ({ method: r.key, count: r.count, amount: r.amount }));
  const byCategory = groupBy((p) => p.category, ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"] as PaymentCategory[]).map((r) => ({ category: r.key, count: r.count, amount: r.amount }));

  const trendMap = new Map<string, { count: number; amount: number }>();
  for (const p of payments) {
    const d = p.occurredAt.toISOString().slice(0, 10);
    const t = trendMap.get(d) ?? { count: 0, amount: 0 };
    t.count++;
    t.amount += num(p.amount);
    trendMap.set(d, t);
  }
  const trend = [...trendMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([date, v]) => ({ date, count: v.count, amount: v.amount }));

  const partners = accounts
    .map((a) => {
      const acctUsers = users.filter((u) => u.accountId === a.id);
      const acctPayments = payments.filter((p) => p.accountId === a.id);
      return {
        accountId: a.id,
        accountName: a.name,
        appUsers: acctUsers.length,
        installs: acctUsers.filter((u) => u.installedAt !== null).length,
        engagedUsers: new Set(acctPayments.map((p) => p.appUserId)).size,
        paymentsCount: acctPayments.length,
        paymentsAmount: amount(acctPayments),
      };
    })
    .sort((a, b) => b.paymentsAmount - a.paymentsAmount);

  return {
    totals: {
      accounts: accounts.length,
      appUsers: users.length,
      activeUsers,
      engagedUsers,
      totalDebt,
      installs: installsTotal,
      iosInstalls,
      androidInstalls,
      loggedInUsers,
      activationRate,
      paymentsCount: payments.length,
      paymentsAmount: amount(payments),
      utilityCount: util.length,
      utilityAmount: amount(util),
    },
    byMethod,
    byCategory,
    trend,
    partners,
  };
}

export type CompanyAnalytics = Awaited<ReturnType<typeof getCompanyAnalytics>>;
