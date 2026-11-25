import type { Account, PrismaClient, AccountTask } from "@prisma/client";
import { assertCan, ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { getAccount, getWritableAccount } from "./accounts";

// Who may be handed a task on this account: the people who can actually OPEN it. Mirrors
// tasks.ts assertAssignable. The old check was "any user in the company", which under the teams
// model is the whole org: a member could assign work to another team's users, who cannot see the
// account (a MEMBER sees only accounts they manage), so the task became a dead link in their list.
//
// VISIBLE SET = the account's manager, PLUS anyone ASSIGNED to the account, PLUS the COMPANY_ADMINs
// of the account's own team. A PARTNER_VIEWER or SUPER_ADMIN is never assignable.
//
// THE ASSIGNMENT ARM IS NEW, and it is the same fact accountScopeWhere now reads: an
// AccountAssignment row is what puts a building in a MEMBER's or an ONBOARDING user's scope. So
// "can be given work here" and "can see this" are derived from ONE source rather than drifting —
// which is exactly the bug the old company-wide check had in the other direction. An assignment is
// checked against THIS account by its (accountId, userId) unique key, so being assigned to some
// other building grants nothing here.
//
// Note what this does NOT widen: the candidate must still be an ACTIVE user of the account's own
// company. An ONBOARDING user assigned to the building is now assignable — deliberately, because
// the checklist steps are the work being handed over — and an ONBOARDING user who is NOT assigned
// is refused, because they cannot open the account at all.
async function assertAssignable(db: PrismaClient, account: Account, assigneeId: string): Promise<void> {
  if (assigneeId === account.accountManagerId) return;
  const candidate = await db.user.findUnique({
    where: { id: assigneeId },
    select: { role: true, status: true, companyId: true, teamId: true },
  });
  if (!candidate || candidate.status !== "ACTIVE" || candidate.companyId !== account.companyId) {
    throw new NotFoundError("assignee not in tenant");
  }
  if (candidate.role === "COMPANY_ADMIN" && candidate.teamId === account.teamId) return;
  const assigned = await db.accountAssignment.findUnique({
    where: { accountId_userId: { accountId: account.id, userId: assigneeId } },
    select: { id: true },
  });
  if (assigned) return;
  throw new ForbiddenError("assignee cannot see this account");
}

export async function addAccountTask(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; dueDate?: Date | null; assigneeId?: string | null }): Promise<AccountTask> {
  const account = await getWritableAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  if (args.assigneeId != null) {
    await assertAssignable(db, account, args.assigneeId);
  }
  return db.accountTask.create({ data: { companyId: account.companyId, accountId, title: args.title, dueDate: args.dueDate ?? null, assigneeId: args.assigneeId ?? null } });
}

// THE PARENT ACCOUNT IS THE AUTHORIZATION, not the companyId.
//
// This used to be `findFirst({ where: { id: taskId, companyId } })`. Under the old model companyId
// was the customer boundary, so that was a tenancy check. Under Teams it is the WHOLE ORG: every
// task in Qonshu matched, so any MEMBER could flip the state of any task on any account in any
// team just by naming its id — a task list they could never see, mutated by id. The row's own
// account is what decides, and getWritableAccount applies accountScopeWhere (manager-or-assigned
// for a MEMBER, own team for a team admin) PLUS the edit_accounts capability, so the parent is
// resolved FIRST and the child id trusted only after.
export async function toggleAccountTask(db: PrismaClient, user: SessionUser, taskId: string, done: boolean): Promise<AccountTask> {
  // THE CAPABILITY IS HOISTED ABOVE THE CHILD LOOKUP, and it has to be. getWritableAccount below
  // asserts it too (it is the chokepoint; do not remove it there), but it only runs once a task row
  // has been found — so leaving the check to it alone would answer ForbiddenError for a REAL task
  // id and NotFoundError for an invented one, i.e. an id-probing oracle over every account task in
  // the org for exactly the roles we are trying to keep out. Hoisted, the refusal is identical for
  // every id, because `edit_accounts` never looks at one.
  assertCan(user, "edit_accounts");
  const found = await db.accountTask.findUnique({ where: { id: taskId }, select: { accountId: true } });
  // One NotFoundError for both arms: "no such task" and "not your account" must be the same
  // answer, or the difference between them is an id-probing oracle over the whole org.
  if (!found || !(await getWritableAccount(db, user, found.accountId))) throw new NotFoundError("task not in scope");
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
