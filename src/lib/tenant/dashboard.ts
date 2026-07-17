import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { leadVisibilityWhere } from "./visibility";
import { getCompanySettings } from "./company";
import { listCompanySettlements } from "./settlements";

export type DashboardStats = {
  sales: { openLeads: number; wonInPeriod: number };
  activity: { meetingsDone: number; openTasks: number; overdueTasks: number };
  partners: { accounts: number; activeAccounts: number; appUsers: number; activeAppUsers: number; engagedUsers: number; paymentsAmount: number; appInstalls: number; installsIos: number; installsAndroid: number };
  finance: { collected: number; transferred: number; owed: number };
};

const num = (d: { toNumber: () => number }) => d.toNumber();

export async function getDashboardStats(db: PrismaClient, user: SessionUser, range: { from: Date; to: Date }): Promise<DashboardStats> {
  const companyId = user.companyId!;
  const { shareAllLeads } = await getCompanySettings(db, { companyId });
  const leadWhere = leadVisibilityWhere(user, shareAllLeads);
  const [leads, stages, accounts, appUsers, payments, settlements] = await Promise.all([
    db.lead.findMany({ where: leadWhere }),
    db.stage.findMany({ where: { companyId } }),
    db.account.findMany({ where: { companyId } }),
    db.partnerAppUser.findMany({ where: { companyId } }),
    db.partnerPayment.findMany({ where: { companyId, occurredAt: { gte: range.from, lte: range.to } } }),
    listCompanySettlements(db, user),
  ]);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const openLeads = leads.filter((l) => stageById.get(l.stageId)?.type === "OPEN");
  const wonInPeriod = leads.filter((l) => stageById.get(l.stageId)?.type === "WON" && l.updatedAt >= range.from && l.updatedAt <= range.to).length;
  const leadIds = leads.map((l) => l.id);
  const [leadMeetings, acctMeetings, leadTasks, acctTasks] = await Promise.all([
    db.activity.count({ where: { companyId, leadId: { in: leadIds }, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
    db.accountActivity.count({ where: { companyId, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
    db.task.findMany({ where: { companyId, leadId: { in: leadIds }, done: false } }),
    db.accountTask.findMany({ where: { companyId, done: false } }),
  ]);
  const allOpenTasks = [...leadTasks, ...acctTasks];
  const engagedUsers = new Set(payments.map((p) => p.appUserId)).size;
  return {
    sales: { openLeads: openLeads.length, wonInPeriod },
    activity: {
      meetingsDone: leadMeetings + acctMeetings,
      openTasks: allOpenTasks.length,
      overdueTasks: allOpenTasks.filter((t) => t.dueDate && t.dueDate < range.to).length,
    },
    partners: {
      accounts: accounts.length,
      activeAccounts: accounts.filter((a) => a.status === "ACTIVE").length,
      appUsers: appUsers.length,
      activeAppUsers: appUsers.filter((u2) => u2.active).length,
      engagedUsers,
      paymentsAmount: payments.reduce((s, p) => s + num(p.amount), 0),
      appInstalls: appUsers.filter((u2) => u2.installedAt !== null).length,
      installsIos: appUsers.filter((u2) => u2.installedAt !== null && u2.platform === "IOS").length,
      installsAndroid: appUsers.filter((u2) => u2.installedAt !== null && u2.platform === "ANDROID").length,
    },
    finance: settlements.totals,
  };
}
