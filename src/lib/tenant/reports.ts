import type { PrismaClient, Account } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError, can } from "@/lib/auth/guards";
import { getAccount, listAccounts } from "./accounts";
import { getDashboardStats, type DashboardStats } from "./dashboard";
import { listCompanySettlements } from "./settlements";
import { fetchAllPayments } from "./partner-payments";
import { getCompanyAnalytics } from "./company-analytics";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "@/lib/partner-api/errors";
import type {
  PaymentMethod,
  PaymentCategory,
  PartnerPayment,
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
  // Settlement figures (live card takings + the company's own transfer ledger). PRESENT ONLY when
  // the caller can("view_settlements"); for a MEMBER the keys are absent from the row entirely —
  // not 0 — so they are absent from the JSON, the CSV and the RSC props. Same rule as `payments`.
  //
  // `collected`/`owed` are ALSO absent for an account whose card total could not be established
  // (see AccountSettlement.collected): a 0 there is a money figure a reader would act on. A
  // consumer must render the absence as "unknown", never as 0 or a blank cell.
  collected?: number;
  transferred?: number;
  owed?: number;
  /**
   * Which side holds this building's money. Present on the same terms as the three figures above.
   *
   * THIS IS WHY A BLANK `owed` IS NOT ALWAYS "UNKNOWN". For a SELF building Qonshu holds nothing
   * and therefore owes nothing, so the settlement service omits `owed` BY DESIGN rather than
   * because a fetch failed — two very different absences that would otherwise render identically.
   * A consumer showing `owed` must show this alongside it, or a reader will take the blank for
   * zero owed on a building that simply is not settled through Qonshu at all.
   */
  collectionMode?: "QONSHU" | "SELF";
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
  // Row-level payment detail (payer name, amount, method). PRESENT ONLY when the caller
  // can("view_payment_detail"); for a MEMBER the key is absent from the object entirely, so it is
  // absent from the JSON, the CSV and the RSC props. Never `[]` — absent means "not permitted".
  payments?: PaymentRow[];
  accountStatuses: AccountReportStatus[];
};

// Map a per-account failure to a stable, secret-free reason.
function skipReason(err: unknown): AccountReportReason {
  if (err instanceof InvalidApiKeyError) return "invalid_key";
  if (err instanceof UnknownPartnerError) return "unknown_partner";
  if (err instanceof PartnerApiUnavailableError) return "unavailable";
  return "error";
}

export async function getReport(
  db: PrismaClient,
  user: SessionUser,
  opts: { range: { from: Date; to: Date }; label: string; accountId?: string },
): Promise<Report> {
  // Decided once, here in the service: the server page calls getReport directly, so a route-level
  // gate would not protect the RSC props. Payment rows are never even assembled for a member.
  const withDetail = can(user, "view_payment_detail");
  // Same reasoning for the cash figures: listCompanySettlements asserts view_settlements, which a
  // MEMBER does not hold, so calling it unconditionally made a member's whole report throw rather
  // than render the general statistics they may see. Skipped, not merely hidden.
  const withSettlements = can(user, "view_settlements");
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
    // Scoped (member = managed accounts, team admin = team) and ordered updatedAt desc, id asc.
    accounts = await listAccounts(db, user);
  }

  // The Partner API takes plain YYYY-MM-DD bounds.
  const dateFrom = opts.range.from.toISOString().slice(0, 10);
  const dateTo = opts.range.to.toISOString().slice(0, 10);

  // ONE live fan-out for the whole report. getDashboardStats would otherwise run
  // getCompanyAnalytics itself, and the row-level pass below used to page every partner a SECOND
  // time for the identical partner+range — ~40 upstream requests per account per render. The
  // analytics call keeps the per-account results (`includePayments`) and both consumers read them.
  //
  // `accountId` IS FORWARDED. Without it a single-account report took getCompanyAnalytics'
  // all-accounts branch: the header named one partner while every KPI below it described every
  // account in the caller's scope, and the live fan-out hit every partner to produce numbers the
  // report then never showed. `accounts` above is already narrowed to exactly this account, so
  // the analytics scope now matches the report's scope. (A PARTNER_VIEWER is pinned to their own
  // account inside getCompanyAnalytics regardless, so this is a no-op for them.)
  //
  // `includePayments` IS GATED ON view_payment_detail. The option hands back the raw payment rows,
  // which carry payer identity (user_id / user_name); its contract is that only a caller gating
  // detail on that permission may ask for them. A member's report discards the rows further down
  // (`if (!withDetail) return;`), so asking for them was a contract violation waiting to become a
  // leak the first time anything returned or logged `analytics`. The aggregates a member's report
  // still shows come from the page-1 summary, not the rows, so no figure changes.
  const analytics = await getCompanyAnalytics(db, user, opts.range, {
    ...(opts.accountId ? { accountId: opts.accountId } : {}),
    includePayments: withDetail,
  });
  const [kpis, settlements] = await Promise.all([
    getDashboardStats(db, user, opts.range, { analytics }),
    // The settlement figures must cover the REPORTED range, not the current month: called without
    // a period, listCompanySettlements defaults to currentSettlementPeriod(), which put this
    // month's Collected/Transferred/Owed next to (say) Q1's payment columns in one unlabelled row.
    withSettlements
      ? listCompanySettlements(db, user, { from: opts.range.from, to: opts.range.to })
      : null,
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

  // What this report needs to know about each account, assembled from the ONE fan-out above.
  // `rows` is empty for a caller without view_payment_detail — not a claim that the account took
  // no payments (the figures beside it are the page-1 summary totals, which cover the FULL range);
  // the rows are discarded for that caller further down regardless.
  type AccountOutcome =
    | { ok: true; count: number; amount: number; partial: boolean; rows: PartnerPayment[] }
    | { ok: false; reason: AccountReportReason };

  // EXACTLY ONE UPSTREAM FAN-OUT PER RENDER, FOR EVERY ROLE.
  //
  // With view_payment_detail the per-account rows come out of `analytics.paymentsByAccount`. A
  // caller WITHOUT it gets that map as null on purpose (it carries payer identity — see the
  // getCompanyAnalytics call above), so the per-account FIGURES are read off the same fan-out's
  // other outputs instead: `analytics.partners` (count/amount, both from the page-1 summary),
  // `analytics.accountStatuses` (per-account success / skip reason) and
  // `analytics.partialByAccount` (whether paging truncated). None of those holds a payment row, a
  // user_id or a user_name, so handing them to a MEMBER leaks nothing.
  //
  // Falling through to the per-account fetch below for a member instead would re-page EVERY
  // account — two full fan-outs per report. At ~30 linked accounts that was already over the
  // Vercel function timeout before the paymentsByAccount reuse landed, and members (sales
  // managers) are the heaviest users of /reports. So the no-detail path must never refetch.
  const cached = analytics.paymentsByAccount;
  const analyticsPartnerById = new Map(analytics.partners.map((p) => [p.accountId, p]));
  const analyticsStatusById = new Map(analytics.accountStatuses.map((s) => [s.accountId, s]));

  const outcomes: AccountOutcome[] = await Promise.all(
    resolved.map(async ({ account, creds }): Promise<AccountOutcome> => {
      const hit = cached?.get(account.id);
      if (hit) {
        if (hit.status === "rejected") return { ok: false, reason: skipReason(hit.reason) };
        return {
          ok: true,
          count: hit.value.summary.total_payments_count,
          amount: hit.value.summary.total_payments_amount,
          partial: hit.value.partial,
          rows: hit.value.payments,
        };
      }
      // No rows map: same fan-out, aggregates only. AccountSkipReason is a subset of
      // AccountReportReason, so the upstream failure reason survives verbatim rather than
      // collapsing to a generic "error" — and `partial` survives too, which is the whole point of
      // partialByAccount.
      const st = analyticsStatusById.get(account.id);
      if (!cached && st) {
        if (st.status === "skipped") return { ok: false, reason: st.reason ?? "error" };
        const p = analyticsPartnerById.get(account.id);
        return {
          ok: true,
          count: p?.paymentsCount ?? 0,
          amount: p?.paymentsAmount ?? 0,
          partial: analytics.partialByAccount.get(account.id) ?? false,
          rows: [],
        };
      }
      // Last resort: an account the analytics scope did not cover at all. With opts.accountId now
      // forwarded, both go through the same scope readers, so this should be unreachable — it is
      // kept so a future scope divergence costs an extra request instead of dropping a row.
      try {
        const all = await fetchAllPayments({
          baseUrl: creds.baseUrl,
          apiKey: creds.apiKey,
          partner: creds.partner,
          dateFrom,
          dateTo,
        });
        return {
          ok: true,
          count: all.summary.total_payments_count,
          amount: all.summary.total_payments_amount,
          partial: all.partial,
          rows: all.payments,
        };
      } catch (reason) {
        return { ok: false, reason: skipReason(reason) };
      }
    }),
  );

  const liveByAccount = new Map<string, { count: number; amount: number }>();
  const payments: PaymentRow[] = [];

  outcomes.forEach((res, i) => {
    const a = resolved[i].account;
    if (!res.ok) {
      statuses.push({ accountId: a.id, accountName: a.name, status: "skipped", reason: res.reason });
      return;
    }
    liveByAccount.set(a.id, { count: res.count, amount: res.amount });
    statuses.push({
      accountId: a.id,
      accountName: a.name,
      status: res.partial ? "partial" : "ok",
      reason: res.partial ? "partial" : undefined,
    });
    if (!withDetail) return;
    for (const p of res.rows) {
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
  const settlementByAccount = new Map((settlements?.rows ?? []).map((r) => [r.accountId, r]));
  const partnerRows: PartnerRow[] = accounts.map((a) => {
    const live = liveByAccount.get(a.id);
    const s = settlementByAccount.get(a.id);
    return {
      accountId: a.id,
      accountName: a.name,
      paymentsCount: live?.count ?? 0,
      paymentsAmount: live?.amount ?? 0,
      // Absent (not 0) for a caller without view_settlements, AND absent when the figure itself
      // could not be established. `s?.collected ?? 0` used to reinstate here exactly the
      // fabricated ₼0 the settlement service now refuses to produce: an account whose card total
      // could not be fetched printed "₼0 collected" in the report and the CSV, with `owed`
      // inflated to match. Transferred is our own ledger, so it is known whenever the row is.
      ...(settlements && s
        ? {
            transferred: s.transferred,
            collectionMode: s.collectionMode,
            ...(s.collected !== undefined ? { collected: s.collected } : {}),
            ...(s.owed !== undefined ? { owed: s.owed } : {}),
          }
        : {}),
    };
  });

  return {
    label: opts.label,
    scope,
    accountName,
    kpis,
    partnerRows,
    ...(withDetail ? { payments } : {}),
    accountStatuses: statuses,
  };
}

function esc(v: string | number): string {
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// A cash cell whose figure could not be established. The word is deliberate: `0` and an empty
// cell both read as "this partner collected nothing", which is a different and false statement,
// and the bare `r.collected!` this replaces would have printed the string "undefined" once the
// service started omitting the key. Spreadsheet software will not silently total a text cell
// either, which is the right outcome for a column that is missing a value.
const UNKNOWN_CASH = "unknown";
const cashCell = (n: number | undefined): string | number => (n === undefined ? UNKNOWN_CASH : n);

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
  // A report assembled for a caller without view_settlements carries no cash figures at all, so
  // the export drops those rows/columns rather than printing blanks — an empty Collected cell
  // reads as "collected nothing", which is a different (and false) statement.
  const withSettlements = k.finance.collected !== undefined;
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
    `Active on app,${esc(k.partners.activeAppUsers)}`,
    `Unique paying users,${esc(k.partners.uniquePayingUsers)}`,
    `Users engaged,${esc(k.partners.engagedUsers)}`,
    `Payments amount,${esc(k.partners.paymentsAmount)}`,
    `App installs,${esc(k.partners.appInstalls)}`,
    `Installs iOS,${esc(k.partners.installsIos)}`,
    `Installs Android,${esc(k.partners.installsAndroid)}`,
    ...(withSettlements
      ? [
          // "Qonshu-held", not a bare "Collected": the figure excludes self-collecting buildings,
          // so an unqualified label invites a month-on-month comparison that reads a building
          // switching to SELF as lost revenue.
          `Collected (Qonshu-held),${esc(k.finance.collected!)}`,
          `Transferred,${esc(k.finance.transferred!)}`,
          `Owed,${esc(k.finance.owed!)}`,
          `Collected by self-collecting buildings,${esc(k.finance.selfCollected ?? 0)}`,
        ]
      : []),
    `Service fees outstanding,${esc(k.finance.serviceFeesOutstanding)}`,
    "",
    withSettlements
      ? "Partner,Payments,Payments Amount,Collected,Transferred,Owed,Settled via"
      : "Partner,Payments,Payments Amount",
    ...report.partnerRows.map((r) =>
      [
        r.accountName,
        r.paymentsCount,
        r.paymentsAmount,
        ...(withSettlements
          ? [
              cashCell(r.collected),
              cashCell(r.transferred),
              cashCell(r.owed),
              // Disambiguates the blank `owed` above: "Self-collecting" means nothing is owed by
              // design, whereas a blank with "Qonshu" means the card total could not be fetched.
              r.collectionMode === "SELF"
                ? "Self-collecting"
                : r.collectionMode === "QONSHU"
                  ? "Qonshu"
                  : "",
            ]
          : []),
      ]
        .map(esc)
        .join(","),
    ),
  ];

  // Payments section only exists when the report carries it (view_payment_detail holders).
  if (report.payments) {
    lines.push(
      "",
      "Payments",
      "Account,Payment ID,User ID,User Name,Date,Amount,Method,Category",
      ...report.payments.map((p) =>
        [p.accountName, p.id, p.userId, p.userName, p.date, p.amount, p.method, p.category].map(esc).join(","),
      ),
    );
  }

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
