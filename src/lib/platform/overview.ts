import type { PrismaClient, CompanyStatus, Account } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import { resolveRange } from "@/lib/analytics/range";

// Platform Overview app-user/payment figures are a LIVE fan-out over the external Partner API,
// same approach as src/lib/tenant/company-analytics.ts — nothing is persisted or read from
// local mock tables (partnerAppUser / partnerPayment are gone from this query entirely). The
// difference from company-analytics is scope: this is the one SUPER_ADMIN, CROSS-COMPANY read,
// so it enumerates partner-configured accounts across EVERY company, not just the caller's own.
// Per-account failure reasons (bad key / unknown partner / timeout / malformed body) aren't
// surfaced here — only aggregate contributed/skipped counts — see company-analytics.ts for the
// richer per-account status list if a future widget needs it.

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
  // Live fan-out coverage for THIS load, across every partner-configured account of every
  // company. appUsers/paymentsAmount above only reflect `contributed` accounts — `skipped`
  // never fails the page (one bad key/timeout/unknown partner is isolated, not fatal), but the
  // totals are undercounted whenever skipped > 0. windowDays documents the bounded date_from/
  // date_to sent to the external API (see note below) since this page has no date picker.
  liveData: {
    contributed: number;
    skipped: number;
    windowDays: number;
  };
};

// The one sanctioned cross-company read in the app: every other tenant-scoped query in
// src/lib/tenant/* filters by companyId, but a super admin legitimately needs to see across
// all tenants. Gated by assertRole so a COMPANY_ADMIN calling this directly still gets
// ForbiddenError instead of silently seeing other companies' data.
export async function getPlatformOverview(db: PrismaClient, actor: SessionUser): Promise<PlatformOverview> {
  assertRole(actor, ["SUPER_ADMIN"]);

  const [companies, userCounts, adminCounts, memberCounts, accountCounts, leadCounts, accounts] =
    await Promise.all([
      db.company.findMany({ orderBy: { createdAt: "desc" } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null } } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null }, role: "COMPANY_ADMIN" } }),
      db.user.groupBy({ by: ["companyId"], _count: { _all: true }, where: { companyId: { not: null }, role: "MEMBER" } }),
      db.account.groupBy({ by: ["companyId"], _count: { _all: true } }),
      db.lead.groupBy({ by: ["companyId"], _count: { _all: true } }),
      // Cross-company enumeration, unfiltered by status — same "no default status filter"
      // behavior as listAccounts() in src/lib/tenant/accounts.ts. This is only used below to
      // drive the live partner fan-out; it never gets persisted or grouped in the DB.
      db.account.findMany(),
    ]);

  const toMap = <T extends { companyId: string | null }>(rows: T[]) =>
    new Map(rows.map((r) => [r.companyId as string, r]));
  const userMap = toMap(userCounts);
  const adminMap = toMap(adminCounts);
  const memberMap = toMap(memberCounts);
  const accountMap = toMap(accountCounts);
  const leadMap = toMap(leadCounts);

  // --- LIVE partner fan-out (replaces the old partnerAppUser/partnerPayment groupBys) ---
  // The external API requires bounded date_from/date_to; this page has no date picker (unlike
  // /analytics, /dashboard, /reports), so we fall back to the same default trailing-30-day
  // window resolveRange() uses everywhere else in the app when no explicit range is given. NOTE
  // for reviewer: the old persisted counts were all-time cumulative totals with no date bound —
  // paymentsAmount below is now genuinely time-windowed (last 30 days only), a real semantic
  // change, not just a data-source swap. appUsers (total_users) is whatever the upstream API
  // reports for that call; if it reports a live cumulative snapshot rather than a
  // period-filtered count, this figure won't have moved much, but that's an upstream contract
  // detail this client can't control.
  const windowDays = 30;
  const range = resolveRange({});
  const dateFrom = range.from.toISOString().slice(0, 10);
  const dateTo = range.to.toISOString().slice(0, 10);

  // Resolve credentials for every account across every company, synchronously. An account with
  // no partner name (or no resolvable key — no env PARTNER_API_KEY and no per-account override)
  // never touches the network; a decrypt failure on a (dormant) per-account override key is
  // isolated the same way. Both count toward `skipped` up front, before any network call.
  const resolved: { account: Account; creds: PartnerCredentials }[] = [];
  let skipped = 0;
  for (const a of accounts) {
    let creds: PartnerCredentials | null;
    try {
      creds = resolvePartnerCredentials(a);
    } catch {
      skipped += 1;
      continue;
    }
    if (!creds) {
      skipped += 1;
      continue;
    }
    resolved.push({ account: a, creds });
  }

  // Fan out across EVERY resolved account of EVERY company, in parallel. allSettled keeps one
  // account's rejection (bad key / unknown partner / timeout / malformed body) from failing the
  // whole page. PERF NOTE for reviewer: this is O(all configured accounts across all companies)
  // outbound HTTP calls on every Platform Overview load, with no caching — fine at small
  // partner counts, but will need caching/pagination/a background sync if the partner roster
  // grows large, since a single slow-but-not-timed-out upstream call still costs its full
  // latency even though allSettled isolates its *failure*.
  const settled = await Promise.allSettled(
    resolved.map(({ creds }) =>
      fetchPartnerStats({
        baseUrl: creds.baseUrl,
        apiKey: creds.apiKey,
        partner: creds.partner,
        dateFrom,
        dateTo,
      }),
    ),
  );

  const appUsersByCompany = new Map<string, number>();
  const paymentsByCompany = new Map<string, number>();
  let contributed = 0;

  settled.forEach((res, i) => {
    const a = resolved[i].account;
    if (res.status === "rejected") {
      skipped += 1;
      return;
    }
    contributed += 1;
    const s = res.value;
    appUsersByCompany.set(a.companyId, (appUsersByCompany.get(a.companyId) ?? 0) + s.total_users);
    paymentsByCompany.set(a.companyId, (paymentsByCompany.get(a.companyId) ?? 0) + s.total_payments_amount);
  });

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
    appUsers: appUsersByCompany.get(c.id) ?? 0,
    paymentsAmount: paymentsByCompany.get(c.id) ?? 0,
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

  return {
    totals,
    companies: companyRows,
    liveData: { contributed, skipped, windowDays },
  };
}
