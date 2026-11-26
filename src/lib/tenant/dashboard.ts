import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { can } from "@/lib/auth/guards";
import { leadScopeWhere, accountScopeWhere } from "./scope";
import { listCompanySettlements } from "./settlements";
import { listCompanyServiceFees } from "./service-fees";
import { listAccounts } from "./accounts";
import { getCompanyAnalytics, type CompanyAnalytics } from "./company-analytics";

export type DashboardStats = {
  sales: { openLeads: number; wonInPeriod: number };
  activity: { meetingsDone: number; openTasks: number; overdueTasks: number };
  partners: { accounts: number; activeAccounts: number; appUsers: number; activeAppUsers: number; uniquePayingUsers: number; engagedUsers: number; paymentsAmount: number; appInstalls: number; installsIos: number; installsAndroid: number };
  // The settlement figures (company cash) are PRESENT ONLY when the caller can("view_settlements").
  // For a MEMBER the three keys are ABSENT from the object entirely — not 0 — so they are absent
  // from the JSON and from the RSC props a server page hands to the client bundle, exactly as
  // reports.ts omits `payments`. A member still gets every other (general) statistic, and service
  // fees are CRM billing rather than settlement/cash data, so they stay.
  finance: {
    /**
     * Card money that landed in QONSHU'S OWN ACCOUNT — it EXCLUDES self-collecting buildings
     * (Account.collectionMode === "SELF"), whose residents' money never reaches Qonshu. So this
     * is "cash we are holding", not "cash our buildings took". A consumer must NOT label it a
     * bare "Collected": the figure DROPS the moment a building is switched to SELF, and a reader
     * comparing months would read that as lost revenue. Show `selfCollected` beside it.
     */
    collected?: number;
    transferred?: number;
    owed?: number;
    /**
     * Card money SELF-collecting buildings took themselves, over the same period. Deliberately
     * NOT additive with `collected` (different pockets) — never sum the two into one "total
     * collected" tile. It is here because those buildings still owe Qonshu a service fee, so the
     * figure is the base that fee is justified against.
     */
    selfCollected?: number;
    serviceFeesOutstanding: number;
  };
};

// The "partners" section used to read the persisted PartnerAppUser/PartnerPayment mock tables.
// It now reuses getCompanyAnalytics — the same LIVE fan-out to the external Partner API used by
// the company-wide analytics page — for the selected range, and just maps its summed totals onto
// the dashboard's existing KPI shape. Accounts that aren't partner-configured or that error are
// silently excluded from the totals (never fatal to the page); account/activeAccount counts stay
// a local DB read since Account itself is CRM data, not partner-app data. No DB writes occur.
//
// `opts.analytics` lets a caller that has ALREADY run getCompanyAnalytics for the same range hand
// it over instead of making this function repeat the whole live fan-out (getReport does: it needs
// the same per-account payment pages for its row detail). The partner KPIs are read off it
// unchanged, so the figures are identical either way — this only stops the second fan-out.
export async function getDashboardStats(
  db: PrismaClient,
  user: SessionUser,
  range: { from: Date; to: Date },
  opts?: { analytics?: CompanyAnalytics },
): Promise<DashboardStats> {
  // leadScopeWhere throws for PARTNER_VIEWER / companyless callers, so the CRM numbers below can
  // never be computed outside a scope. Member = own leads, team admin = team, super admin = company.
  const leadWhere = leadScopeWhere(user);
  const { companyId } = leadWhere;
  // Stages of the teams in view: the caller's own team, or every team's (not the org template
  // rows, teamId null) for a super admin.
  const stageWhere = user.role === "SUPER_ADMIN"
    ? { companyId, teamId: { not: null } }
    : { companyId, teamId: user.teamId! };
  // The settlement roll-up asserts view_settlements, which a MEMBER does not hold: calling it
  // unconditionally would make a member's whole dashboard throw instead of rendering the general
  // statistics they ARE entitled to. Skip the fetch (not just the display) — the gate stays in
  // listCompanySettlements, this decides whether the figures belong in the DTO at all.
  const withSettlements = can(user, "view_settlements");
  // The account-relation filter for the counts below. It is the SAME scope listAccounts() reads
  // under (both are accountScopeWhere), so filtering through the relation describes exactly the
  // row set the old `accountId: { in: [...] }` list did — without materializing the ids.
  const accountWhere = accountScopeWhere(user);
  const [leads, stages, accounts, analytics, settlements, serviceFees] = await Promise.all([
    // Only the fields the roll-ups below read. For a SUPER_ADMIN `leadWhere` is the whole company,
    // and hydrating every column of every lead on each dashboard/report render is a large
    // per-request allocation for three values.
    db.lead.findMany({ where: leadWhere, select: { id: true, stageId: true, wonAt: true } }),
    db.stage.findMany({ where: stageWhere }),
    listAccounts(db, user),
    opts?.analytics ?? getCompanyAnalytics(db, user, range),
    // THE RANGE IS PASSED, not defaulted. Called without a period, listCompanySettlements falls
    // back to currentSettlementPeriod() (this calendar month), so the three cash KPIs described a
    // different window from every other figure in this DTO: the period selector moved sales,
    // activity and partner numbers while Collected/Transferred/Owed sat on the current month, and
    // reports.ts (which DOES pass the range to its own roll-up) printed both side by side,
    // unlabelled. Same window for every number here or they cannot be read together.
    withSettlements ? listCompanySettlements(db, user, { from: range.from, to: range.to }) : null,
    listCompanyServiceFees(db, user),
  ]);
  const stageById = new Map(stages.map((s) => [s.id, s]));
  const openLeads = leads.filter((l) => stageById.get(l.stageId)?.type === "OPEN");
  // Counted on wonAt (set once at the WON transition), NOT updatedAt, which any edit bumps.
  const wonInPeriod = leads.filter(
    (l) => stageById.get(l.stageId)?.type === "WON" && l.wonAt && l.wonAt >= range.from && l.wonAt <= range.to,
  ).length;
  // Scoped through the parent relation rather than by sending every lead/account id back as an
  // `IN` list (the same shape work.ts uses): an org-wide list is both a big bind-parameter payload
  // — tens of thousands of ids approaches Postgres' 65535 ceiling — and it is work the database
  // can do itself. Open/overdue are counted rather than fetched; `dueDate: { lt }` already
  // excludes nulls, exactly as the old `t.dueDate && t.dueDate < range.to` filter did.
  const [leadMeetings, acctMeetings, openLeadTasks, overdueLeadTasks, openAcctTasks, overdueAcctTasks] =
    await Promise.all([
      db.activity.count({ where: { companyId, lead: leadWhere, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
      db.accountActivity.count({ where: { companyId, account: accountWhere, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
      db.task.count({ where: { companyId, lead: leadWhere, done: false } }),
      db.task.count({ where: { companyId, lead: leadWhere, done: false, dueDate: { lt: range.to } } }),
      db.accountTask.count({ where: { companyId, account: accountWhere, done: false } }),
      db.accountTask.count({ where: { companyId, account: accountWhere, done: false, dueDate: { lt: range.to } } }),
    ]);
  return {
    sales: { openLeads: openLeads.length, wonInPeriod },
    activity: {
      meetingsDone: leadMeetings + acctMeetings,
      openTasks: openLeadTasks + openAcctTasks,
      overdueTasks: overdueLeadTasks + overdueAcctTasks,
    },
    partners: {
      accounts: accounts.length,
      activeAccounts: accounts.filter((a) => a.status === "ACTIVE").length,
      appUsers: analytics.totals.appUsers,
      activeAppUsers: analytics.totals.activeUsers, // = Partner API logged_in_users ("active on app")
      uniquePayingUsers: analytics.totals.uniquePayingUsers,
      engagedUsers: analytics.totals.engagedUsers,
      paymentsAmount: analytics.totals.paymentsAmount,
      appInstalls: analytics.totals.installs,
      installsIos: analytics.totals.iosInstalls,
      installsAndroid: analytics.totals.androidInstalls,
    },
    finance: {
      ...(settlements
        ? {
            collected: settlements.totals.collected,
            transferred: settlements.totals.transferred,
            owed: settlements.totals.owed,
            selfCollected: settlements.totals.selfCollected,
          }
        : {}),
      serviceFeesOutstanding: serviceFees.totals.outstanding,
    },
  };
}
