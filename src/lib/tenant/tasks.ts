import type { Lead, PrismaClient, Task } from "@prisma/client";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere } from "./scope";
import { getLead } from "./leads";

// Who may be handed a task on this lead: the people who can actually OPEN it.
//
// THE BUG THIS FIXES: the old check was `user.findFirst({ id: assigneeId, companyId })` — "any
// human in the org". Under the teams model that is the whole company, so a task could be
// assigned to a member of another team, or to a member of this team who is not the owner. Either
// way the assignee cannot see the lead (scope.ts: a MEMBER sees only its own rows), so the task
// shows up in their work list pointing at a 404 and the work is quietly lost.
//
// The visible set is exactly: the lead's OWNER, and the COMPANY_ADMINs ("Team Admins") of the
// lead's own team. A SUPER_ADMIN sees everything but is not assignable — it has no team and no
// work list of its own (see OWNABLE_ROLES in scope.ts).
async function assertAssignable(db: PrismaClient, lead: Lead, assigneeId: string): Promise<void> {
  if (assigneeId === lead.ownerId) return;
  const candidate = await db.user.findUnique({
    where: { id: assigneeId },
    select: { role: true, status: true, companyId: true, teamId: true },
  });
  // NotFoundError for "no such assignable user in this tenant" — unknown id, deactivated, or
  // another company's — so a caller cannot probe which of the three it was.
  if (!candidate || candidate.status !== "ACTIVE" || candidate.companyId !== lead.companyId) {
    throw new NotFoundError("assignee not in tenant");
  }
  // ForbiddenError, not NotFound: this is a real colleague the caller can legitimately see in
  // the picker, so the honest answer is "that person cannot open this lead", not "who?".
  if (!(candidate.role === "COMPANY_ADMIN" && candidate.teamId === lead.teamId)) {
    throw new ForbiddenError("assignee cannot see this lead");
  }
}

export async function addTask(
  db: PrismaClient, user: SessionUser, leadId: string,
  args: { title: string; dueDate?: Date | null; assigneeId?: string | null },
): Promise<Task> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  if (args.assigneeId != null) await assertAssignable(db, lead, args.assigneeId);
  return db.task.create({
    data: {
      companyId: lead.companyId, leadId, title: args.title,
      dueDate: args.dueDate ?? null, assigneeId: args.assigneeId ?? null,
    },
  });
}

// THE BUG THIS FIXES: this used to be `task.findFirst({ id: taskId, companyId })` and nothing
// else — the task's PARENT LEAD was never consulted. Any MEMBER who knew (or guessed) a task id
// could tick off or un-tick any task anywhere in the organisation, including on leads in other
// teams they cannot even read. Routing the task through getLead applies the full scope: company,
// team, and own-rows-only for a MEMBER.
export async function toggleTask(db: PrismaClient, user: SessionUser, taskId: string, done: boolean): Promise<Task> {
  const { companyId } = leadScopeWhere(user);
  const found = await db.task.findFirst({ where: { id: taskId, companyId } });
  if (!found) throw new NotFoundError("task not in tenant");
  const lead = await getLead(db, user, found.leadId);
  // Same message as above on purpose: whether the task does not exist or belongs to a lead out
  // of scope, the caller learns only that it is not theirs.
  if (!lead) throw new NotFoundError("task not in tenant");
  return db.task.update({ where: { id: taskId }, data: { done } });
}

export async function listTasks(db: PrismaClient, user: SessionUser, leadId: string): Promise<Task[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.task.findMany({
    where: { companyId: lead.companyId, leadId },
    orderBy: [{ done: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
  });
}

export function isOverdue(task: Task): boolean {
  return !task.done && !!task.dueDate && task.dueDate < new Date();
}
