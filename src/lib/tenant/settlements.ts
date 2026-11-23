import type { Account, PrismaClient, SettlementEntry, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError, assertCan } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { accountScopeWhere } from "./scope";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import { InvalidApiKeyError, UnknownPartnerError } from "@/lib/partner-api/errors";

// SETTLEMENTS = what Qonshu owes a partner, for one PERIOD.
//
//   Collected    the partner API's `amount_by_card` for the period — CARD PAYMENTS ONLY, fetched
//                live, never persisted.
//   Transferred  the manual transfer rows WE record, whose `occurredAt` falls in the same period.
//   Remaining    Collected - Transferred.
//
// WHY amount_by_card AND NOT total_payments_amount: cash the building collected directly never
// passes through Qonshu. It is already in the building's hands, so including it would overstate
// what Qonshu owes — `total_payments_amount` (card + manual + cash) is the wrong number here and
// must not be substituted for `amount_by_card` by a later edit.
//
// NOTHING FROM THE PARTNER API IS PERSISTED. Our DB stores only the manual transfer rows; every
// Collected figure is a per-request read of the upstream. The COLLECTED value of SettlementType
// still exists in the schema (no migration drops it) but is DEAD: nothing writes it, and every
// computation below filters to `type: "TRANSFER"`, so a legacy COLLECTED row is ignored rather
// than double-counted against the live card total.
//
// GATING LIVES HERE, IN THE SERVICE, NOT ONLY IN THE ROUTE HANDLERS. Server components call
// these functions directly and hand the result to client components as props, so a gate that
// sits only in `/api/...` still ships the numbers to the browser on the page render. Reads
// require `view_settlements` (which excludes MEMBER); writes require `write_settlements`, i.e.
// SUPER_ADMIN alone — a COMPANY_ADMIN write throws ForbiddenError.

const num = (d: { toNumber: () => number }) => d.toNumber();
const METHODS: SettlementMethod[] = ["CASH", "BANK_TRANSFER", "MANUAL"];

const sumAmount = (rows: SettlementEntry[]) => rows.reduce((s, r) => s + num(r.amount), 0);
const sumByMethod = (rows: SettlementEntry[]): Record<SettlementMethod, number> =>
  Object.fromEntries(METHODS.map((m) => [m, sumAmount(rows.filter((r) => r.method === m))])) as Record<
    SettlementMethod,
    number
  >;

// The period a settlement is computed over. Both bounds are INCLUSIVE, because the upstream takes
// inclusive YYYY-MM-DD calendar bounds and the transfer query has to cover exactly the same days.
export type SettlementPeriod = { from: Date; to: Date };

// Settlements are reckoned by calendar month, so an omitted period means THIS month (UTC), from
// the 1st at 00:00:00.000 to the last millisecond of the last day.
export function currentSettlementPeriod(now: Date = new Date()): SettlementPeriod {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)),
    to: new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999)),
  };
}

// Parses the `from`/`to` query pair (YYYY-MM-DD, inclusive) a route may carry; both missing means
// the current month. Throws RangeError on an unparseable or inverted pair rather than silently
// widening the window.
export function resolveSettlementPeriod(
  input: { from?: string | null; to?: string | null },
  now: Date = new Date(),
): SettlementPeriod {
  if (!input.from && !input.to) return currentSettlementPeriod(now);
  const from = new Date(`${input.from}T00:00:00.000Z`);
  const to = new Date(`${input.to}T23:59:59.999Z`);
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new RangeError("invalid dates");
  if (from > to) throw new RangeError("from after to");
  return { from, to };
}

// Mirrors AnalyticsStatus in ./partner-analytics.ts: the UI has to tell "this partner is not
// linked yet" (Collected is 0, and that is the truth) apart from "we could not reach the
// upstream" (Collected is unknown, and showing 0 would be a lie).
export type SettlementStatus =
  | "ok"
  | "not-configured" // no confirmed partner link and/or no resolvable API key — never called
  | "invalid-key" // upstream rejected the API key (HTTP 401)
  | "unknown-partner" // upstream does not recognize this partner (HTTP 404)
  | "unavailable"; // network / timeout / 5xx / malformed body / decrypt failure / duplicate claim

function statusForError(e: unknown): SettlementStatus {
  if (e instanceof InvalidApiKeyError) return "invalid-key";
  if (e instanceof UnknownPartnerError) return "unknown-partner";
  return "unavailable"; // never echo the cause onward — it can carry the URL or secret material
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// pageSize 1: only the range-wide aggregate `amount_by_card` is wanted, and the aggregates are
// independent of payment paging — no reason to drag a page of payment rows across the wire for a
// number the response header already carries.
async function fetchCollected(creds: PartnerCredentials, period: SettlementPeriod): Promise<number> {
  const stats = await fetchPartnerStats({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    partner: creds.partner,
    dateFrom: isoDate(period.from),
    dateTo: isoDate(period.to),
    page: 1,
    pageSize: 1,
  });
  return stats.amount_by_card;
}

// Credentials, or a terminal status with no network call attempted.
function credsFor(account: Account): { creds: PartnerCredentials } | { status: SettlementStatus } {
  let creds: PartnerCredentials | null;
  try {
    creds = resolvePartnerCredentials(account);
  } catch {
    return { status: "unavailable" }; // decrypt failure — do not leak the cause
  }
  // Also the answer for a PENDING (unapproved) partner link: resolvePartnerCredentials is the
  // entitlement chokepoint and returns null until the link is confirmed.
  if (!creds) return { status: "not-configured" };
  return { creds };
}

export type SettlementTransferInput = {
  amount: number;
  method: SettlementMethod;
  occurredAt: Date;
  note?: string;
};

// Records one MANUAL TRANSFER against an account. There is deliberately no `type` argument any
// more: Collected is live partner-API data, so the only settlement row a human may create is a
// transfer.
export async function addSettlementEntry(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
  args: SettlementTransferInput,
): Promise<SettlementEntry> {
  assertCan(user, "write_settlements");
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.settlementEntry.create({
    data: {
      companyId: acc.companyId,
      accountId,
      type: "TRANSFER",
      amount: args.amount,
      method: args.method,
      occurredAt: args.occurredAt,
      note: args.note ?? null,
      createdById: user.id,
    },
  });
}

// Amends a transfer in place. `occurredAt` is amendable because it is what decides WHICH PERIOD
// the row deducts from, so a mistyped date has to be fixable without delete-and-retype.
export async function updateSettlementEntry(
  db: PrismaClient,
  user: SessionUser,
  entryId: string,
  args: Partial<SettlementTransferInput>,
): Promise<SettlementEntry> {
  assertCan(user, "write_settlements");
  const found = await db.settlementEntry.findUnique({ where: { id: entryId }, select: { accountId: true } });
  if (!found || !(await getAccount(db, user, found.accountId))) throw new NotFoundError("entry not in scope");
  return db.settlementEntry.update({
    where: { id: entryId },
    data: {
      ...(args.amount !== undefined ? { amount: args.amount } : {}),
      ...(args.method !== undefined ? { method: args.method } : {}),
      ...(args.occurredAt !== undefined ? { occurredAt: args.occurredAt } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    },
  });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION. This used to be `{ id: entryId, companyId }`, which
// under Teams is the whole org: any MEMBER could delete any money row on any account in any team
// just by naming its id — on a ledger they could never see, and with the deletion changing that
// team's "remaining" total. The entry's own account decides, via getAccount -> accountScopeWhere,
// and "no such entry" and "not your account" give the same answer so the pair is not an id
// oracle. The write gate runs FIRST: a COMPANY_ADMIN is refused for being the wrong ROLE, which
// is not a fact about whether the id exists.
export async function deleteSettlementEntry(db: PrismaClient, user: SessionUser, entryId: string): Promise<void> {
  assertCan(user, "write_settlements");
  const found = await db.settlementEntry.findUnique({ where: { id: entryId }, select: { accountId: true } });
  if (!found || !(await getAccount(db, user, found.accountId))) throw new NotFoundError("entry not in scope");
  await db.settlementEntry.delete({ where: { id: entryId } });
}

export type AccountSettlement = {
  period: SettlementPeriod;
  status: SettlementStatus;
  collected: number; // live `amount_by_card` for the period; 0 whenever status !== "ok"
  transferred: number;
  remaining: number;
  /**
   * @deprecated Alias of `remaining`, kept ONLY so the settlements UI, the dashboard and the
   * report export keep compiling while they are migrated off the old ledger shape. It is the
   * same number, not a second one. Delete it once no caller reads it.
   */
  owed: number;
  transferredByMethod: Record<SettlementMethod, number>;
  transfers: SettlementEntry[];
};

export async function getAccountSettlement(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
  period: SettlementPeriod = currentSettlementPeriod(),
): Promise<AccountSettlement> {
  assertCan(user, "view_settlements");
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");

  // PERIOD MEMBERSHIP IS BY occurredAt, NOT createdAt. A transfer keyed in late — or back-dated
  // at entry — belongs to the month the money actually moved, which is the month whose card
  // takings it settles.
  const transfers = await db.settlementEntry.findMany({
    where: {
      companyId: acc.companyId,
      accountId,
      type: "TRANSFER",
      occurredAt: { gte: period.from, lte: period.to },
    },
    orderBy: { occurredAt: "desc" },
  });
  const transferred = sumAmount(transfers);
  const transferredByMethod = sumByMethod(transfers);

  const resolved = credsFor(acc);
  if ("status" in resolved) {
    // Collected is unknown (or genuinely zero); the transfers are still ours to report, and
    // `remaining` stays Collected - Transferred with Collected at 0 rather than being faked.
    return {
      period,
      status: resolved.status,
      collected: 0,
      transferred,
      remaining: -transferred,
      owed: -transferred,
      transferredByMethod,
      transfers,
    };
  }

  let collected = 0;
  let status: SettlementStatus = "ok";
  try {
    collected = await fetchCollected(resolved.creds, period);
  } catch (e) {
    status = statusForError(e);
  }

  return {
    period,
    status,
    collected,
    transferred,
    remaining: collected - transferred,
    owed: collected - transferred,
    transferredByMethod,
    transfers,
  };
}

export type CompanySettlementRow = {
  accountId: string;
  accountName: string;
  status: SettlementStatus;
  collected: number;
  transferred: number;
  remaining: number;
  /** @deprecated Alias of `remaining` — see AccountSettlement.owed. */
  owed: number;
};

export type CompanySettlements = {
  period: SettlementPeriod;
  totals: {
    collected: number;
    transferred: number;
    remaining: number;
    /** @deprecated Alias of `remaining` — see AccountSettlement.owed. */
    owed: number;
  };
  rows: CompanySettlementRow[];
};

// The settlement roll-up, over the accounts the caller may actually see.
//
// It used to be the whole company for every role bar PARTNER_VIEWER, which it narrowed with its
// own hand-rolled sentinel. Under Teams "the whole company" is the whole org, so a MEMBER's cash
// page showed every team's collections. accountScopeWhere decides instead — own team for a team
// admin, the one account for a partner login — and the transfer query is confined to exactly
// those account ids rather than re-deriving the rule a second time. (A MEMBER no longer reaches
// any of it at all: view_settlements excludes the role outright.)
export async function listCompanySettlements(
  db: PrismaClient,
  user: SessionUser,
  period: SettlementPeriod = currentSettlementPeriod(),
): Promise<CompanySettlements> {
  assertCan(user, "view_settlements");
  const scope = accountScopeWhere(user);
  const accounts = await db.account.findMany({ where: scope, orderBy: { name: "asc" } });
  const transfers = accounts.length
    ? await db.settlementEntry.findMany({
        where: {
          companyId: scope.companyId,
          accountId: { in: accounts.map((a) => a.id) },
          type: "TRANSFER",
          occurredAt: { gte: period.from, lte: period.to },
        },
      })
    : [];

  // Resolve credentials up front, synchronously: an account with no confirmed link (or no
  // resolvable key) never touches the network. The dedup by partner name is defence in depth,
  // same reasoning as company-analytics.ts and reports.ts — the partner namespace is global, so
  // two accounts naming one complex would count that complex's card takings twice in `totals`.
  // `@@unique([externalPartnerKey])` now prevents that at the DB; a row predating it is reported
  // as "unavailable" rather than silently doubled. First account wins, in the name order listed.
  const claimed = new Set<string>();
  const perAccount = accounts.map((a) => {
    const resolved = credsFor(a);
    if ("status" in resolved) return { account: a, status: resolved.status, creds: null };
    if (claimed.has(resolved.creds.partner)) return { account: a, status: "unavailable" as const, creds: null };
    claimed.add(resolved.creds.partner);
    return { account: a, status: "ok" as const, creds: resolved.creds };
  });

  // Fan out IN PARALLEL. allSettled keeps one account's rejection (bad key / unknown partner /
  // timeout / malformed body) from failing the whole page, and preserves order.
  const live = perAccount.filter((p): p is typeof p & { creds: PartnerCredentials } => p.creds !== null);
  const settled = await Promise.allSettled(live.map((p) => fetchCollected(p.creds, period)));
  const collectedById = new Map<string, number>();
  const statusById = new Map<string, SettlementStatus>();
  settled.forEach((res, i) => {
    const id = live[i].account.id;
    if (res.status === "fulfilled") {
      collectedById.set(id, res.value);
      statusById.set(id, "ok");
    } else {
      statusById.set(id, statusForError(res.reason));
    }
  });

  const rows: CompanySettlementRow[] = perAccount.map((p) => {
    const collected = collectedById.get(p.account.id) ?? 0;
    const transferred = sumAmount(transfers.filter((t) => t.accountId === p.account.id));
    return {
      accountId: p.account.id,
      accountName: p.account.name,
      status: statusById.get(p.account.id) ?? p.status,
      collected,
      transferred,
      remaining: collected - transferred,
      owed: collected - transferred,
    };
  });

  const totals = rows.reduce(
    (t, r) => ({
      collected: t.collected + r.collected,
      transferred: t.transferred + r.transferred,
      remaining: t.remaining + r.remaining,
      owed: t.owed + r.remaining,
    }),
    { collected: 0, transferred: 0, remaining: 0, owed: 0 },
  );
  return { period, totals, rows };
}
