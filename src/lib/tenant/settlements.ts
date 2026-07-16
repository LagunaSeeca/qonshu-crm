import type { PrismaClient, SettlementEntry, SettlementType, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

const num = (d: { toNumber: () => number }) => d.toNumber();
const sum = (rows: SettlementEntry[], t: SettlementType) =>
  rows.filter((r) => r.type === t).reduce((s, r) => s + num(r.amount), 0);

export async function addSettlementEntry(db: PrismaClient, user: SessionUser, accountId: string, args: {
  type: SettlementType; amount: number; method?: SettlementMethod; occurredAt: Date; note?: string;
}): Promise<SettlementEntry> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.settlementEntry.create({ data: {
    companyId: user.companyId!, accountId, type: args.type, amount: args.amount,
    method: args.method ?? null, occurredAt: args.occurredAt, note: args.note ?? null, createdById: user.id,
  } });
}

export async function deleteSettlementEntry(db: PrismaClient, user: SessionUser, entryId: string): Promise<void> {
  const found = await db.settlementEntry.findFirst({ where: { id: entryId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("entry not in tenant");
  await db.settlementEntry.delete({ where: { id: entryId } });
}

export async function getAccountSettlement(db: PrismaClient, user: SessionUser, accountId: string) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const entries = await db.settlementEntry.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { occurredAt: "desc" } });
  const collected = sum(entries, "COLLECTED");
  const transferred = sum(entries, "TRANSFER");
  return { collected, transferred, owed: collected - transferred, entries };
}

export async function listCompanySettlements(db: PrismaClient, user: SessionUser) {
  if (!user.companyId) throw new Error("no tenant context");
  const [accounts, entries] = await Promise.all([
    db.account.findMany({ where: { companyId: user.companyId }, orderBy: { name: "asc" } }),
    db.settlementEntry.findMany({ where: { companyId: user.companyId } }),
  ]);
  const rows = accounts.map((a) => {
    const mine = entries.filter((e) => e.accountId === a.id);
    const collected = sum(mine, "COLLECTED");
    const transferred = sum(mine, "TRANSFER");
    return { accountId: a.id, accountName: a.name, collected, transferred, owed: collected - transferred };
  });
  const totals = rows.reduce((t, r) => ({ collected: t.collected + r.collected, transferred: t.transferred + r.transferred, owed: t.owed + r.owed }), { collected: 0, transferred: 0, owed: 0 });
  return { totals, rows };
}
