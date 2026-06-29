import type { PrismaClient, AccountAsk } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAsk(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; detail?: string }): Promise<AccountAsk> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.accountAsk.create({ data: { companyId: user.companyId!, accountId, authorId: user.id, title: args.title, detail: args.detail } });
}
export async function listAsks(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountAsk[]> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) return [];
  return db.accountAsk.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
}
export async function resolveAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  const found = await db.accountAsk.findFirst({ where: { id: askId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("ask not in tenant");
  return db.accountAsk.update({ where: { id: askId }, data: { status: "RESOLVED", resolvedAt: new Date() } });
}
export async function reopenAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  const found = await db.accountAsk.findFirst({ where: { id: askId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("ask not in tenant");
  return db.accountAsk.update({ where: { id: askId }, data: { status: "OPEN", resolvedAt: null } });
}
