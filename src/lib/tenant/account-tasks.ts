import type { PrismaClient, AccountTask } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAccountTask(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; dueDate?: Date | null; assigneeId?: string | null }): Promise<AccountTask> {
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  if (args.assigneeId != null) {
    const a = await db.user.findFirst({ where: { id: args.assigneeId, companyId: account.companyId } });
    if (!a) throw new NotFoundError("assignee not in tenant");
  }
  return db.accountTask.create({ data: { companyId: account.companyId, accountId, title: args.title, dueDate: args.dueDate ?? null, assigneeId: args.assigneeId ?? null } });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION, not the companyId.
//
// This used to be `findFirst({ where: { id: taskId, companyId } })`. Under the old model companyId
// was the customer boundary, so that was a tenancy check. Under Teams it is the WHOLE ORG: every
// task in Qonshu matched, so any MEMBER could flip the state of any task on any account in any
// team just by naming its id — a task list they could never see, mutated by id. The row's own
// account is what decides, and getAccount applies accountScopeWhere (own accounts for a MEMBER,
// own team for a team admin), so the parent is resolved FIRST and the child id trusted only after.
export async function toggleAccountTask(db: PrismaClient, user: SessionUser, taskId: string, done: boolean): Promise<AccountTask> {
  const found = await db.accountTask.findUnique({ where: { id: taskId }, select: { accountId: true } });
  // One NotFoundError for both arms: "no such task" and "not your account" must be the same
  // answer, or the difference between them is an id-probing oracle over the whole org.
  if (!found || !(await getAccount(db, user, found.accountId))) throw new NotFoundError("task not in scope");
  return db.accountTask.update({ where: { id: taskId }, data: { done } });
}

export async function listAccountTasks(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountTask[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountTask.findMany({ where: { companyId: account.companyId, accountId }, orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }] });
}

export function isOverdue(task: AccountTask): boolean {
  return !task.done && !!task.dueDate && task.dueDate < new Date();
}
