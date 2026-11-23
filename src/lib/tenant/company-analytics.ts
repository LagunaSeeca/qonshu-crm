import type { PrismaClient, Account } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { listAccounts, getAccount } from "./accounts";
import { fetchAllPayments, countUniquePayers, type AllPayments } from "./partner-payments";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "@/lib/partner-api/errors";

// Company-wide analytics as a LIVE fan-out. Nothing is persisted or read from local mock
// tables: for every partner-configured account we call the external Partner API once for the
// selected range and aggregate the per-account summaries in memory. One account failing (bad
// key, unknown partner, timeout, malformed body) is isolated and reported — never fatal.

// Fixed display order for the aggregate breakdowns. Methods mirror the API's per-method amount
// fields; categories are the five unit types the API reports — PROPERTY and OFFICE included
// alongside the residential three.
const METHOD_ORDER = ["CARD", "MANUAL", "CASH"] as const;
const CATEGORY_ORDER = ["APARTMENT", "PARKING", "PROPERTY", "OFFICE", "UTILITY"] as const;
type MethodKey = (typeof METHOD_ORDER)[number];
type CategoryKey = (typeof CATEGORY_ORDER)[number];

export type AccountSkipReason =
  | "not_configured"
  | "duplicate_partner"
  | "invalid_key"
  | "unknown_partner"
  | "unavailable"
  | "error";

export type AccountFetchStatus = {
  accountId: string;
  accountName: string;
  status: "ok" | "skipped";
  reason?: AccountSkipReason;
};

type PartnerRow = {
  accountId: string;
  accountName: string;
  appUsers: number;
  installs: number;
  engagedUsers: number;
  paymentsCount: number;
  paymentsAmount: number;
};

// Map a per-account failure to a stable, secret-free reason for the status list. Covers the
// typed Partner API errors plus decrypt/zod-validation failures (the catch-all "error").
function skipReason(err: unknown): AccountSkipReason {
  if (err instanceof InvalidApiKeyError) return "invalid_key";
  if (err instanceof UnknownPartnerError) return "unknown_partner";
  if (err instanceof PartnerApiUnavailableError) return "unavailable";
  return "error";
}

export async function getCompanyAnalytics(
  db: PrismaClient,
  user: SessionUser,
  range: { from: Date; to: Date },
  // `includePayments` makes the fan-out's raw per-account results available to the caller via
  // `paymentsByAccount` INSTEAD OF the caller paging the same partner/range a second time. It is
  // opt-in because the rows carry payer identity (user_id / user_name): only a caller that gates
  // detail on `view_payment_detail` may ask for them (today: getReport). Nothing is persisted.
  opts?: { accountId?: string; includePayments?: boolean },
) {
  // Scope resolution — same chokepoint rules as before: PARTNER_VIEWER is pinned to their own
  // account (a sentinel that matches nothing when unset → fail closed); admin/member may pass
  // an optional single-account filter, validated through getAccount so a foreign id 404s
  // upstream instead of silently widening to company-wide.
  // Every branch resolves through a scope-aware reader (listAccounts / getAccount, both built on
  // accountScopeWhere), so the fan-out below can only reach accounts the caller may see: a member
  // their managed accounts, a team admin their team, a partner exactly their own account.
  let accounts: Account[];
  if (user.role === "PARTNER_VIEWER") {
    accounts = await listAccounts(db, user); // pinned to user.accountId; empty when unset
  } else if (opts?.accountId) {
    const acc = await getAccount(db, user, opts.accountId);
    if (!acc) throw new NotFoundError("account not in scope");
    accounts = [acc];
  } else {
    accounts = await listAccounts(db, user);
  }

  // The Partner API takes plain YYYY-MM-DD bounds.
  const dateFrom = range.from.toISOString().slice(0, 10);
  const dateTo = range.to.toISOString().slice(0, 10);

  // Resolve credentials for every account up front, synchronously. An account with no partner
  // name (or no resolvable key — no env PARTNER_API_KEY and no per-account override) never
  // touches the network; it's reported as skipped so the page can explain why it's absent from
  // the totals. A decrypt failure on a (dormant) per-account override key is isolated the same
  // way, immediately, without attempting the call.
  const resolved: { account: Account; creds: PartnerCredentials }[] = [];
  const statuses: AccountFetchStatus[] = [];
  // Defensive dedup by partner name. The partner namespace is global (one shared X-API-Key, so
  // `?partner=<name>` is the same upstream complex for everyone), and every figure below is a
  // plain SUM over accounts — so two accounts pointing at one partner would silently double every
  // total on this page. `@@unique([externalPartnerKey])` now prevents that at the DB, so this is
  // defence in depth for rows predating the constraint. First account wins (listAccounts() hands
  // them over newest-updated first, with id breaking ties); the rest are reported, not hidden.
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

  // Fan out across every resolved account IN PARALLEL. allSettled keeps one account's rejection
  // (bad key / unknown partner / timeout / malformed body) from failing the batch, and preserves
  // order so settled[i] lines up with resolved[i].
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

  // Aggregators seeded to zero so an all-skipped company still yields a valid, empty page.
  const totals = {
    accounts: 0,
    appUsers: 0,
    activeUsers: 0,
    uniquePayingUsers: 0,
    uniquePayingUsersPartial: false, // true when payment paging was truncated, so the count is a floor
    engagedUsers: 0,
    totalDebt: 0,
    installs: 0,
    iosInstalls: 0,
    androidInstalls: 0,
    loggedInUsers: 0,
    activationRate: 0,
    paymentsCount: 0,
    paymentsAmount: 0,
    utilityCount: 0,
    utilityAmount: 0,
  };
  const methodAmounts: Record<MethodKey, number> = { CARD: 0, MANUAL: 0, CASH: 0 };
  const categoryAmounts: Record<CategoryKey, number> = {
    APARTMENT: 0,
    PARKING: 0,
    PROPERTY: 0,
    OFFICE: 0,
    UTILITY: 0,
  };
  const partners: PartnerRow[] = [];
  // Keyed by accountId and keeping the SETTLED result (rejections included) so a second consumer
  // reproduces this fan-out's outcome — successes, per-error reasons and `partial` alike —
  // without re-issuing a single upstream request. Null unless the caller asked for it.
  const paymentsByAccount: Map<string, PromiseSettledResult<AllPayments>> | null =
    opts?.includePayments ? new Map() : null;

  settled.forEach((res, i) => {
    const a = resolved[i].account;
    paymentsByAccount?.set(a.id, res);
    if (res.status === "rejected") {
      statuses.push({
        accountId: a.id,
        accountName: a.name,
        status: "skipped",
        reason: skipReason(res.reason),
      });
      return;
    }
    const s = res.value.summary;
    statuses.push({ accountId: a.id, accountName: a.name, status: "ok" });

    totals.accounts += 1;
    totals.appUsers += s.total_users;
    // "Active users" = users active ON THE APP = the API's logged_in_users (NOT active_users).
    totals.activeUsers += s.logged_in_users;
    // DISTINCT online (CARD) payers in the requested range, summed per account (user ids are
    // per-partner, so they never merge across accounts). Count only — no ids leave this module.
    totals.uniquePayingUsers += countUniquePayers(res.value.payments);
    if (res.value.partial) totals.uniquePayingUsersPartial = true;
    totals.engagedUsers += s.engaged_users;
    totals.totalDebt += s.total_debt;
    totals.installs += s.total_installations;
    totals.iosInstalls += s.ios_installations;
    totals.androidInstalls += s.android_installations;
    totals.loggedInUsers += s.logged_in_users;
    totals.paymentsCount += s.total_payments_count;
    totals.paymentsAmount += s.total_payments_amount;
    totals.utilityCount += s.utility_payments_count;
    totals.utilityAmount += s.utility_payments_amount;

    methodAmounts.CARD += s.amount_by_card;
    methodAmounts.MANUAL += s.amount_by_manual;
    methodAmounts.CASH += s.amount_by_cash;

    categoryAmounts.APARTMENT += s.apartment_payments_amount;
    categoryAmounts.PARKING += s.parking_payments_amount;
    categoryAmounts.PROPERTY += s.property_payments_amount;
    categoryAmounts.OFFICE += s.office_payments_amount;
    categoryAmounts.UTILITY += s.utility_payments_amount;

    partners.push({
      accountId: a.id,
      accountName: a.name,
      appUsers: s.total_users,
      installs: s.total_installations,
      engagedUsers: s.engaged_users,
      paymentsCount: s.total_payments_count,
      paymentsAmount: s.total_payments_amount,
    });
  });

  // Activation rate from the summed totals (not averaged per account) so it stays a true
  // company-wide logged-in / installs ratio; one decimal place, guarded against /0.
  totals.activationRate =
    totals.installs > 0 ? Math.round((totals.loggedInUsers / totals.installs) * 1000) / 10 : 0;

  const byMethod = METHOD_ORDER.map((method) => ({ method, amount: methodAmounts[method] }));
  const byCategory = CATEGORY_ORDER.map((category) => ({ category, amount: categoryAmounts[category] }));
  partners.sort((a, b) => b.paymentsAmount - a.paymentsAmount);

  const contributed = totals.accounts;
  const skipped = statuses.filter((st) => st.status === "skipped").length;

  return {
    totals,
    byMethod,
    byCategory,
    partners,
    accountStatuses: statuses,
    contributed,
    skipped,
    // Opt-in (see `includePayments`). Null for every page that only needs the aggregates, so no
    // payment row — and no Map, which would not survive serialization — reaches RSC props.
    paymentsByAccount,
  };
}

export type CompanyAnalytics = Awaited<ReturnType<typeof getCompanyAnalytics>>;
