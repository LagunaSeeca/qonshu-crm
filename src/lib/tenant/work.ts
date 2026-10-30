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
 * The parent must also sit inside the caller's team scope, so a task still assigned to me on a
 * record that has since moved to another team does not leak that record's title.
 * leadScopeWhere/accountScopeWhere also reject PARTNER_VIEWER and companyless callers.
 */
export async function getMyWork(db: PrismaClient, user: SessionUser): Promise<MyWork> {
  const { ownerId: _ownerId, ...leadBase } = leadScopeWhere(user);
  const { accountManagerId: _managerId, ...acctBase } = accountScopeWhere(user);
  void _ownerId; void _managerId;
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
