import type { PrismaClient, SettlementEntry, SettlementType, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { accountScopeWhere } from "./scope";

const num = (d: { toNumber: () => number }) => d.toNumber();
const sum = (rows: SettlementEntry[], t: SettlementType) =>
  rows.filter((r) => r.type === t).reduce((s, r) => s + num(r.amount), 0);
const METHODS: SettlementMethod[] = ["CASH", "BANK_TRANSFER", "MANUAL"];
const sumByMethod = (rows: SettlementEntry[], t: SettlementType): Record<SettlementMethod, number> => {
  const byType = rows.filter((r) => r.type === t);
  return Object.fromEntries(
    METHODS.map((m) => [m, byType.filter((r) => r.method === m).reduce((s, r) => s + num(r.amount), 0)])
  ) as Record<SettlementMethod, number>;
};

export async function addSettlementEntry(db: PrismaClient, user: SessionUser, accountId: string, args: {
  type: SettlementType; amount: number; method: SettlementMethod; occurredAt: Date; note?: string;
}): Promise<SettlementEntry> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.settlementEntry.create({ data: {
    companyId: acc.companyId, accountId, type: args.type, amount: args.amount,
    method: args.method, occurredAt: args.occurredAt, note: args.note ?? null, createdById: user.id,
  } });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION. This used to be `{ id: entryId, companyId }`, which
// under Teams is the whole org: any MEMBER could delete any money row on any account in any team
// just by naming its id — on a ledger they could never see, and with the deletion changing that
// team's "owed" total. The entry's own account decides, via getAccount -> accountScopeWhere, and
// "no such entry" and "not your account" give the same answer so the pair is not an id oracle.
export async function deleteSettlementEntry(db: PrismaClient, user: SessionUser, entryId: string): Promise<void> {
  const found = await db.settlementEntry.findUnique({ where: { id: entryId }, select: { accountId: true } });
  if (!found || !(await getAccount(db, user, found.accountId))) throw new NotFoundError("entry not in scope");
  await db.settlementEntry.delete({ where: { id: entryId } });
}

export async function getAccountSettlement(db: PrismaClient, user: SessionUser, accountId: string) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const entries = await db.settlementEntry.findMany({ where: { companyId: acc.companyId, accountId }, orderBy: { occurredAt: "desc" } });
  const collected = sum(entries, "COLLECTED");
  const transferred = sum(entries, "TRANSFER");
  return {
    collected,
    transferred,
    owed: collected - transferred,
    collectedByMethod: sumByMethod(entries, "COLLECTED"),
    transferredByMethod: sumByMethod(entries, "TRANSFER"),
    entries,
  };
}

// The settlement roll-up, over the accounts the caller may actually see.
//
// It used to be the whole company for every role bar PARTNER_VIEWER, which it narrowed with its
// own hand-rolled sentinel. Under Teams "the whole company" is the whole org, so a MEMBER's cash
// page showed every team's collections. accountScopeWhere decides instead — own accounts for a
// MEMBER, own team for a team admin, the one account for a partner login — and the entry query is
// confined to exactly those account ids rather than re-deriving the rule a second time.
export async function listCompanySettlements(db: PrismaClient, user: SessionUser) {
  const scope = accountScopeWhere(user);
  const accounts = await db.account.findMany({ where: scope, orderBy: { name: "asc" } });
  const entries = accounts.length
    ? await db.settlementEntry.findMany({
        where: { companyId: scope.companyId, accountId: { in: accounts.map((a) => a.id) } },
      })
    : [];
  const rows = accounts.map((a) => {
    const mine = entries.filter((e) => e.accountId === a.id);
    const collected = sum(mine, "COLLECTED");
    const transferred = sum(mine, "TRANSFER");
    return { accountId: a.id, accountName: a.name, collected, transferred, owed: collected - transferred };
  });
  const totals = rows.reduce((t, r) => ({ collected: t.collected + r.collected, transferred: t.transferred + r.transferred, owed: t.owed + r.owed }), { collected: 0, transferred: 0, owed: 0 });
  return { totals, rows };
}
