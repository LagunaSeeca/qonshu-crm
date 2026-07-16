# Dashboard & Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real main dashboard (Sales / Activity / Partners / Finance KPIs for a period) + a Reports page giving weekly/biweekly/monthly/yearly/custom reports, overall or per-partner, with CSV export.

**Architecture:** Pure period resolver + two tenant-scoped aggregation services (dashboard, reports) over existing M2–M4 + settlement data; zod/guarded routes; design-system UI. Leads honor `leadVisibilityWhere`; accounts/analytics/settlements are company-wide.

**Tech Stack:** Next.js 16 (App Router, TS strict), React 19, Prisma 7 (pg adapter), Postgres (Docker 5433), Vitest (`fileParallelism:false`), shadcn/ui (base-ui variant — no `asChild`), lucide-react, sonner, Tailwind v4.

## Global Constraints

- TS `strict: true`; no `any`. No schema changes — M5 only aggregates existing data.
- Tenant data via `src/lib/tenant/*` scoped helpers; never raw `prisma.<tenantModel>` in route/page/UI. Leads MUST be scoped with `leadVisibilityWhere(user, shareAllLeads)` (from `@/lib/tenant/visibility`; read the flag via `getCompanySettings` from `@/lib/tenant/company`). Accounts/PartnerAppUser/PartnerPayment/SettlementEntry are company-wide (`{ companyId }`).
- Out-of-scope `accountId` → 404 (`NotFoundError` from `@/lib/auth/guards`). Invalid/reversed range → 400. Empty period → zeroed KPIs, never an error.
- Money is Decimal → `.toNumber()` in aggregation, `Number(x)` in tests.
- Reuse: `prisma` (`@/db/client`), `getSessionUser` (`@/lib/auth/session`), `getAccount` (`@/lib/tenant/accounts`), `listCompanySettlements`/`getAccountSettlement` (`@/lib/tenant/settlements`), `getAccountAnalytics` (`@/lib/tenant/partner-analytics`), `errorResponse`/`UnauthorizedError` (`@/lib/http`), `testPrisma`/`resetDb` (`@/test/db`), UI in `src/components/ui`.
- Docker flaky: `docker ps`; if it errors start `"/c/Program Files/Docker/Docker/Docker Desktop.exe"`, wait, retry; then `docker compose up -d` (5433). Suite is 80 green — keep it.

---

## File Structure
```
src/lib/reports/period.ts              # resolvePeriod -> {from,to,label}
src/lib/tenant/dashboard.ts            # getDashboardStats (4 KPI groups, scoped)
src/lib/tenant/reports.ts              # getReport + toCsv (pure)
src/app/api/dashboard/route.ts         # GET ?period&from&to
src/app/api/reports/route.ts           # GET ?period&from&to&accountId
src/app/api/reports/csv/route.ts       # GET same params -> text/csv
src/app/(app)/dashboard/page.tsx       # MODIFY: real KPIs + period selector
src/app/(app)/dashboard/DashboardView.tsx   # client: period selector + KPI groups
src/app/(app)/reports/page.tsx         # Reports page (server shell)
src/app/(app)/reports/ReportView.tsx   # client: period+partner selectors, tables, CSV button
src/components/Sidebar.tsx             # MODIFY: + Reports nav item
```

---

### Task 1: Period resolver

**Files:** Create `src/lib/reports/period.ts`; Test `src/lib/reports/period.test.ts`

**Interfaces:** `type PeriodType = "WEEKLY"|"BIWEEKLY"|"MONTHLY"|"YEARLY"|"CUSTOM"`; `resolvePeriod(input: { type: PeriodType; from?: string; to?: string }, now?: Date): { from: Date; to: Date; label: string }`. WEEKLY = last 7 days→now (label `Week of YYYY-MM-DD`), BIWEEKLY = 14 days (label `2 weeks to YYYY-MM-DD`), MONTHLY = current calendar month (label e.g. `July 2026`), YEARLY = current calendar year (label `2026`), CUSTOM = from/to (label `YYYY-MM-DD → YYYY-MM-DD`). Throws `RangeError` on invalid/reversed custom dates.

- [ ] **Step 1: Failing test** `src/lib/reports/period.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolvePeriod } from "./period";
const now = new Date("2026-07-15T12:00:00Z");
describe("resolvePeriod", () => {
  it("WEEKLY spans 7 days", () => {
    const p = resolvePeriod({ type: "WEEKLY" }, now);
    expect(Math.round((p.to.getTime() - p.from.getTime()) / 86400000)).toBe(7);
  });
  it("MONTHLY covers the calendar month with a readable label", () => {
    const p = resolvePeriod({ type: "MONTHLY" }, now);
    expect(p.from.toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(p.label).toContain("2026");
  });
  it("YEARLY starts Jan 1", () => {
    expect(resolvePeriod({ type: "YEARLY" }, now).from.toISOString().slice(0, 10)).toBe("2026-01-01");
  });
  it("CUSTOM honored; reversed throws", () => {
    const p = resolvePeriod({ type: "CUSTOM", from: "2026-06-01", to: "2026-06-10" }, now);
    expect(p.from.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(() => resolvePeriod({ type: "CUSTOM", from: "2026-06-10", to: "2026-06-01" }, now)).toThrow();
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/reports/period.ts`:
```ts
export type PeriodType = "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "YEARLY" | "CUSTOM";
const iso = (d: Date) => d.toISOString().slice(0, 10);
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function resolvePeriod(input: { type: PeriodType; from?: string; to?: string }, now: Date = new Date()): { from: Date; to: Date; label: string } {
  if (input.type === "CUSTOM") {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new RangeError("invalid dates");
    if (from > to) throw new RangeError("from after to");
    return { from, to, label: `${iso(from)} → ${iso(to)}` };
  }
  if (input.type === "MONTHLY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from, to: now, label: `${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}` };
  }
  if (input.type === "YEARLY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    return { from, to: now, label: `${now.getUTCFullYear()}` };
  }
  const days = input.type === "BIWEEKLY" ? 14 : 7;
  const from = new Date(now.getTime() - days * 86400000);
  return { from, to: now, label: input.type === "BIWEEKLY" ? `2 weeks to ${iso(now)}` : `Week of ${iso(from)}` };
}
```
- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: report period resolver (weekly/biweekly/monthly/yearly/custom)"`

---

### Task 2: Dashboard stats service

**Files:** Create `src/lib/tenant/dashboard.ts`; Test `src/lib/tenant/dashboard.test.ts`

**Interfaces:**
- `getDashboardStats(db, user, range: { from: Date; to: Date }): Promise<DashboardStats>` where
```ts
type DashboardStats = {
  sales: { openLeads: number; wonInPeriod: number; pipelineValue: number; weightedPipeline: number };
  activity: { meetingsDone: number; openTasks: number; overdueTasks: number };
  partners: { accounts: number; activeAccounts: number; appUsers: number; activeAppUsers: number; paymentsCount: number; paymentsAmount: number };
  finance: { collected: number; transferred: number; owed: number };
};
```
- Leads scoped with `leadVisibilityWhere(user, shareAllLeads)` (flag via `getCompanySettings`). `openLeads` = leads whose stage.type = OPEN. `wonInPeriod` = leads whose stage.type = WON AND `updatedAt` within range (documented approximation — a lead's last update marks its win). `pipelineValue` = Σ value of OPEN-stage leads; `weightedPipeline` = Σ value × stage.probability/100 over the same. `meetingsDone` = lead `Activity` kind=MEETING with occurredAt in range (on visible leads) + `AccountActivity` kind=MEETING with occurredAt in range (company-wide). `openTasks`/`overdueTasks` across `Task` (visible leads) + `AccountTask` (company-wide): `!done`, overdue also `dueDate < range.to`. Partners from `Account` + `PartnerAppUser` (all-time counts) + `PartnerPayment` in range. Finance = `listCompanySettlements` totals (all-time).

- [ ] **Step 1: Failing test** `src/lib/tenant/dashboard.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead } from "./leads";
import { getDashboardStats } from "./dashboard";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

describe("dashboard stats", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("counts open leads, pipeline value and meetings; isolates tenants", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-dash" } });
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    const openStage = stages.find((s) => s.type === "OPEN")!;
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
    const lead = await createLead(testPrisma, user, { title: "D", contactName: "C", stageId: openStage.id, value: 1000 });
    await testPrisma.activity.create({ data: { companyId: c.id, leadId: lead.id, kind: "MEETING", body: "met", occurredAt: new Date("2026-07-10T10:00:00Z") } });
    await testPrisma.task.create({ data: { companyId: c.id, leadId: lead.id, title: "t", done: false, dueDate: new Date("2026-07-02T00:00:00Z") } });

    const s = await getDashboardStats(testPrisma, user, range);
    expect(s.sales.openLeads).toBe(1);
    expect(s.sales.pipelineValue).toBe(1000);
    expect(s.activity.meetingsDone).toBe(1);
    expect(s.activity.openTasks).toBe(1);
    expect(s.activity.overdueTasks).toBe(1);

    // other tenant sees nothing
    const c2 = await testPrisma.company.create({ data: { name: "B", slug: "b-dash" } });
    const u2 = await testPrisma.user.create({ data: { companyId: c2.id, email: "u@b.com", passwordHash: "x", name: "U2", role: "COMPANY_ADMIN" } });
    const s2 = await getDashboardStats(testPrisma, { id: u2.id, companyId: c2.id, role: "COMPANY_ADMIN" }, range);
    expect(s2.sales.openLeads).toBe(0);
    expect(s2.activity.meetingsDone).toBe(0);
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/tenant/dashboard.ts` — follow the Interfaces block above exactly. Sketch:
```ts
import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { leadVisibilityWhere } from "./visibility";
import { getCompanySettings } from "./company";
import { listCompanySettlements } from "./settlements";

const num = (d: { toNumber: () => number }) => d.toNumber();

export async function getDashboardStats(db: PrismaClient, user: SessionUser, range: { from: Date; to: Date }) {
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
  const pipelineValue = openLeads.reduce((s, l) => s + num(l.value), 0);
  const weightedPipeline = openLeads.reduce((s, l) => s + num(l.value) * ((stageById.get(l.stageId)?.probability ?? 0) / 100), 0);
  const leadIds = leads.map((l) => l.id);
  const [leadMeetings, acctMeetings, leadTasks, acctTasks] = await Promise.all([
    db.activity.count({ where: { companyId, leadId: { in: leadIds }, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
    db.accountActivity.count({ where: { companyId, kind: "MEETING", occurredAt: { gte: range.from, lte: range.to } } }),
    db.task.findMany({ where: { companyId, leadId: { in: leadIds }, done: false } }),
    db.accountTask.findMany({ where: { companyId, done: false } }),
  ]);
  const allOpenTasks = [...leadTasks, ...acctTasks];
  return {
    sales: { openLeads: openLeads.length, wonInPeriod, pipelineValue, weightedPipeline },
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
      paymentsCount: payments.length,
      paymentsAmount: payments.reduce((s, p) => s + num(p.amount), 0),
    },
    finance: settlements.totals,
  };
}
```
(Note: `leadIds` may be empty — Prisma handles `{ in: [] }` as no matches, which is correct.)
- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: dashboard stats service (sales/activity/partners/finance, visibility-scoped)"`

---

### Task 3: Reports service + CSV

**Files:** Create `src/lib/tenant/reports.ts`; Test `src/lib/tenant/reports.test.ts`

**Interfaces:**
- `getReport(db, user, opts: { range: { from: Date; to: Date }; label: string; accountId?: string }): Promise<Report>` where
```ts
type PartnerRow = { accountId: string; accountName: string; paymentsCount: number; paymentsAmount: number; collected: number; transferred: number; owed: number };
type Report = { label: string; scope: "ALL" | "PARTNER"; accountName?: string; kpis: DashboardStats; partnerRows: PartnerRow[] };
```
  — `kpis` = `getDashboardStats(db, user, range)` for scope ALL. For `accountId` (scope PARTNER): verify via `getAccount` (404 `NotFoundError` if not visible); `partnerRows` = just that partner's row; `accountName` set. For ALL: one row per company account (zeros allowed).
- `toCsv(report: Report): string` — pure. Header lines for the KPI summary then a partner table with header `Partner,Payments,Payments Amount,Collected,Transferred,Owed`; values escaped (wrap in quotes + double any quote when the value contains `,`/`"`/newline).

- [ ] **Step 1: Failing test** `src/lib/tenant/reports.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getReport, toCsv } from "./reports";
import type { SessionUser } from "@/lib/auth/guards";

const range = { from: new Date("2026-07-01T00:00:00Z"), to: new Date("2026-07-31T23:59:59Z") };

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner, Inc", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("reports", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("ALL scope lists partner rows; CSV escapes commas", async () => {
    const { user } = await setup("r1");
    const r = await getReport(testPrisma, user, { range, label: "July 2026" });
    expect(r.scope).toBe("ALL");
    expect(r.partnerRows.length).toBe(1);
    const csv = toCsv(r);
    expect(csv).toContain("Partner,Payments,Payments Amount,Collected,Transferred,Owed");
    expect(csv).toContain('"Partner, Inc"');
  });

  it("PARTNER scope rejects another tenant's account", async () => {
    const A = await setup("r2");
    const B = await setup("r3");
    await expect(getReport(testPrisma, B.user, { range, label: "x", accountId: A.acc.id })).rejects.toThrow();
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/tenant/reports.ts` per the Interfaces block: build `partnerRows` from `db.account.findMany({ where: { companyId } })` + `db.partnerPayment.findMany` (in range) + `listCompanySettlements(db,user).rows` (match by accountId); for PARTNER scope filter to the one account after `getAccount` check. `toCsv` example shape:
```
Report,July 2026
Scope,ALL

Metric,Value
Open leads,3
Won in period,1
Pipeline value,15000
Weighted pipeline,7250
Meetings done,4
Open tasks,5
Overdue tasks,2
Partner accounts,2
App users,24
Payments count,120
Payments amount,30000
Collected,16400
Transferred,8000
Owed,8400

Partner,Payments,Payments Amount,Collected,Transferred,Owed
"Partner, Inc",60,15000,8200,4000,4200
```
with an `esc(v)` helper wrapping values containing `,`/`"`/newline in quotes and doubling inner quotes.
- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: reports service + CSV export (all partners or one)"`

---

### Task 4: API routes

**Files:** Create `src/app/api/dashboard/route.ts`, `src/app/api/reports/route.ts`, `src/app/api/reports/csv/route.ts`

- [ ] **Step 1: Implement** — all session-guarded (`getSessionUser` → 401), resolve the period from `?period=WEEKLY|BIWEEKLY|MONTHLY|YEARLY|CUSTOM&from&to` via `resolvePeriod` (catch `RangeError` → 400 `{error:"invalid_range"}`), then call the service; `errorResponse(e)` in catch.
  - `/api/dashboard` → `getDashboardStats(prisma, user, { from, to })`.
  - `/api/reports` → `getReport(prisma, user, { range, label, accountId: sp.get("accountId") ?? undefined })`.
  - `/api/reports/csv` → same as reports, then:
```ts
const csv = toCsv(report);
return new NextResponse(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="report-${report.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv"` } });
```
- [ ] **Step 2: Build + test** — `npm run build` + `npm test` green. **Step 3: Commit** `git commit -am "feat: dashboard + reports API (incl. CSV export)"`

---

### Task 5: UI — dashboard, reports page, nav

**Files:** Create `src/app/(app)/dashboard/DashboardView.tsx`, `src/app/(app)/reports/page.tsx`, `src/app/(app)/reports/ReportView.tsx`; Modify `src/app/(app)/dashboard/page.tsx`, `src/components/Sidebar.tsx`; Test `src/app/(app)/reports/ReportView.test.tsx`

- [ ] **Step 1: Failing test** (mock `next/navigation`) — `ReportView` renders KPI labels + a partner row from `initialData`:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { ReportView } from "./ReportView";
const report = { label: "July 2026", scope: "ALL", kpis: { sales: { openLeads: 3, wonInPeriod: 1, pipelineValue: 15000, weightedPipeline: 7250 }, activity: { meetingsDone: 4, openTasks: 5, overdueTasks: 2 }, partners: { accounts: 2, activeAccounts: 2, appUsers: 24, activeAppUsers: 20, paymentsCount: 120, paymentsAmount: 30000 }, finance: { collected: 16400, transferred: 8000, owed: 8400 } }, partnerRows: [{ accountId: "a1", accountName: "Acme", paymentsCount: 60, paymentsAmount: 15000, collected: 8200, transferred: 4000, owed: 4200 }] };
describe("ReportView", () => {
  it("renders period label, KPIs and partner rows", () => {
    render(<ReportView accounts={[]} initialReport={report} />);
    expect(screen.getByText("July 2026")).toBeInTheDocument();
    expect(screen.getByText("Acme")).toBeInTheDocument();
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement**
  - `DashboardView.tsx` (client, props `{ initialStats, initialPeriod }`): a period selector (buttons WEEKLY/BIWEEKLY/MONTHLY/YEARLY + two date inputs for CUSTOM) refetching `/api/dashboard?...`; four labelled KPI card groups — **Sales** (Open leads, Won this period, Pipeline value $, Weighted $), **Activity** (Meetings done, Open tasks, Overdue — overdue in warning color), **Partners** (Partner accounts, App users (active/total), Payments count, Payments amount $), **Finance** (Collected $, Transferred $, **Owed $** emphasized). shadcn `Card`s, lucide icons, tabular numbers, toast on fetch error.
  - `dashboard/page.tsx` (server): load `getDashboardStats(prisma, user, resolvePeriod({type:"MONTHLY"}))` and render `<DashboardView initialStats={...} initialPeriod="MONTHLY" />` (replace the old placeholder cards).
  - `reports/page.tsx` (server): load company accounts (`listAccounts(prisma,user)` → id+name) + an initial MONTHLY ALL report via `getReport`; render `<ReportView accounts={...} initialReport={...} />`.
  - `ReportView.tsx` (client, props `{ accounts: {id,name}[]; initialReport }`): period selector (same as dashboard) + a partner `Select` ("All partners" or one) → refetch `/api/reports?...`; show the period `label`, the KPI summary (compact cards/list), and the partner table (Partner, Payments, Payments Amount, Collected, Transferred, Owed — tabular right-aligned); a **Download CSV** button linking/fetching `/api/reports/csv?<same params>` (trigger a download; on non-ok → toast.error). Empty state when no rows.
  - `Sidebar.tsx`: add a **Reports** nav item → `/reports` (lucide `FileBarChart`), keeping role-gating + the Sidebar test green.
- [ ] **Step 4: Build + test** — `npm run build` + `npm test` green. **Step 5: Commit** `git commit -am "feat: dashboard KPIs + reports page with CSV export"`

---

### Task 6: README

- [ ] **Step 1:** Add a "Dashboard & Reports" section to `README.md`: dashboard KPI groups + period selector; `/reports` page (weekly/biweekly/monthly/yearly/custom, all partners or one) + CSV download. **Step 2:** `npm test` + `npm run build` green. **Step 3: Commit** `git commit -am "docs: README dashboard + reports section"`

---

## Self-Review
- **Spec coverage:** period resolver incl. custom + labels (T1), dashboard four KPI groups + visibility + isolation (T2 tested), reports all/per-partner + 404 + CSV escaping (T3 tested), routes with 400/404 (T4), dashboard + reports UI + CSV button + nav (T5), docs (T6). All spec sections mapped.
- **Placeholder scan:** none — full code for period + dashboard service + test fixtures + CSV shape; UI gives exact props, endpoints, components, behavior.
- **Type consistency:** `PeriodType`/`resolvePeriod`, `DashboardStats` shape reused by `getDashboardStats` + `Report.kpis` + `ReportView` fixture, `PartnerRow` fields match the CSV header order and the UI table columns.
