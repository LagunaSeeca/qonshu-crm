import type { PrismaClient, Account } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { getDashboardStats, type DashboardStats } from "./dashboard";
import { listCompanySettlements } from "./settlements";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "@/lib/partner-api/errors";
import type {
  PartnerPayment,
  PartnerStatsResponse,
  PaymentMethod,
  PaymentCategory,
} from "@/lib/partner-api/schema";

// Reports are now a LIVE read: the per-partner payment figures and the flattened payment-level
// detail come from the external Partner API for the requested range — NOT from a persisted
// `partnerPayment` table. Nothing fetched here is written back to the DB. The KPI Summary block
// still comes from `getDashboardStats` (the shared Dashboard computation, migrated on its own
// slice), and Collected/Transferred/Owed still come from the company Settlement ledger — those
// are company-owned CRM records, not partner-app payments, and the Partner API cannot supply them.

export type PartnerRow = {
  accountId: string;
  accountName: string;
  paymentsCount: number; // LIVE — Partner API total_payments_count for the range
  paymentsAmount: number; // LIVE — Partner API total_payments_amount for the range
  collected: number; // Settlement ledger (DB) — not sourceable from the Partner API
  transferred: number; // Settlement ledger (DB) — not sourceable from the Partner API
  owed: number; // Settlement ledger (DB) — not sourceable from the Partner API
};

// One row per individual payment, flattened across every configured account (paginated live).
export type PaymentRow = {
  accountId: string;
  accountName: string;
  id: string;
  userId: string;
  userName: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  category: PaymentCategory;
};

export type AccountReportReason =
  | "not_configured" // no partner name, or no resolvable key (env + override both absent) — never hit the network
  | "duplicate_partner" // another account already claimed this partner name — see dedup note below
  | "invalid_key" // Partner API rejected the key (401)
  | "unknown_partner" // Partner API does not recognize the partner (404)
  | "unavailable" // network failure / timeout / 5xx
  | "error" // decrypt or schema-validation failure
  | "partial"; // page 1 succeeded but some pages (or the page cap) dropped payment detail

export type AccountReportStatus = {
  accountId: string;
  accountName: string;
  status: "ok" | "partial" | "skipped";
  reason?: AccountReportReason;
};

export type Report = {
  label: string;
  scope: "ALL" | "PARTNER";
  accountName?: string;
  kpis: DashboardStats;
  partnerRows: PartnerRow[];
  payments: PaymentRow[];
  accountStatuses: AccountReportStatus[];
};

// The Partner API caps page_size at 500. We cap the number of pages we will chase per account so
// a pathological partner (hundreds of thousands of payments) can't blow up memory / the CSV or
// hammer the upstream — 20 pages × 500 = up to 10,000 payment rows of detail per account. The
// aggregate paymentsCount/paymentsAmount always reflect the FULL range (they come from the
// summary totals, not the fetched pages), so the cap only ever truncates the row-level detail,
// and we flag the account "partial" when it does.
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

// Map a per-account failure to a stable, secret-free reason.
function skipReason(err: unknown): AccountReportReason {
  if (err instanceof InvalidApiKeyError) return "invalid_key";
  if (err instanceof UnknownPartnerError) return "unknown_partner";
  if (err instanceof PartnerApiUnavailableError) return "unavailable";
  return "error";
}

type AccountPayments = {
  summary: PartnerStatsResponse;
  payments: PartnerPayment[];
  partial: boolean;
};

// Fetch EVERY payment for one account across the range. Page 1 (any error here rejects and the
// account is skipped) yields the authoritative summary totals plus payments_page_count; the
// remaining pages are fetched in parallel with Promise.allSettled so one bad page degrades the
// detail to "partial" instead of losing the account. Pages beyond MAX_PAGES are intentionally
// dropped and also mark the result partial.
async function fetchAllPayments(params: {
  baseUrl?: string;
  apiKey: string;
  partner: string;
  dateFrom: string;
  dateTo: string;
}): Promise<AccountPayments> {
  const first = await fetchPartnerStats({ ...params, page: 1, pageSize: PAGE_SIZE });
  const totalPages = Math.max(1, Math.floor(first.payments_page_count || 1));
  const cappedPages = Math.min(totalPages, MAX_PAGES);
  const payments: PartnerPayment[] = [...first.payments];
  let partial = totalPages > MAX_PAGES;

  if (cappedPages > 1) {
    const rest = await Promise.allSettled(
      Array.from({ length: cappedPages - 1 }, (_, i) =>
        fetchPartnerStats({ ...params, page: i + 2, pageSize: PAGE_SIZE }),
      ),
    );
    for (const r of rest) {
      if (r.status === "fulfilled") payments.push(...r.value.payments);
      else partial = true;
    }
  }

  return { summary: first, payments, partial };
}

export async function getReport(
  db: PrismaClient,
  user: SessionUser,
  opts: { range: { from: Date; to: Date }; label: string; accountId?: string },
): Promise<Report> {
  const companyId = user.companyId!;
  const scope: "ALL" | "PARTNER" = opts.accountId ? "PARTNER" : "ALL";

  // Access scoping is unchanged: PARTNER goes through the getAccount chokepoint (foreign id →
  // 404), ALL is company-scoped.
  let accounts: Account[];
  let accountName: string | undefined;
  if (scope === "PARTNER") {
    const acc = await getAccount(db, user, opts.accountId!);
    if (!acc) throw new NotFoundError("account not in scope");
    accounts = [acc];
    accountName = acc.name;
  } else {
    // Ordered so the partner dedup below has a deterministic winner rather than whatever the DB
    // returns — same as listAccounts() in ./accounts.ts and the cross-company read in
    // src/lib/platform/overview.ts. `id` breaks ties: equal updatedAt values would otherwise
    // hand the win to a different account run to run, moving rows between "counted" and
    // "duplicate partner" in the export for no reason.
    accounts = await db.account.findMany({
      where: { companyId }, orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    });
  }

  // The Partner API takes plain YYYY-MM-DD bounds.
  const dateFrom = opts.range.from.toISOString().slice(0, 10);
  const dateTo = opts.range.to.toISOString().slice(0, 10);

  const [kpis, settlements] = await Promise.all([
    getDashboardStats(db, user, opts.range),
    listCompanySettlements(db, user),
  ]);

  // Resolve credentials for every account up front, synchronously. An account with no partner
  // name (or no resolvable key — no env PARTNER_API_KEY and no per-account override) never
  // touches the network; it's reported as skipped so the export never silently drops a partner.
  // A decrypt failure on a (dormant) per-account override key is isolated the same way,
  // immediately, without attempting the call.
  const resolved: { account: Account; creds: PartnerCredentials }[] = [];
  const statuses: AccountReportStatus[] = [];
  // Defensive dedup by partner name, same reasoning as company-analytics.ts and
  // platform/overview.ts: the partner namespace is global (one shared X-API-Key, so
  // `?partner=<name>` is the same upstream complex for everyone), and every figure below is a
  // plain SUM over accounts — so two accounts pointing at one partner would silently double every
  // total (and duplicate every payment row) in this report. `@@unique([externalPartnerKey])` now
  // prevents that at the DB, so this is defence in depth for rows predating the constraint. First
  // account wins (newest-updated first, id breaking ties); the rest are reported, not hidden.
  const claimed = new Set<string>();
  for (const a of accounts) {
    let creds: PartnerCredentials | null;
    try {
      creds = resolvePartnerCredentials(a);
    } catch {
      statuses.push({ accountId: a.id, accountName: a.name, status: "skipped", reason: "error" });
      continue;
    }
    if (!creds) {
      statuses.push({ accountId: a.id, accountName: a.name, status: "skipped", reason: "not_configured" });
      continue;
    }
    if (claimed.has(creds.partner)) {
      statuses.push({ accountId: a.id, accountName: a.name, status: "skipped", reason: "duplicate_partner" });
      continue;
    }
    claimed.add(creds.partner);
    resolved.push({ account: a, creds });
  }

  const settled = await Promise.allSettled(
    resolved.map(({ creds }) =>
      fetchAllPayments({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        partner: creds.partner,
        dateFrom,
        dateTo,
      }),
    ),
  );

  const liveByAccount = new Map<string, { count: number; amount: number }>();
  const payments: PaymentRow[] = [];

  settled.forEach((res, i) => {
    const a = resolved[i].account;
    if (res.status === "rejected") {
      statuses.push({
        accountId: a.id,
        accountName: a.name,
        status: "skipped",
        reason: skipReason(res.reason),
      });
      return;
    }
    const { summary, payments: rows, partial } = res.value;
    liveByAccount.set(a.id, {
      count: summary.total_payments_count,
      amount: summary.total_payments_amount,
    });
    statuses.push({
      accountId: a.id,
      accountName: a.name,
      status: partial ? "partial" : "ok",
      reason: partial ? "partial" : undefined,
    });
    for (const p of rows) {
      payments.push({
        accountId: a.id,
        accountName: a.name,
        id: p.id,
        userId: p.user_id,
        userName: p.user_name,
        date: p.date,
        amount: p.amount,
        method: p.method,
        category: p.category,
      });
    }
  });

  // Partner rows preserve the existing per-account shape/order (every account is a row, even the
  // skipped ones). Live payment figures merge in where available; skipped/errored accounts show 0
  // and are explained by accountStatuses / the CSV "Skipped accounts" section — never faked.
  const settlementByAccount = new Map(settlements.rows.map((r) => [r.accountId, r]));
  const partnerRows: PartnerRow[] = accounts.map((a) => {
    const live = liveByAccount.get(a.id);
    const s = settlementByAccount.get(a.id);
    return {
      accountId: a.id,
      accountName: a.name,
      paymentsCount: live?.count ?? 0,
      paymentsAmount: live?.amount ?? 0,
      collected: s?.collected ?? 0,
      transferred: s?.transferred ?? 0,
      owed: s?.owed ?? 0,
    };
  });

  return { label: opts.label, scope, accountName, kpis, partnerRows, payments, accountStatuses: statuses };
}

function esc(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

const REASON_LABEL: Record<AccountReportReason, string> = {
  not_configured: "not configured",
  duplicate_partner: "duplicate partner",
  invalid_key: "invalid API key",
  unknown_partner: "unknown partner",
  unavailable: "Partner API unavailable",
  error: "error",
  partial: "payment detail truncated",
};

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
      [r.accountName, r.paymentsCount, r.paymentsAmount, r.collected, r.transferred, r.owed].map(esc).join(","),
    ),
    "",
    "Payments",
    "Account,Payment ID,User ID,User Name,Date,Amount,Method,Category",
    ...report.payments.map((p) =>
      [p.accountName, p.id, p.userId, p.userName, p.date, p.amount, p.method, p.category].map(esc).join(","),
    ),
  ];

  // Report which accounts are missing/incomplete so the export never silently drops a partner.
  const flagged = report.accountStatuses.filter((s) => s.status !== "ok");
  if (flagged.length > 0) {
    lines.push(
      "",
      "Skipped accounts",
      "Account,Reason",
      ...flagged.map((s) =>
        [s.accountName, s.reason ? REASON_LABEL[s.reason] : s.status].map(esc).join(","),
      ),
    );
  }

  return lines.join("\n");
}
