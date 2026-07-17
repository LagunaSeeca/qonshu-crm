import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { getDashboardStats, type DashboardStats } from "./dashboard";
import { listCompanySettlements } from "./settlements";

export type PartnerRow = {
  accountId: string;
  accountName: string;
  paymentsCount: number;
  paymentsAmount: number;
  collected: number;
  transferred: number;
  owed: number;
};

export type Report = {
  label: string;
  scope: "ALL" | "PARTNER";
  accountName?: string;
  kpis: DashboardStats;
  partnerRows: PartnerRow[];
};

const num = (d: { toNumber: () => number }) => d.toNumber();

export async function getReport(
  db: PrismaClient,
  user: SessionUser,
  opts: { range: { from: Date; to: Date }; label: string; accountId?: string }
): Promise<Report> {
  const companyId = user.companyId!;
  const scope: "ALL" | "PARTNER" = opts.accountId ? "PARTNER" : "ALL";

  let accounts: { id: string; name: string }[];
  let accountName: string | undefined;
  if (scope === "PARTNER") {
    const acc = await getAccount(db, user, opts.accountId!);
    if (!acc) throw new NotFoundError("account not in scope");
    accounts = [acc];
    accountName = acc.name;
  } else {
    accounts = await db.account.findMany({ where: { companyId } });
  }

  const accountIds = accounts.map((a) => a.id);
  const [kpis, payments, settlements] = await Promise.all([
    getDashboardStats(db, user, opts.range),
    db.partnerPayment.findMany({
      where: { companyId, accountId: { in: accountIds }, occurredAt: { gte: opts.range.from, lte: opts.range.to } },
    }),
    listCompanySettlements(db, user),
  ]);

  const settlementByAccount = new Map(settlements.rows.map((r) => [r.accountId, r]));
  const partnerRows: PartnerRow[] = accounts.map((a) => {
    const mine = payments.filter((p) => p.accountId === a.id);
    const s = settlementByAccount.get(a.id);
    return {
      accountId: a.id,
      accountName: a.name,
      paymentsCount: mine.length,
      paymentsAmount: mine.reduce((sum, p) => sum + num(p.amount), 0),
      collected: s?.collected ?? 0,
      transferred: s?.transferred ?? 0,
      owed: s?.owed ?? 0,
    };
  });

  return { label: opts.label, scope, accountName, kpis, partnerRows };
}

function esc(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(report: Report): string {
  const k = report.kpis;
  const lines: string[] = [
    `Report,${esc(report.label)}`,
    `Scope,${esc(report.scope)}`,
    "",
    "Metric,Value",
    `Open leads,${esc(k.sales.openLeads)}`,
    `Won in period,${esc(k.sales.wonInPeriod)}`,
    `Meetings done,${esc(k.activity.meetingsDone)}`,
    `Open tasks,${esc(k.activity.openTasks)}`,
    `Overdue tasks,${esc(k.activity.overdueTasks)}`,
    `Partner accounts,${esc(k.partners.accounts)}`,
    `App users,${esc(k.partners.appUsers)}`,
    `Users engaged,${esc(k.partners.engagedUsers)}`,
    `Payments amount,${esc(k.partners.paymentsAmount)}`,
    `App installs,${esc(k.partners.appInstalls)}`,
    `Installs iOS,${esc(k.partners.installsIos)}`,
    `Installs Android,${esc(k.partners.installsAndroid)}`,
    `Collected,${esc(k.finance.collected)}`,
    `Transferred,${esc(k.finance.transferred)}`,
    `Owed,${esc(k.finance.owed)}`,
    `Service fees outstanding,${esc(k.finance.serviceFeesOutstanding)}`,
    "",
    "Partner,Payments,Payments Amount,Collected,Transferred,Owed",
    ...report.partnerRows.map((r) =>
      [r.accountName, r.paymentsCount, r.paymentsAmount, r.collected, r.transferred, r.owed].map(esc).join(",")
    ),
  ];
  return lines.join("\n");
}
