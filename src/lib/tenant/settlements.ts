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
// linked yet" apart from "we could not reach the upstream" — in both cases Collected is reported
// as UNKNOWN (the key is omitted, see AccountSettlement.collected) and `status` is the only thing
// that explains which, because a 0 in either case is a figure a user would read as money.
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
  /**
   * Live `amount_by_card` for the period. PRESENT ONLY when `status === "ok"`. When the upstream
   * was not asked or could not answer, this key — and everything derived from it — is ABSENT from
   * the object entirely, not 0, exactly as a MEMBER's omitted settlement keys are absent. A 0 here
   * was a fabricated money figure: `remaining` came out as -Transferred, so an account with
   * ₼50,000 of transfers and a timing-out API rendered "-₼50,000", which reads as "the partner
   * owes us ₼50,000 back". An absent key cannot be formatted into a number a user would act on;
   * `status` is the explanation to show in its place.
   */
  collected?: number;
  /** Our own transfer rows for the period. Always known — the DB is never "unavailable" here. */
  transferred: number;
  /** Collected - Transferred. Absent whenever `collected` is (it cannot be computed). */
  remaining?: number;
  /**
   * @deprecated Alias of `remaining`, kept ONLY so the settlements UI, the dashboard and the
   * report export keep compiling while they are migrated off the old ledger shape. It is the
   * same number, not a second one. Absent exactly when `remaining` is. Delete it once no caller
   * reads it.
   */
  owed?: number;
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
    // The upstream was never asked, so Collected is UNKNOWN: omit it and everything derived from
    // it rather than returning 0 and a `remaining` of -Transferred. The transfers are still ours
    // to report. (This also covers "not-configured", where 0 would arguably be the truth — but
    // the caller cannot tell the two apart from the numbers alone, only from `status`, so the one
    // rule "status !== ok means no figure" is what makes a fabricated figure unrepresentable.)
    return { period, status: resolved.status, transferred, transferredByMethod, transfers };
  }

  let collected: number | null = null;
  let status: SettlementStatus = "ok";
  try {
    collected = await fetchCollected(resolved.creds, period);
  } catch (e) {
    status = statusForError(e);
  }

  // The fetch threw: same rule. `collected` stays null and the three money keys are omitted, so a
  // timeout can never reach the UI as a concrete manat figure.
  if (collected === null) return { period, status, transferred, transferredByMethod, transfers };

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
  /** Present ONLY when `status === "ok"` — see AccountSettlement.collected for why. */
  collected?: number;
  transferred: number;
  /** Present exactly when `collected` is. */
  remaining?: number;
  /** @deprecated Alias of `remaining` — see AccountSettlement.owed. */
  owed?: number;
};

export type CompanySettlements = {
  period: SettlementPeriod;
  totals: {
    /**
     * Summed over the rows whose Collected ACTUALLY ARRIVED. A row whose fetch failed contributes
     * nothing — it used to contribute `?? 0`, so with 3 of 10 accounts timing out the company
     * figure was understated by ~30% (and `remaining`/`owed` correspondingly inflated) while
     * presenting itself as authoritative. `remaining`/`owed` are summed over the SAME rows, so
     * `collected - <those rows' transfers> = remaining` still holds for that subset.
     */
    collected: number;
    /**
     * Summed over EVERY row, including the degraded ones: transfers are our own DB records and are
     * always known, so narrowing them would be its own fabrication. NOTE the consequence: when
     * `partial` is true this covers more accounts than `collected` does, so
     * `collected - transferred !== remaining`. Do not present the three as one balance sheet
     * without saying the data is incomplete.
     */
    transferred: number;
    remaining: number;
    /** @deprecated Alias of `remaining` — see AccountSettlement.owed. */
    owed: number;
    /**
     * True when at least one in-scope account's Collected could not be established, i.e. these
     * totals are a floor over a subset. A consumer MUST check this before presenting them as the
     * company's cash position.
     */
    partial: boolean;
    /** The accounts left out of `collected`/`remaining`/`owed`; their `status` says why. */
    degradedAccountIds: string[];
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
    // `collectedById.get(id) ?? 0` used to live here: an account whose fetch failed (or was never
    // attempted) got a 0 Collected and therefore a `remaining` of -Transferred, which the cash
    // table rendered as a negative manat figure indistinguishable from a real one. No value means
    // no keys.
    const collected = collectedById.get(p.account.id);
    const transferred = sumAmount(transfers.filter((t) => t.accountId === p.account.id));
    const base = {
      accountId: p.account.id,
      accountName: p.account.name,
      status: statusById.get(p.account.id) ?? p.status,
      transferred,
    };
    if (collected === undefined) return base;
    return { ...base, collected, remaining: collected - transferred, owed: collected - transferred };
  });

  // Split once, so the totals say WHICH accounts they cover. `owed` is read off the same
  // `remaining` as its sibling — it was already `t.owed + r.remaining` while every other
  // accumulator read its own key, which is correct only because the two are aliases; keeping them
  // on one expression means they cannot drift if someone ever gives `owed` its own meaning.
  const complete = rows.filter((r): r is CompanySettlementRow & { remaining: number; collected: number } =>
    r.collected !== undefined,
  );
  const degradedAccountIds = rows.filter((r) => r.collected === undefined).map((r) => r.accountId);
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
  const remaining = sum(complete.map((r) => r.remaining));
  const totals = {
    collected: sum(complete.map((r) => r.collected)),
    // Every row, not just the complete ones — see CompanySettlements.totals.transferred.
    transferred: sum(rows.map((r) => r.transferred)),
    remaining,
    owed: remaining,
    partial: degradedAccountIds.length > 0,
    degradedAccountIds,
  };
  return { period, totals, rows };
}
