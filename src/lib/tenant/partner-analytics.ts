import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import { InvalidApiKeyError, UnknownPartnerError } from "@/lib/partner-api/errors";
import type { PartnerStatsResponse } from "@/lib/partner-api/schema";

// LIVE-ONLY analytics for a single account. Every value here is fetched per request from the
// external Partner API and mapped straight to a DTO — NOTHING is persisted, cached, or read from
// a local table. The decrypted apiKey never leaves this module: it goes only to fetchPartnerStats
// (which puts it in the X-API-Key header) and is never placed on any DTO returned to the client.

export type AnalyticsStatus =
  | "ok"
  | "not-configured" // account has no partner name and/or no resolvable API key — never call the API
  | "invalid-key" // upstream rejected the API key (HTTP 401)
  | "unknown-partner" // upstream does not recognize this partner (HTTP 404)
  | "unavailable"; // network / timeout / 5xx / malformed body / decrypt failure

type MethodRow = { method: string; amount: number };
type CategoryRow = { category: string; amount: number };

export type AccountAnalytics = {
  status: AnalyticsStatus;
  kpis: {
    activeUsers: number;
    totalUsers: number;
    totalDebt: number; // current debt snapshot from `total_debt` (the historical debt trend is gone)
    paymentsCount: number;
    paymentsAmount: number;
    utilityCount: number;
    utilityAmount: number;
  };
  installs: {
    total: number; // `total_installations` — the frontend labels this "Active on App"
    ios: number;
    android: number;
    activated: number;
    activationRate: number;
  };
  byMethod: MethodRow[];
  byCategory: CategoryRow[]; // five categories: APARTMENT | PARKING | PROPERTY | OFFICE | UTILITY
};

export type AccountPayments = {
  status: AnalyticsStatus;
  rows: {
    id: string;
    occurredAt: string;
    amount: number;
    method: string;
    category: string;
    userName: string;
  }[];
  total: number;
  page: number;
  pageCount: number;
};

// The partner API takes `YYYY-MM-DD` calendar bounds; our resolved range is a pair of Dates.
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// invalid-key / unknown-partner are surfaced verbatim so the UI can guide the fix; everything
// else (network, timeout, 5xx, non-JSON, zod validation, or a decrypt failure) collapses to a
// single "unavailable". No cause is ever echoed onward — it may carry the URL or secret material.
function statusForError(e: unknown): AnalyticsStatus {
  if (e instanceof InvalidApiKeyError) return "invalid-key";
  if (e instanceof UnknownPartnerError) return "unknown-partner";
  return "unavailable";
}

function emptyAnalytics(status: AnalyticsStatus): AccountAnalytics {
  return {
    status,
    kpis: { activeUsers: 0, totalUsers: 0, totalDebt: 0, paymentsCount: 0, paymentsAmount: 0, utilityCount: 0, utilityAmount: 0 },
    installs: { total: 0, ios: 0, android: 0, activated: 0, activationRate: 0 },
    byMethod: [],
    byCategory: [],
  };
}

function mapStats(s: PartnerStatsResponse): AccountAnalytics {
  const activationRate =
    s.total_installations > 0 ? Math.round((s.logged_in_users / s.total_installations) * 1000) / 10 : 0;
  return {
    status: "ok",
    kpis: {
      activeUsers: s.active_users,
      totalUsers: s.total_users,
      totalDebt: s.total_debt,
      paymentsCount: s.total_payments_count,
      paymentsAmount: s.total_payments_amount,
      utilityCount: s.utility_payments_count,
      utilityAmount: s.utility_payments_amount,
    },
    installs: {
      total: s.total_installations,
      ios: s.ios_installations,
      android: s.android_installations,
      activated: s.logged_in_users,
      activationRate,
    },
    // Only per-method / per-category AMOUNTS are exposed by the aggregate endpoint (no counts),
    // and the breakdown UI renders amounts only.
    byMethod: [
      { method: "CARD", amount: s.amount_by_card },
      { method: "MANUAL", amount: s.amount_by_manual },
      { method: "CASH", amount: s.amount_by_cash },
    ],
    byCategory: [
      { category: "APARTMENT", amount: s.apartment_payments_amount },
      { category: "PARKING", amount: s.parking_payments_amount },
      { category: "PROPERTY", amount: s.property_payments_amount },
      { category: "OFFICE", amount: s.office_payments_amount },
      { category: "UTILITY", amount: s.utility_payments_amount },
    ],
  };
}

export async function getAccountAnalytics(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
  range: { from: Date; to: Date },
): Promise<AccountAnalytics> {
  const acc = await getAccount(db, user, accountId); // tenancy chokepoint: foreign account -> null
  if (!acc) throw new NotFoundError("account not in scope");

  // THIS IS A PURE READ. It used to end with a WRITE hiding inside it — tryAutoLink, which
  // re-resolved the account's name against the live upstream list and set externalPartnerKey, the
  // one field that decides which complex's debt, payments and unit-level owner names/phones an
  // account may read. It existed only to recover a link lost to a Django outage at creation time,
  // which the approval gate makes impossible (the create path no longer calls the upstream at
  // all), so it is gone along with the upstream fan-out it fired on every refresh of this tab.
  //
  // A PENDING link reaches resolvePartnerCredentials and comes back null, exactly like no link at
  // all, so this returns "not-configured" until it is confirmed on /partner-links — by the
  // account team's own admin, or by the owner.

  let creds: PartnerCredentials | null;
  try {
    creds = resolvePartnerCredentials(acc);
  } catch {
    return emptyAnalytics("unavailable"); // decrypt failure — do not leak the cause
  }
  if (!creds) return emptyAnalytics("not-configured");

  try {
    // pageSize 1: this endpoint only needs the range-wide aggregates (which are independent of
    // pagination); the payments page itself is served by listAccountPayments.
    const stats = await fetchPartnerStats({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      partner: creds.partner,
      dateFrom: isoDate(range.from),
      dateTo: isoDate(range.to),
      page: 1,
      pageSize: 1,
    });
    return mapStats(stats);
  } catch (e) {
    return emptyAnalytics(statusForError(e));
  }
}

export async function listAccountPayments(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
  opts: { from: Date; to: Date; page?: number; pageSize?: number },
): Promise<AccountPayments> {
  const acc = await getAccount(db, user, accountId);
  // Fail closed: a foreign / out-of-scope account yields an empty page, never another partner's
  // transactions.
  if (!acc) return { status: "not-configured", rows: [], total: 0, page: opts.page ?? 1, pageCount: 0 };

  let creds: PartnerCredentials | null;
  try {
    creds = resolvePartnerCredentials(acc);
  } catch {
    return { status: "unavailable", rows: [], total: 0, page: opts.page ?? 1, pageCount: 0 };
  }
  if (!creds) return { status: "not-configured", rows: [], total: 0, page: opts.page ?? 1, pageCount: 0 };

  try {
    const stats = await fetchPartnerStats({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      partner: creds.partner,
      dateFrom: isoDate(opts.from),
      dateTo: isoDate(opts.to),
      page: opts.page,
      pageSize: opts.pageSize,
    });
    return {
      status: "ok",
      rows: stats.payments.map((p) => ({
        id: p.id,
        occurredAt: p.date,
        amount: p.amount,
        method: p.method,
        category: p.category,
        userName: p.user_name,
      })),
      total: stats.payments_total_count,
      page: stats.payments_page,
      pageCount: stats.payments_page_count,
    };
  } catch (e) {
    return { status: statusForError(e), rows: [], total: 0, page: opts.page ?? 1, pageCount: 0 };
  }
}
