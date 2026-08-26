import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { leadVisibilityWhere } from "./visibility";
import { getCompanySettings } from "./company";
import { listCompanySettlements } from "./settlements";
import { listCompanyServiceFees } from "./service-fees";
import { listAccounts } from "./accounts";
import { getCompanyAnalytics } from "./company-analytics";

export type DashboardStats = {
  sales: { openLeads: number; wonInPeriod: number };
  activity: { meetingsDone: number; openTasks: number; overdueTasks: number };
  partners: { accounts: number; activeAccounts: number; appUsers: number; activeAppUsers: number; engagedUsers: number; paymentsAmount: number; appInstalls: number; installsIos: number; installsAndroid: number };
  finance: { collected: number; transferred: number; owed: number; serviceFeesOutstanding: number };
};

// The "partners" section used to read the persisted PartnerAppUser/PartnerPayment mock tables.
// It now reuses getCompanyAnalytics — the same LIVE fan-out to the external Partner API used by
// the company-wide analytics page — for the selected range, and just maps its summed totals onto
// the dashboard's existing KPI shape. Accounts that aren't partner-configured or that error are
// silently excluded from the totals (never fatal to the page); account/activeAccount counts stay
// a local DB read since Account itself is CRM data, not partner-app data. No DB writes occur.
export async function getDashboardStats(db: PrismaClient, user: SessionUser, range: { from: Date; to: Date }): Promise<DashboardStats> {
  const companyId = user.companyId!;
  const { shareAllLeads } = await getCompanySettings(db, { companyId });
  const leadWhere = leadVisibilityWhere(user, shareAllLeads);
  const [leads, stages, accounts, analytics, settlements, serviceFees] = await Promise.all([
    db.lead.findMany({ where: leadWhere }),
    db.stage.findMany({ where: { companyId } }),
    listAccounts(db, user),
    getCompanyAnalytics(db, user, range),
    listCompanySettlements(db, user),
    listCompanyServiceFees(db, user),
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
      appUsers: analytics.totals.appUsers,
      activeAppUsers: analytics.totals.activeUsers,
      engagedUsers: analytics.totals.engagedUsers,
      paymentsAmount: analytics.totals.paymentsAmount,
      appInstalls: analytics.totals.installs,
      installsIos: analytics.totals.iosInstalls,
      installsAndroid: analytics.totals.androidInstalls,
    },
    finance: { ...settlements.totals, serviceFeesOutstanding: serviceFees.totals.outstanding },
  };
}
