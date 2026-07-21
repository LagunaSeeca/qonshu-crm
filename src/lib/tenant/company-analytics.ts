import type { PrismaClient, PaymentMethod, PaymentCategory } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { listAccounts, getAccount } from "./accounts";

const num = (d: { toNumber: () => number } | null | undefined) => (d ? d.toNumber() : 0);

type FlowGranularity = "day" | "week" | "month";

// Daily buckets read as noise past ~a month; step down as the range widens.
function flowGranularity(from: Date, to: Date): FlowGranularity {
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000));
  if (days <= 31) return "day";
  if (days <= 120) return "week";
  return "month";
}

// Bucket key is itself an ISO-sortable string: "YYYY-MM-DD" for day/week (week keyed by
// its Monday), "YYYY-MM" for month.
function flowBucketKey(d: Date, granularity: FlowGranularity): string {
  if (granularity === "month") return d.toISOString().slice(0, 7);
  if (granularity === "day") return d.toISOString().slice(0, 10);
  const dow = d.getUTCDay(); // 0 = Sun .. 6 = Sat
  const diffToMonday = (dow === 0 ? -6 : 1) - dow;
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diffToMonday));
  return monday.toISOString().slice(0, 10);
}

export async function getCompanyAnalytics(
  db: PrismaClient,
  user: SessionUser,
  range: { from: Date; to: Date },
  opts?: { accountId?: string },
) {
  const companyId = user.companyId!;

  // Resolve the single-account filter: for PARTNER_VIEWER it's forced to their own account
  // (or a sentinel that matches nothing when unset — fail closed); for admin/member it's the
  // optional company-filter param, validated through the getAccount chokepoint so an
  // unknown/foreign id 404s upstream instead of silently returning company-wide data.
  let targetAccountId: string | null = null;
  if (user.role === "PARTNER_VIEWER") {
    targetAccountId = user.accountId ?? "__no_access__";
  } else if (opts?.accountId) {
    const acc = await getAccount(db, user, opts.accountId);
    if (!acc) throw new NotFoundError("account not in scope");
    targetAccountId = opts.accountId;
  }

  const [accounts, users, payments, settlementEntries, debtSnapshots] = await Promise.all([
    targetAccountId
      ? db.account.findMany({ where: { id: targetAccountId, companyId } })
      : listAccounts(db, user),
    db.partnerAppUser.findMany({ where: targetAccountId ? { companyId, accountId: targetAccountId } : { companyId } }),
    db.partnerPayment.findMany({
      where: {
        companyId,
        occurredAt: { gte: range.from, lte: range.to },
        ...(targetAccountId ? { accountId: targetAccountId } : {}),
      },
    }),
    db.settlementEntry.findMany({
      where: {
        companyId,
        occurredAt: { gte: range.from, lte: range.to },
        ...(targetAccountId ? { accountId: targetAccountId } : {}),
      },
    }),
    db.accountDebtSnapshot.findMany({
      where: {
        companyId,
        capturedOn: { gte: range.from, lte: range.to },
        ...(targetAccountId ? { accountId: targetAccountId } : {}),
      },
    }),
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

  // Money-flow: app payments in vs. settlement collected/transferred, bucketed together so
  // all three series line up on the same date axis. Stock (owed/debt) is deliberately excluded —
  // those are snapshots, not flows, and belong on the KPI tiles instead.
  const granularity = flowGranularity(range.from, range.to);
  const flowMap = new Map<string, { paymentsIn: number; collected: number; transferred: number }>();
  const flowBucket = (key: string) => {
    let b = flowMap.get(key);
    if (!b) { b = { paymentsIn: 0, collected: 0, transferred: 0 }; flowMap.set(key, b); }
    return b;
  };
  for (const p of payments) {
    flowBucket(flowBucketKey(p.occurredAt, granularity)).paymentsIn += num(p.amount);
  }
  for (const e of settlementEntries) {
    const b = flowBucket(flowBucketKey(e.occurredAt, granularity));
    if (e.type === "COLLECTED") b.collected += num(e.amount);
    else b.transferred += num(e.amount);
  }
  const moneyFlow = [...flowMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, v]) => ({ date, paymentsIn: v.paymentsIn, collected: v.collected, transferred: v.transferred }));

  // Debt over time: sum each day's per-account debt snapshots into one company-wide (or
  // single-partner) total-debt point. A stock, so it's the day's balance — never summed across days.
  const debtMap = new Map<string, number>();
  for (const s of debtSnapshots) {
    const d = s.capturedOn.toISOString().slice(0, 10);
    debtMap.set(d, (debtMap.get(d) ?? 0) + num(s.totalDebt));
  }
  const debtOverTime = [...debtMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, debt]) => ({ date, debt }));

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
    moneyFlow,
    debtOverTime,
    partners,
  };
}

export type CompanyAnalytics = Awaited<ReturnType<typeof getCompanyAnalytics>>;
