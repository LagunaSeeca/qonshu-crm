import { Prisma } from "@prisma/client";
import type { PrismaClient, ServiceFee, SettlementMethod } from "@prisma/client";
import { z } from "zod";
import type { SessionUser } from "@/lib/auth/guards";
import { assertCan, can, ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { BAKU_UTC_OFFSET_HOURS } from "@/lib/period-presets";
import { getAccount, getWritableAccount } from "./accounts";
import { accountScopeWhere } from "./scope";

// GATING LIVES HERE, IN THE SERVICE, NOT ONLY IN THE ROUTE HANDLERS — the same invariant
// settlements.ts states at length. Server components call these functions directly and hand the
// result to client components as props, so a gate that sits only in `/api/...` still ships the
// numbers into the browser on the page render.
//
// A SERVICE FEE IS MONEY: it is what Qonshu invoices a building. READS therefore require
// `view_financials`, which every role holds EXCEPT ONBOARDING — a MEMBER included, unchanged, since
// their own buildings' billing has always been theirs to see. WRITES go through getWritableAccount
// (`edit_accounts`), so an assigned onboarding user cannot create, amend, delete, or flip the paid
// state of an invoice on a building they are merely activating.
//
// PRICING IS NARROWER THAN BOOKKEEPING. What a building owes per month is set by the SUPER_ADMIN
// alone (`write_settlements`, reused on purpose — see guards.ts): the per-building rate
// (setServiceFeeRate), the monthly generation run, and ANY write that creates a fee row or changes
// a fee's amount. Marking a fee paid/unpaid, or editing its note/due date, stays at `edit_accounts`:
// that is operational bookkeeping, not pricing. Without this a MEMBER could hand-write a fee of any
// amount and bypass the rate entirely.

const num = (d: { toNumber: () => number }) => d.toNumber();

// MONEY AS STRINGS. An amount arrives as a string and goes to Prisma as a string (-> Decimal); it is
// never parsed to a JS number on the way in. 1-12 integer digits, at most 2 decimals, strictly
// positive. A `number` (z.number()-style input) is rejected outright rather than coerced.
export const FeeAmountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "amount must be a decimal string with at most 2 decimal places")
  .refine((v) => /[1-9]/.test(v), "amount must be positive");

// null clears the rate (= no agreed rate).
export const FeeRateSchema = FeeAmountSchema.nullable();

// "YYYY-MM", real month, sane year window.
export const BillingMonthSchema = z
  .string()
  .regex(/^(20\d{2}|2100)-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

// BILLING PERIODS ARE BAKU LOCAL TIME (UTC+4, no DST) — the product owner's explicit choice. The
// offset comes from the one constant in period-presets.ts. TODO: unify with that module by exporting
// month/day boundary helpers from it; the rest of the app (reports/period.ts, analytics/range.ts)
// is still UTC, a known and accepted inconsistency. periodMonth itself stays the UTC first-of-month
// (firstOfMonth below), because that is the @@unique key manual rows already use.
const BAKU_OFFSET_MS = BAKU_UTC_OFFSET_HOURS * 3600000;

// Instant of Baku-local midnight at the start of the day containing `now`.
function bakuStartOfDay(now: Date): Date {
  const local = new Date(now.getTime() + BAKU_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - BAKU_OFFSET_MS);
}

// Last millisecond of the last Baku day of (year, month0). 23:59:59.999 Baku is 19:59:59.999Z of the
// SAME calendar date, so a UTC date display still shows the right day; and "dueDate < Baku start of
// today" flips to overdue exactly at Baku midnight after the last day.
function bakuMonthEnd(year: number, month0: number): Date {
  return new Date(Date.UTC(year, month0 + 1, 1) - BAKU_OFFSET_MS - 1);
}

// Pricing gate with a message that says WHY. Role-only (id-independent), so it is checked before any
// lookup and is not an existence oracle.
function assertCanPrice(user: SessionUser): void {
  if (!can(user, "write_settlements")) {
    throw new ForbiddenError(
      "only the owner (super admin) may set or change what a building is billed; recording a payment is still allowed",
    );
  }
}

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function addServiceFee(db: PrismaClient, user: SessionUser, accountId: string, args: {
  // A DECIMAL STRING, never a number — same rule as FeeAmountSchema and setServiceFeeRate. A JS
  // number cannot represent every 2-decimal amount exactly, and this value is written straight to
  // a Prisma Decimal column, so parsing it on the way in is the one step that could lose a cent.
  periodMonth: Date; amount: string; dueDate?: Date; note?: string;
}): Promise<ServiceFee> {
  // Creating a fee row SETS an amount: pricing, owner only. Before the lookup (role test, no oracle).
  assertCanPrice(user);
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.serviceFee.create({ data: {
    companyId: acc.companyId, accountId, periodMonth: firstOfMonth(args.periodMonth), amount: args.amount,
    dueDate: args.dueDate ?? null, note: args.note ?? null, createdById: user.id,
  } });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION for every by-id mutation below.
//
// All four of these used to look the fee up by `{ id: feeId, companyId }`. Under the old model
// companyId was the customer boundary, so that was a tenancy check; under Teams it is the WHOLE
// ORG. Every service fee in Qonshu matched, so any MEMBER could edit an amount, delete a fee, or
// mark another team's invoice paid or unpaid purely by naming its id — on a billing page they
// could never open. The fee's own account decides, via getAccount -> accountScopeWhere.
//
// "No such fee" and "not your account" return the SAME NotFoundError on purpose: a different
// answer for the two is an id-probing oracle over the org's whole billing table.
async function requireFeeInScope(db: PrismaClient, user: SessionUser, feeId: string): Promise<ServiceFee> {
  // Hoisted above the child lookup, as in account-tasks.ts/account-asks.ts: `edit_accounts` is an
  // id-independent ROLE test, so asserting it only after the fee row is found would answer 403 for
  // a real fee id and 404 for an invented one — reinstating, for exactly the roles being kept out,
  // the id-probing oracle that the shared NotFoundError below exists to close.
  assertCan(user, "edit_accounts");
  const found = await db.serviceFee.findUnique({ where: { id: feeId } });
  if (!found || !(await getWritableAccount(db, user, found.accountId))) throw new NotFoundError("fee not in scope");
  return found;
}

export async function updateServiceFee(db: PrismaClient, user: SessionUser, feeId: string, data: Partial<{
  // Decimal string, not a number — see addServiceFee.
  amount: string; dueDate: Date | null; note: string | null; periodMonth: Date;
}>): Promise<ServiceFee> {
  // Changing an AMOUNT is pricing (owner only); note/dueDate/periodMonth edits stay bookkeeping.
  if (data.amount !== undefined) assertCanPrice(user);
  await requireFeeInScope(db, user, feeId);
  const { periodMonth, ...rest } = data;
  return db.serviceFee.update({
    where: { id: feeId },
    data: { ...rest, ...(periodMonth ? { periodMonth: firstOfMonth(periodMonth) } : {}) },
  });
}

export async function deleteServiceFee(db: PrismaClient, user: SessionUser, feeId: string): Promise<void> {
  await requireFeeInScope(db, user, feeId);
  await db.serviceFee.delete({ where: { id: feeId } });
}

export async function markFeePaid(db: PrismaClient, user: SessionUser, feeId: string, args: {
  method?: SettlementMethod; paidAt?: Date;
}): Promise<ServiceFee> {
  const found = await requireFeeInScope(db, user, feeId);
  return db.serviceFee.update({
    where: { id: feeId },
    data: { status: "PAID", paidAt: args.paidAt ?? new Date(), method: args.method ?? found.method ?? null },
  });
}

export async function markFeeUnpaid(db: PrismaClient, user: SessionUser, feeId: string): Promise<ServiceFee> {
  await requireFeeInScope(db, user, feeId);
  return db.serviceFee.update({ where: { id: feeId }, data: { status: "UNPAID", paidAt: null, method: null } });
}

export async function getAccountServiceFees(db: PrismaClient, user: SessionUser, accountId: string) {
  // BEFORE the scope lookup, and intentionally so: `view_financials` does not look at the id, so
  // the refusal is the same for every id and discloses nothing — while putting it after would make
  // "403 vs 404" tell an onboarding user whether a building exists in someone else's book.
  assertCan(user, "view_financials");
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const fees = await db.serviceFee.findMany({
    where: { companyId: acc.companyId, accountId },
    orderBy: { periodMonth: "desc" },
  });
  const totalBilled = fees.reduce((s, f) => s + num(f.amount), 0);
  const totalPaid = fees.filter((f) => f.status === "PAID").reduce((s, f) => s + num(f.amount), 0);
  return { fees, totalBilled, totalPaid, totalOutstanding: totalBilled - totalPaid };
}

// The billing roll-up, over the accounts the caller may actually see.
//
// It used to be the whole company for every role bar PARTNER_VIEWER, narrowed by its own
// hand-rolled sentinel. Under Teams "the whole company" is the whole org, so a MEMBER's billing
// page listed every team's invoices. accountScopeWhere decides instead — own accounts for a
// MEMBER, own team for a team admin, the one account for a partner login — and the fee query is
// confined to exactly those account ids rather than re-deriving the rule a second time.
export type ServiceFeeListStatus = "PAID" | "UNPAID" | "OVERDUE";

export async function listCompanyServiceFees(db: PrismaClient, user: SessionUser, opts?: {
  status?: ServiceFeeListStatus; from?: Date; to?: Date; q?: string; accountId?: string;
  // Test seam for "today"; production callers omit it.
  now?: Date;
}) {
  // The billing roll-up is money, so it needs `view_financials`. Note that getDashboardStats calls
  // this UNCONDITIONALLY for `finance.serviceFeesOutstanding` — which is safe only because
  // leadScopeWhere already refuses ONBOARDING before the dashboard reaches this line. A MEMBER
  // holds view_financials, so their dashboard and billing page are unchanged.
  assertCan(user, "view_financials");
  const scope = accountScopeWhere(user);
  // COMPOSITION RULE (scope.ts): the scope is NESTED under AND, never spread. A MEMBER's/onboarding
  // scope carries its own `AND` (the manager-or-assigned membership test); `{ ...scope, AND: [...] }`
  // would replace it and return the whole team. Name and account filters only ever NARROW.
  const and: Prisma.AccountWhereInput[] = [scope];
  const q = opts?.q?.trim();
  if (q) and.push({ name: { contains: q, mode: "insensitive" } });
  if (opts?.accountId) and.push({ id: opts.accountId });
  const accounts = await db.account.findMany({ where: { AND: and }, orderBy: { name: "asc" } });

  const startOfToday = bakuStartOfDay(opts?.now ?? new Date());
  const where: Prisma.ServiceFeeWhereInput = {
    companyId: scope.companyId, accountId: { in: accounts.map((a) => a.id) },
  };
  if (opts?.status === "PAID" || opts?.status === "UNPAID") where.status = opts.status;
  // OVERDUE = unpaid AND past its due date. `lt` never matches a NULL dueDate (SQL NULL < x is not
  // true), so a fee with no due date is never overdue — also re-checked in isOverdue below.
  if (opts?.status === "OVERDUE") { where.status = "UNPAID"; where.dueDate = { lt: startOfToday }; }
  if (opts?.from || opts?.to) {
    const pm: Prisma.DateTimeFilter = {};
    if (opts.from) pm.gte = opts.from;
    if (opts.to) pm.lte = opts.to;
    where.periodMonth = pm;
  }
  const fees = accounts.length ? await db.serviceFee.findMany({ where }) : [];
  const isOverdue = (f: ServiceFee) => f.status === "UNPAID" && f.dueDate !== null && f.dueDate < startOfToday;
  const rows = accounts.map((a) => {
    const mine = fees.filter((f) => f.accountId === a.id);
    const billed = mine.reduce((s, f) => s + num(f.amount), 0);
    const paid = mine.filter((f) => f.status === "PAID").reduce((s, f) => s + num(f.amount), 0);
    const overdue = mine.filter(isOverdue).reduce((s, f) => s + num(f.amount), 0);
    return {
      accountId: a.id, accountName: a.name,
      // The agreed monthly rate as an exact 2-dp string, or null when none is set.
      monthlyServiceFee: a.monthlyServiceFee ? a.monthlyServiceFee.toFixed(2) : null,
      billed, paid, outstanding: billed - paid, overdue,
    };
  });
  const totals = rows.reduce(
    (t, r) => ({
      billed: t.billed + r.billed, paid: t.paid + r.paid,
      outstanding: t.outstanding + r.outstanding, overdue: t.overdue + r.overdue,
    }),
    { billed: 0, paid: 0, outstanding: 0, overdue: 0 }
  );
  return { totals, rows };
}

// THE AGREED PER-BUILDING RATE. SUPER_ADMIN only (`write_settlements`). `null` clears it, which
// means "no agreed rate" and takes the building out of monthly generation.
//
// Gate first, then amount validation (both id-independent, so neither is an existence oracle), then
// the scope lookup: a missing id and another team's id are the same NotFoundError.
export async function setServiceFeeRate(
  db: PrismaClient, user: SessionUser, accountId: string, amount: string | null,
): Promise<{ accountId: string; monthlyServiceFee: string | null }> {
  assertCanPrice(user);
  // A STRING all the way to Prisma, which parses it into a Decimal. No Number(), no arithmetic.
  const parsed = FeeRateSchema.parse(amount);
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const updated = await db.account.update({
    where: { id: acc.id }, data: { monthlyServiceFee: parsed },
  });
  return { accountId: updated.id, monthlyServiceFee: updated.monthlyServiceFee ? updated.monthlyServiceFee.toFixed(2) : null };
}

// EXPLICIT, IDEMPOTENT MONTHLY GENERATION. Not generate-on-read (that is a write inside a GET) and
// not a cron (no session user, so it cannot be scope-checked or gated). The owner runs it.
//
// Eligible: inside the caller's accountScopeWhere AND monthlyServiceFee IS NOT NULL AND status =
// 'ACTIVE'. Status, not trialEndsAt (not cleared on DEMO conversion — known open bug). collectionMode
// is deliberately NOT consulted: a SELF-collecting building still owes Qonshu its service fee.
//
// Rows are inserted UNPAID with the rate copied as a Decimal (no arithmetic). createMany +
// skipDuplicates (ON CONFLICT DO NOTHING on @@unique([accountId, periodMonth])) means an existing row
// for the month is never rewritten, so a later rate change does not alter past months, and two
// concurrent runs cannot double-bill.
//
// Returns created = rows inserted, skipped = eligible buildings that already had a row.
export async function generateMonthlyFees(
  db: PrismaClient, user: SessionUser, month: string,
): Promise<{ created: number; skipped: number }> {
  assertCanPrice(user);
  const m = BillingMonthSchema.parse(month);
  const year = Number(m.slice(0, 4)), month0 = Number(m.slice(5, 7)) - 1;
  const scope = accountScopeWhere(user);
  // Scope NESTED under AND, never spread — see listCompanyServiceFees.
  const accounts = await db.account.findMany({
    where: { AND: [scope, { status: "ACTIVE", monthlyServiceFee: { not: null } }] },
    select: { id: true, companyId: true, monthlyServiceFee: true },
  });
  if (!accounts.length) return { created: 0, skipped: 0 };
  const periodMonth = new Date(Date.UTC(year, month0, 1));
  const dueDate = bakuMonthEnd(year, month0);
  const res = await db.serviceFee.createMany({
    data: accounts.map((a) => ({
      companyId: a.companyId, accountId: a.id, periodMonth, amount: a.monthlyServiceFee as Prisma.Decimal,
      dueDate, createdById: user.id,
    })),
    skipDuplicates: true,
  });
  return { created: res.count, skipped: accounts.length - res.count };
}
