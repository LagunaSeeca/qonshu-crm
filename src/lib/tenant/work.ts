import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { leadVisibilityWhere } from "./visibility";
import { getCompanySettings } from "./company";

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
 * Cross-entity "my work" view: open tasks + recent meetings across leads (tenant-visibility scoped)
 * and accounts (company-wide). Mirrors the scoping approach used by getDashboardStats.
 */
export async function getMyWork(db: PrismaClient, user: SessionUser): Promise<MyWork> {
  const companyId = user.companyId!;
  const { shareAllLeads } = await getCompanySettings(db, { companyId });
  const leadWhere = leadVisibilityWhere(user, shareAllLeads);
  const visibleLeads = await db.lead.findMany({ where: leadWhere, select: { id: true } });
  const leadIds = visibleLeads.map((l) => l.id);

  const [leadTasks, acctTasks, leadMeetings, acctMeetings] = await Promise.all([
    db.task.findMany({
      where: { companyId, leadId: { in: leadIds }, done: false },
      include: { lead: { select: { title: true } } },
      orderBy: { dueDate: "asc" },
    }),
    db.accountTask.findMany({
      where: { companyId, done: false },
      include: { account: { select: { name: true } } },
      orderBy: { dueDate: "asc" },
    }),
    db.activity.findMany({
      where: { companyId, leadId: { in: leadIds }, kind: "MEETING" },
      include: { lead: { select: { title: true } } },
      orderBy: { occurredAt: "desc" },
      take: 20,
    }),
    db.accountActivity.findMany({
      where: { companyId, kind: "MEETING" },
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
