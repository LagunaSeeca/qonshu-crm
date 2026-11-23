import type { PrismaClient, AccountAsk } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAsk(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; detail?: string }): Promise<AccountAsk> {
  const acc = await getAccount(db, user, accountId);
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
// own account decides, via getAccount -> accountScopeWhere; "no such ask" and "not your account"
// deliberately give the same answer so the pair is not an id-probing oracle.
async function requireAskInScope(db: PrismaClient, user: SessionUser, askId: string): Promise<void> {
  const found = await db.accountAsk.findUnique({ where: { id: askId }, select: { accountId: true } });
  if (!found || !(await getAccount(db, user, found.accountId))) throw new NotFoundError("ask not in scope");
}

export async function resolveAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  await requireAskInScope(db, user, askId);
  return db.accountAsk.update({ where: { id: askId }, data: { status: "RESOLVED", resolvedAt: new Date() } });
}

export async function reopenAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  await requireAskInScope(db, user, askId);
  return db.accountAsk.update({ where: { id: askId }, data: { status: "OPEN", resolvedAt: null } });
}
