import type { PrismaClient, Task } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { getLead } from "./leads";

export async function addTask(db: PrismaClient, user: SessionUser, leadId: string, args: { title: string; dueDate?: Date | null; assigneeId?: string | null }): Promise<Task> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new Error("lead not in scope");
  return db.task.create({ data: { companyId: user.companyId!, leadId, title: args.title, dueDate: args.dueDate ?? null, assigneeId: args.assigneeId ?? null } });
}

export async function toggleTask(db: PrismaClient, user: SessionUser, taskId: string, done: boolean): Promise<Task> {
  const found = await db.task.findFirst({ where: { id: taskId, companyId: user.companyId! } });
  if (!found) throw new Error("task not in tenant");
  return db.task.update({ where: { id: taskId }, data: { done } });
}

export async function listTasks(db: PrismaClient, user: SessionUser, leadId: string): Promise<Task[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.task.findMany({ where: { companyId: user.companyId!, leadId }, orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }] });
}

export function isOverdue(task: Task): boolean {
  return !task.done && !!task.dueDate && task.dueDate < new Date();
}
