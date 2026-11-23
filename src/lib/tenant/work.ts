import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere, accountScopeWhere } from "./scope";

export type WorkParentType = "LEAD" | "ACCOUNT";

export type WorkTask = {
  id: string;
  title: string;
  dueDate: Date | null;
  parentType: WorkParentType;
  parentId: string;
  parentTitle: string;
};

export type WorkMeeting = {
  id: string;
  body: string;
  outcome: string | null;
  occurredAt: Date;
  parentType: WorkParentType;
  parentId: string;
  parentTitle: string;
};

export type MyWork = { tasks: WorkTask[]; meetings: WorkMeeting[] };

/**
 * Cross-entity "my work": open tasks + recent meetings that are MINE.
 *  - Task / AccountTask: assigneeId = me, OR unassigned on a lead/account I own.
 *  - Meetings: on a lead/account I own, or authored by me (capped at 20).
 * Ownership applies to every role (a team admin's "my work" is their own, not the team's).
 *
 * THE PARENT FILTER IS THE FULL SCOPE, UNMODIFIED — leadScopeWhere/accountScopeWhere exactly as
 * they come, `ownerId`/`accountManagerId` included. It used to strip those two keys so that the
 * `assigneeId: me` / `authorId: me` arms could reach across a MEMBER's whole TEAM, and that strip
 * was a title-level leak: a member who had once been handed a task on, or had logged a meeting
 * against, a teammate's record kept reading its name LIVE from a row they 404 on. Reassignment
 * clears open task assignments (leads.ts clearUnseeableAssignees, and the mirror of it in
 * updateAccount), but AUTHORSHIP of an Activity is permanent history and nothing can clear it —
 * so the strip left `authorId: me` matching any parent in the team forever.
 *
 * It costs no legitimate row. A MEMBER is only ever an assignable assignee on a record they
 * themselves own (tasks.ts / account-tasks.ts assertAssignable: the owner/manager, or a
 * COMPANY_ADMIN of the record's team — nobody else), and can only author an activity on a record
 * in their scope (activities.ts / account-activities.ts both resolve the parent through
 * getLead/getAccount first). So for a MEMBER, "assigned to me" and "authored by me" already imply
 * "mine" at the moment of the write; the only rows the full filter removes are ones where that
 * stopped being true — which is precisely the leak. For a COMPANY_ADMIN and a SUPER_ADMIN the
 * scope carries no owner key at all, so admin-assigned work is untouched.
 *
 * leadScopeWhere/accountScopeWhere also reject PARTNER_VIEWER and companyless callers.
 */
export async function getMyWork(db: PrismaClient, user: SessionUser): Promise<MyWork> {
  const leadBase = leadScopeWhere(user);
  const acctBase = accountScopeWhere(user);
  const companyId = leadBase.companyId;
  const me = user.id;

  const [leadTasks, acctTasks, leadMeetings, acctMeetings] = await Promise.all([
    db.task.findMany({
      where: {
        companyId, done: false, lead: leadBase,
        OR: [{ assigneeId: me }, { assigneeId: null, lead: { ownerId: me } }],
      },
      include: { lead: { select: { title: true } } },
      orderBy: { dueDate: "asc" },
    }),
    db.accountTask.findMany({
      where: {
        companyId, done: false, account: acctBase,
        OR: [{ assigneeId: me }, { assigneeId: null, account: { accountManagerId: me } }],
      },
      include: { account: { select: { name: true } } },
      orderBy: { dueDate: "asc" },
    }),
    db.activity.findMany({
      where: {
        companyId, kind: "MEETING", lead: leadBase,
        OR: [{ authorId: me }, { lead: { ownerId: me } }],
      },
      include: { lead: { select: { title: true } } },
      orderBy: { occurredAt: "desc" },
      take: 20,
    }),
    db.accountActivity.findMany({
      where: {
        companyId, kind: "MEETING", account: acctBase,
        OR: [{ authorId: me }, { account: { accountManagerId: me } }],
      },
      include: { account: { select: { name: true } } },
      orderBy: { occurredAt: "desc" },
      take: 20,
    }),
  ]);

  const tasks: WorkTask[] = [
    ...leadTasks.map((t) => ({
      id: t.id, title: t.title, dueDate: t.dueDate,
      parentType: "LEAD" as const, parentId: t.leadId, parentTitle: t.lead.title,
    })),
    ...acctTasks.map((t) => ({
      id: t.id, title: t.title, dueDate: t.dueDate,
      parentType: "ACCOUNT" as const, parentId: t.accountId, parentTitle: t.account.name,
    })),
  ].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1;
    if (!b.dueDate) return -1;
    return a.dueDate.getTime() - b.dueDate.getTime();
  });

  const meetings: WorkMeeting[] = [
    ...leadMeetings.map((a) => ({
      id: a.id, body: a.body, outcome: a.outcome, occurredAt: a.occurredAt,
      parentType: "LEAD" as const, parentId: a.leadId, parentTitle: a.lead.title,
    })),
    ...acctMeetings.map((a) => ({
      id: a.id, body: a.body, outcome: a.outcome, occurredAt: a.occurredAt,
      parentType: "ACCOUNT" as const, parentId: a.accountId, parentTitle: a.account.name,
    })),
  ]
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, 20);

  return { tasks, meetings };
}
