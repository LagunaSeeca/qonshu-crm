import type { Account, CollectionMode, Prisma, PrismaClient, SettlementEntry, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError, assertCan } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { accountScopeWhere } from "./scope";
import { fetchPartnerStats } from "@/lib/partner-api/client";
import { resolvePartnerCredentials, type PartnerCredentials } from "@/lib/partner-api/credentials";
import { InvalidApiKeyError, UnknownPartnerError } from "@/lib/partner-api/errors";
import { BAKU_UTC_OFFSET_HOURS } from "@/lib/period-presets";

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
// WHO HOLDS THE MONEY — Account.collectionMode. QONSHU (the default, and what every account was
// before the column existed): the residents' card payments land in Qonshu's account, so Qonshu
// owes the building and `remaining`/`owed` are real figures. SELF: the building collects its own
// residents' money, so Qonshu holds nothing for it and has nothing to transfer.
//
// For a SELF account `collected` is STILL fetched and reported — the monthly service fee Qonshu
// invoices is computed off that card base, so the figure matters — but `remaining` and `owed` are
// OMITTED, exactly as they are for an unknown Collected. They are MEANINGLESS, not zero: a 0 would
// render as "settled up", which implies a debt that was paid.
//
// AND SELF ACCOUNTS ARE OUT OF EVERY COMPANY TOTAL. Folding them in as zeros would understate
// nothing but would silently widen `collected` to cover money Qonshu never touched; their card
// base is reported separately as `totals.selfCollected` so the service-fee base stays visible.
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

// Start of a BAKU calendar day as an absolute instant. Baku is UTC+4 with no DST, so the fixed
// offset is exact — see BAKU_UTC_OFFSET_HOURS in src/lib/period-presets.ts, the single definition.
const BAKU_OFFSET_MS = BAKU_UTC_OFFSET_HOURS * 3_600_000;
const bakuDayStart = (y: number, m: number, d = 1): Date =>
  new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - BAKU_OFFSET_MS);

// Settlements are reckoned by calendar month in BAKU LOCAL TIME (UTC+4), not UTC.
//
// WHY BAKU, AND WHY EVERY PERIOD ON THIS PATH MUST AGREE: the business is in Baku, and the user
// chose Baku months for billing so a building's own month-end figure matches ours. These helpers
// used to return UTC boundaries while the /settlements page resolves Baku ones via
// period-presets.ts. That mismatch was a live money bug, not a cosmetic one: `isoDate` below
// turns `from` into the calendar date the partner API filters on, so a Baku `from` of
// 2026-10-31T20:00Z was sent as "2026-10-31" and the upstream folded 31 OCTOBER's card payments
// into November's Collected — inflating Owed by that amount and double-counting it in both
// months. Keeping month resolution in one timezone is what stops that recurring.
export function currentSettlementPeriod(now: Date = new Date()): SettlementPeriod {
  // Shift into Baku wall-clock so getUTC* reads Baku's year/month.
  const local = new Date(now.getTime() + BAKU_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  return {
    from: bakuDayStart(y, m, 1),
    to: new Date(bakuDayStart(y, m + 1, 1).getTime() - 1),
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
  // Both bounds are BAKU calendar days, inclusive — same convention as currentSettlementPeriod
  // above and as period-presets.ts, so a `?from=&to=` pair means the same window whether it
  // arrives from the page, the API or a report.
  const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.from ?? "");
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.to ?? "");
  if (!f || !t) throw new RangeError("invalid dates");
  const from = bakuDayStart(+f[1], +f[2] - 1, +f[3]);
  const to = new Date(bakuDayStart(+t[1], +t[2] - 1, +t[3] + 1).getTime() - 1);
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

// The BAKU calendar date of an instant — NOT the UTC one.
//
// The partner API filters on inclusive calendar dates, and every period on this path is now a
// Baku boundary (see currentSettlementPeriod). A Baku month therefore starts at 20:00Z on the
// previous day, so a plain `toISOString()` names the WRONG DAY: November's `from` (2026-10-31
// 20:00Z) was sent as "2026-10-31" and pulled 31 October's card payments into November's
// Collected. Shifting into Baku wall-clock first maps `from` 20:00Z -> 00:00Z on the correct
// date, and `to` 19:59:59.999Z -> 23:59:59.999Z on the correct date.
const isoDate = (d: Date): string =>
  new Date(d.getTime() + BAKU_OFFSET_MS).toISOString().slice(0, 10);

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

// A transfer was attempted against a building that collects its own money. NOT a 403 (the caller
// may well hold write_settlements) and NOT a 404 (the account exists and is in scope): the request
// is well-formed but the state of the account makes it impossible, which is a 422. `reason` is
// machine-readable so the UI can say WHY rather than printing a sentence it had to parse.
export class SelfCollectingError extends Error {
  readonly reason = "self_collecting" as const;
  constructor(message = "account collects its own money; there is nothing for Qonshu to transfer") {
    super(message);
  }
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
  // AFTER the scope check, so a caller cannot use the 422 to learn that an out-of-scope id
  // exists. A SELF building's money never reaches Qonshu, so a transfer to it is not a figure we
  // could ever owe — refuse the row rather than record money that did not move.
  if (acc.collectionMode === "SELF") throw new SelfCollectingError();
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
  /** Who holds this building's money. SELF means `remaining`/`owed` are absent BY DESIGN. */
  collectionMode: CollectionMode;
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
  /**
   * Collected - Transferred. Absent whenever `collected` is (it cannot be computed), and ALSO
   * absent for a SELF account, where it is not a quantity that exists.
   */
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
    return { period, status: resolved.status, collectionMode: acc.collectionMode, transferred, transferredByMethod, transfers };
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
  if (collected === null) {
    return { period, status, collectionMode: acc.collectionMode, transferred, transferredByMethod, transfers };
  }

  const base: AccountSettlement = {
    period,
    status,
    collectionMode: acc.collectionMode,
    collected,
    transferred,
    transferredByMethod,
    transfers,
  };
  // A SELF building keeps `collected` (the service-fee base) and keeps whatever transfer rows it
  // has (historic ones, or ones recorded before the mode was switched), but gets no
  // `remaining`/`owed` — see the header. Note this is NOT `collected - transferred`: those two
  // are not two sides of one balance here.
  if (acc.collectionMode === "SELF") return base;
  return { ...base, remaining: collected - transferred, owed: collected - transferred };
}

export type CompanySettlementRow = {
  accountId: string;
  accountName: string;
  status: SettlementStatus;
  /** Who holds this building's money. A SELF row is in `rows` but in none of the four totals. */
  collectionMode: CollectionMode;
  /** Present ONLY when `status === "ok"` — see AccountSettlement.collected for why. */
  collected?: number;
  transferred: number;
  /** Present exactly when `collected` is AND `collectionMode === "QONSHU"`. */
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
     *
     * SELF rows are excluded here and from the other three — Qonshu never held their money, so
     * including it would overstate the company's position. Their card base is `selfCollected`.
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
     * The summed `collected` of the SELF rows whose upstream fetch SUCCEEDED — money Qonshu never
     * held and will never transfer, but which is the base the monthly service fee is reckoned on.
     * It is NOT part of `collected` and the two must never be added together and presented as the
     * company's takings. 0 when there are no SELF rows.
     */
    selfCollected: number;
    /**
     * True when at least one in-scope account's Collected could not be established, i.e. these
     * totals are a floor over a subset. A consumer MUST check this before presenting them as the
     * company's cash position.
     */
    partial: boolean;
    /**
     * The accounts whose Collected never arrived, SELF ones included (a SELF row that failed
     * understates `selfCollected` in the same way). Their `status` says why. Distinct from "left
     * out of the totals": a SELF row that DID answer is excluded from `collected`/`remaining`/
     * `owed` by design and is not listed here.
     */
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
export type SettlementFilters = {
  /** Case-insensitive substring of the building name. */
  q?: string;
  /** One building. An id outside the caller's scope simply matches nothing — never a 404. */
  accountId?: string;
  /** owed = `remaining > 0`, settled = `remaining <= 0`. Applied AFTER the figures are computed. */
  status?: "owed" | "settled";
};

export async function listCompanySettlements(
  db: PrismaClient,
  user: SessionUser,
  period: SettlementPeriod = currentSettlementPeriod(),
  filters: SettlementFilters = {},
): Promise<CompanySettlements> {
  assertCan(user, "view_settlements");
  const scope = accountScopeWhere(user);

  // THE BUILDING FILTERS GO ON THE ACCOUNT QUERY, before any upstream call — a search for one
  // building must not still fan out to every partner.
  //
  // COMPOSED AS `{ AND: [scope, ...extra] }` AND NOTHING ELSE. `{ ...scope, AND: [...] }` would
  // copy the scope's own `AND` and then have the literal's `AND` replace it, dropping the
  // membership test entirely — that FAILS OPEN to the whole team/company rather than returning
  // fewer rows. See the composition rule in scope.ts. `scope.companyId` is still read off the
  // scope object directly below for the transfer query, which is why it must stay a top-level key.
  const extra: Prisma.AccountWhereInput[] = [];
  const q = filters.q?.trim();
  if (q) extra.push({ name: { contains: q, mode: "insensitive" } });
  if (filters.accountId) extra.push({ id: filters.accountId });
  const where: Prisma.AccountWhereInput = extra.length ? { AND: [scope, ...extra] } : scope;

  const accounts = await db.account.findMany({ where, orderBy: { name: "asc" } });
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
      collectionMode: p.account.collectionMode,
      transferred,
    };
    if (collected === undefined) return base;
    // A SELF row reports its card base and stops there — `remaining`/`owed` do not exist for it.
    if (p.account.collectionMode === "SELF") return { ...base, collected };
    return { ...base, collected, remaining: collected - transferred, owed: collected - transferred };
  });

  // `status` can only be judged once the figures exist, so it filters the ROWS rather than the
  // query. A row with an unknown Collected, and every SELF row, has no `remaining` to bucket, so
  // neither appears under either value — they are visible only with no status filter set.
  const visible = filters.status
    ? rows.filter(
        (r) => r.remaining !== undefined && (filters.status === "owed" ? r.remaining > 0 : r.remaining <= 0),
      )
    : rows;

  // Split once, so the totals say WHICH accounts they cover. `owed` is read off the same
  // `remaining` as its sibling — it was already `t.owed + r.remaining` while every other
  // accumulator read its own key, which is correct only because the two are aliases; keeping them
  // on one expression means they cannot drift if someone ever gives `owed` its own meaning.
  //
  // THE QONSHU TEST IS EXPLICIT AND MUST STAY SO. This filter used to be `r.collected !== undefined`
  // and then read `r.remaining` off the result: a SELF row HAS a `collected` but no `remaining`, so
  // that predicate admits it and the sum goes to NaN — one self-collecting building would wipe out
  // every company total on the page. Collected-ness and owed-ness are now two separate questions.
  const qonshuRows = visible.filter((r) => r.collectionMode === "QONSHU");
  const complete = qonshuRows.filter((r): r is CompanySettlementRow & { remaining: number; collected: number } =>
    r.collected !== undefined,
  );
  const selfCollectedRows = visible.filter(
    (r): r is CompanySettlementRow & { collected: number } =>
      r.collectionMode === "SELF" && r.collected !== undefined,
  );
  // DERIVED FROM `rows`, NOT `visible` — deliberately, and the status filter is exactly why.
  //
  // A row whose Collected could not be read has no `remaining`, so the owed/settled filter drops
  // it from `visible`. Computing this off `visible` therefore made `partial` go FALSE as soon as a
  // filter was applied: with 3 of 12 buildings unreachable, the unfiltered page correctly warned
  // "covers only the accounts that responded", then clicking "Owed" silently removed those 3 from
  // the totals AND removed the warning — presenting a knowingly incomplete cash position as the
  // company's complete one. The accounts stay counted as degraded whether or not they are shown.
  const degradedAccountIds = rows.filter((r) => r.collected === undefined).map((r) => r.accountId);
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
  const remaining = sum(complete.map((r) => r.remaining));
  const totals = {
    collected: sum(complete.map((r) => r.collected)),
    // Every QONSHU row, not just the complete ones — see CompanySettlements.totals.transferred.
    // SELF rows are left out even though their transfers are equally well known: a transfer that
    // cannot be set against any Collected is not part of this balance.
    transferred: sum(qonshuRows.map((r) => r.transferred)),
    remaining,
    owed: remaining,
    selfCollected: sum(selfCollectedRows.map((r) => r.collected)),
    partial: degradedAccountIds.length > 0,
    degradedAccountIds,
  };
  return { period, totals, rows: visible };
}

// Switches who holds a building's money.
//
// SUPER_ADMIN ALONE, by reusing `write_settlements` — the capability that already means "may move
// what Qonshu owes a partner". This flag decides whether Qonshu owes the building ANYTHING at all,
// which is strictly the bigger lever, so it cannot sit behind `edit_accounts` (that one includes
// MEMBER, and is why this is NOT a field on the generic account PATCH route).
//
// A missing id and another team's account both raise NotFoundError, identically, so the pair is
// not an existence oracle — the same rule the other account sub-resources follow.
export async function setCollectionMode(
  db: PrismaClient,
  user: SessionUser,
  accountId: string,
  mode: CollectionMode,
): Promise<{ id: string; collectionMode: CollectionMode }> {
  assertCan(user, "write_settlements");
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  // EXISTING TRANSFER ROWS ARE LEFT ALONE on a switch to SELF. They record money that really did
  // move; deleting or hiding them would rewrite history, and getAccountSettlement still lists them.
  return db.account.update({
    where: { id: accountId },
    data: { collectionMode: mode },
    select: { id: true, collectionMode: true },
  });
}
