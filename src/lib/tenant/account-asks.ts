import type { PrismaClient, AccountAsk } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { assertCan, NotFoundError } from "@/lib/auth/guards";
import { getAccount, getWritableAccount } from "./accounts";

export async function addAsk(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; detail?: string }): Promise<AccountAsk> {
  const acc = await getWritableAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.accountAsk.create({ data: { companyId: acc.companyId, accountId, authorId: user.id, title: args.title, detail: args.detail } });
}

export async function listAsks(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountAsk[]> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) return [];
  return db.accountAsk.findMany({ where: { companyId: acc.companyId, accountId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION. Both of these used to look the ask up by
// `{ id, companyId }`, which under Teams is the whole org — so any MEMBER could resolve or reopen
// any ask on any account in any team by naming its id, on a list they could never see. The ask's
// own account decides, via getWritableAccount -> accountScopeWhere + edit_accounts; "no such ask"
// and "not your account" deliberately give the same answer so the pair is not an id-probing oracle.
async function requireAskInScope(db: PrismaClient, user: SessionUser, askId: string): Promise<void> {
  // Hoisted above the child lookup for the same reason as toggleAccountTask: `edit_accounts` is an
  // id-independent ROLE test, and asserting it only after the row is found would make the pair of
  // answers (403 real id / 404 invented id) the very oracle the shared NotFoundError avoids.
  assertCan(user, "edit_accounts");
  const found = await db.accountAsk.findUnique({ where: { id: askId }, select: { accountId: true } });
  if (!found || !(await getWritableAccount(db, user, found.accountId))) throw new NotFoundError("ask not in scope");
}

export async function resolveAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  await requireAskInScope(db, user, askId);
  return db.accountAsk.update({ where: { id: askId }, data: { status: "RESOLVED", resolvedAt: new Date() } });
}

export async function reopenAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  await requireAskInScope(db, user, askId);
  return db.accountAsk.update({ where: { id: askId }, data: { status: "OPEN", resolvedAt: null } });
}
