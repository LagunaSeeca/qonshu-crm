import type { PrismaClient, ServiceFee, ServiceFeeStatus, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { assertCan, NotFoundError } from "@/lib/auth/guards";
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

const num = (d: { toNumber: () => number }) => d.toNumber();

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function addServiceFee(db: PrismaClient, user: SessionUser, accountId: string, args: {
  periodMonth: Date; amount: number; dueDate?: Date; note?: string;
}): Promise<ServiceFee> {
  const acc = await getWritableAccount(db, user, accountId);
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
  amount: number; dueDate: Date | null; note: string | null; periodMonth: Date;
}>): Promise<ServiceFee> {
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
export async function listCompanyServiceFees(db: PrismaClient, user: SessionUser, opts?: {
  status?: ServiceFeeStatus; from?: Date; to?: Date;
}) {
  // The billing roll-up is money, so it needs `view_financials`. Note that getDashboardStats calls
  // this UNCONDITIONALLY for `finance.serviceFeesOutstanding` — which is safe only because
  // leadScopeWhere already refuses ONBOARDING before the dashboard reaches this line. A MEMBER
  // holds view_financials, so their dashboard and billing page are unchanged.
  assertCan(user, "view_financials");
  const scope = accountScopeWhere(user);
  const accounts = await db.account.findMany({ where: scope, orderBy: { name: "asc" } });
  const where: { companyId: string; accountId: { in: string[] }; status?: ServiceFeeStatus; periodMonth?: { gte?: Date; lte?: Date } } = {
    companyId: scope.companyId, accountId: { in: accounts.map((a) => a.id) },
  };
  if (opts?.status) where.status = opts.status;
  if (opts?.from || opts?.to) {
    where.periodMonth = {};
    if (opts.from) where.periodMonth.gte = opts.from;
    if (opts.to) where.periodMonth.lte = opts.to;
  }
  const fees = accounts.length ? await db.serviceFee.findMany({ where }) : [];
  const rows = accounts.map((a) => {
    const mine = fees.filter((f) => f.accountId === a.id);
    const billed = mine.reduce((s, f) => s + num(f.amount), 0);
    const paid = mine.filter((f) => f.status === "PAID").reduce((s, f) => s + num(f.amount), 0);
    return { accountId: a.id, accountName: a.name, billed, paid, outstanding: billed - paid };
  });
  const totals = rows.reduce(
    (t, r) => ({ billed: t.billed + r.billed, paid: t.paid + r.paid, outstanding: t.outstanding + r.outstanding }),
    { billed: 0, paid: 0, outstanding: 0 }
  );
  return { totals, rows };
}
