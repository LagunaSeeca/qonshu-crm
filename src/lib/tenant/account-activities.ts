import type { PrismaClient, AccountActivity, AccountActivityKind } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAccountActivity(db: PrismaClient, user: SessionUser, accountId: string, args: { kind: AccountActivityKind; body: string; outcome?: string; occurredAt?: Date }): Promise<AccountActivity> {
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  return db.accountActivity.create({ data: { companyId: user.companyId!, accountId, authorId: user.id, kind: args.kind, body: args.body, outcome: args.outcome, occurredAt: args.occurredAt ?? new Date() } });
}

export async function listAccountActivities(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountActivity[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountActivity.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { occurredAt: "desc" } });
}
