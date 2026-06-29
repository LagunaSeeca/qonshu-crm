import type { PrismaClient, AccountTask } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAccountTask(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; dueDate?: Date | null; assigneeId?: string | null }): Promise<AccountTask> {
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  if (args.assigneeId != null) {
    const a = await db.user.findFirst({ where: { id: args.assigneeId, companyId: user.companyId! } });
    if (!a) throw new NotFoundError("assignee not in tenant");
  }
  return db.accountTask.create({ data: { companyId: user.companyId!, accountId, title: args.title, dueDate: args.dueDate ?? null, assigneeId: args.assigneeId ?? null } });
}

export async function toggleAccountTask(db: PrismaClient, user: SessionUser, taskId: string, done: boolean): Promise<AccountTask> {
  const found = await db.accountTask.findFirst({ where: { id: taskId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("task not in tenant");
  return db.accountTask.update({ where: { id: taskId }, data: { done } });
}

export async function listAccountTasks(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountTask[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountTask.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }] });
}

export function isOverdue(task: AccountTask): boolean {
  return !task.done && !!task.dueDate && task.dueDate < new Date();
}
