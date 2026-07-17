import type { PrismaClient, PaymentMethod, PaymentCategory } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

const num = (d: { toNumber: () => number } | null | undefined) => (d ? d.toNumber() : 0);

export async function getAccountAnalytics(db: PrismaClient, user: SessionUser, accountId: string, range: { from: Date; to: Date }) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const where = { companyId: user.companyId!, accountId, occurredAt: { gte: range.from, lte: range.to } };
  const [users, payments] = await Promise.all([
    db.partnerAppUser.findMany({ where: { companyId: user.companyId!, accountId } }),
    db.partnerPayment.findMany({ where }),
  ]);
  const totalDebt = users.reduce((s, u) => s + num(u.debt), 0);
  const activeUsers = users.filter((u) => u.active).length;
  const installedUsers = users.filter((u) => u.installedAt !== null);
  const installsTotal = installedUsers.length;
  const activated = users.filter((u) => u.lastLoginAt !== null).length;
  const amount = (arr: typeof payments) => arr.reduce((s, p) => s + num(p.amount), 0);
  const util = payments.filter((p) => p.category === "UTILITY");
  const groupBy = <K extends string>(key: (p: typeof payments[number]) => K, keys: K[]) =>
    keys.map((k) => { const g = payments.filter((p) => key(p) === k); return { key: k, count: g.length, amount: amount(g) }; });
  const byMethod = groupBy((p) => p.method, ["CARD", "MANUAL", "CASH"] as PaymentMethod[]).map((r) => ({ method: r.key, count: r.count, amount: r.amount }));
  const byCategory = groupBy((p) => p.category, ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"] as PaymentCategory[]).map((r) => ({ category: r.key, count: r.count, amount: r.amount }));
  const trendMap = new Map<string, { count: number; amount: number }>();
  for (const p of payments) { const d = p.occurredAt.toISOString().slice(0, 10); const t = trendMap.get(d) ?? { count: 0, amount: 0 }; t.count++; t.amount += num(p.amount); trendMap.set(d, t); }
  const trend = [...trendMap.entries()].sort().map(([date, v]) => ({ date, count: v.count, amount: v.amount }));
  const paidByUser = new Map<string, number>();
  for (const p of payments) paidByUser.set(p.appUserId, (paidByUser.get(p.appUserId) ?? 0) + num(p.amount));
  const topUsers = users.map((u) => ({ name: u.name, paid: paidByUser.get(u.id) ?? 0, debt: num(u.debt) })).sort((a, b) => b.paid - a.paid).slice(0, 10);
  const ios = installedUsers.filter((u) => u.platform === "IOS").length;
  const android = installedUsers.filter((u) => u.platform === "ANDROID").length;
  const activationRate = installsTotal > 0 ? Math.round((activated / installsTotal) * 1000) / 10 : 0;
  return {
    kpis: { activeUsers, totalUsers: users.length, totalDebt, paymentsCount: payments.length, paymentsAmount: amount(payments), utilityCount: util.length, utilityAmount: amount(util) },
    byMethod, byCategory, trend, topUsers,
    installs: { total: installsTotal, ios, android, activated, activationRate },
  };
}

export async function listAccountPayments(db: PrismaClient, user: SessionUser, accountId: string, opts: { from: Date; to: Date; method?: PaymentMethod; category?: PaymentCategory; skip?: number; take?: number }) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) return { rows: [], total: 0 };
  const where = { companyId: user.companyId!, accountId, occurredAt: { gte: opts.from, lte: opts.to }, ...(opts.method ? { method: opts.method } : {}), ...(opts.category ? { category: opts.category } : {}) };
  const [rows, total] = await Promise.all([
    db.partnerPayment.findMany({ where, orderBy: { occurredAt: "desc" }, skip: opts.skip, take: opts.take ?? 25, include: { appUser: true } }),
    db.partnerPayment.count({ where }),
  ]);
  return { rows: rows.map((p) => ({ id: p.id, occurredAt: p.occurredAt, amount: num(p.amount), method: p.method, category: p.category, userName: p.appUser.name })), total };
}
