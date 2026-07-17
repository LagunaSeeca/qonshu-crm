import type { PrismaClient, ServiceFee, ServiceFeeStatus, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

const num = (d: { toNumber: () => number }) => d.toNumber();

function firstOfMonth(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export async function addServiceFee(db: PrismaClient, user: SessionUser, accountId: string, args: {
  periodMonth: Date; amount: number; dueDate?: Date; note?: string;
}): Promise<ServiceFee> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.serviceFee.create({ data: {
    companyId: user.companyId!, accountId, periodMonth: firstOfMonth(args.periodMonth), amount: args.amount,
    dueDate: args.dueDate ?? null, note: args.note ?? null, createdById: user.id,
  } });
}

export async function updateServiceFee(db: PrismaClient, user: SessionUser, feeId: string, data: Partial<{
  amount: number; dueDate: Date | null; note: string | null; periodMonth: Date;
}>): Promise<ServiceFee> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.serviceFee.findFirst({ where: { id: feeId, companyId: user.companyId } });
  if (!found) throw new NotFoundError("fee not in tenant");
  const { periodMonth, ...rest } = data;
  return db.serviceFee.update({
    where: { id: feeId },
    data: { ...rest, ...(periodMonth ? { periodMonth: firstOfMonth(periodMonth) } : {}) },
  });
}

export async function deleteServiceFee(db: PrismaClient, user: SessionUser, feeId: string): Promise<void> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.serviceFee.findFirst({ where: { id: feeId, companyId: user.companyId } });
  if (!found) throw new NotFoundError("fee not in tenant");
  await db.serviceFee.delete({ where: { id: feeId } });
}

export async function markFeePaid(db: PrismaClient, user: SessionUser, feeId: string, args: {
  method?: SettlementMethod; paidAt?: Date;
}): Promise<ServiceFee> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.serviceFee.findFirst({ where: { id: feeId, companyId: user.companyId } });
  if (!found) throw new NotFoundError("fee not in tenant");
  return db.serviceFee.update({
    where: { id: feeId },
    data: { status: "PAID", paidAt: args.paidAt ?? new Date(), method: args.method ?? found.method ?? null },
  });
}

export async function markFeeUnpaid(db: PrismaClient, user: SessionUser, feeId: string): Promise<ServiceFee> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.serviceFee.findFirst({ where: { id: feeId, companyId: user.companyId } });
  if (!found) throw new NotFoundError("fee not in tenant");
  return db.serviceFee.update({ where: { id: feeId }, data: { status: "UNPAID", paidAt: null, method: null } });
}

export async function getAccountServiceFees(db: PrismaClient, user: SessionUser, accountId: string) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const fees = await db.serviceFee.findMany({
    where: { companyId: user.companyId!, accountId },
    orderBy: { periodMonth: "desc" },
  });
  const totalBilled = fees.reduce((s, f) => s + num(f.amount), 0);
  const totalPaid = fees.filter((f) => f.status === "PAID").reduce((s, f) => s + num(f.amount), 0);
  return { fees, totalBilled, totalPaid, totalOutstanding: totalBilled - totalPaid };
}

export async function listCompanyServiceFees(db: PrismaClient, user: SessionUser, opts?: {
  status?: ServiceFeeStatus; from?: Date; to?: Date;
}) {
  if (!user.companyId) throw new Error("no tenant context");
  const companyId = user.companyId;
  const where: { companyId: string; status?: ServiceFeeStatus; periodMonth?: { gte?: Date; lte?: Date } } = { companyId };
  if (opts?.status) where.status = opts.status;
  if (opts?.from || opts?.to) {
    where.periodMonth = {};
    if (opts.from) where.periodMonth.gte = opts.from;
    if (opts.to) where.periodMonth.lte = opts.to;
  }
  const [accounts, fees] = await Promise.all([
    db.account.findMany({ where: { companyId }, orderBy: { name: "asc" } }),
    db.serviceFee.findMany({ where }),
  ]);
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
