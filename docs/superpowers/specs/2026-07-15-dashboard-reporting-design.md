# Qonshu CRM — Milestone 5: Dashboard & Reporting

**Date:** 2026-07-15
**Status:** Approved design
**Subsystem:** 5 of 5 (final; consumes M2 leads, M3 accounts, M4 analytics, Settlements)

## Context

Everything now produces data: leads/stages/activities (M2), partner accounts + meetings/tasks/asks (M3), partner app users/payments (M4), settlement ledger. M5 surfaces it: a **main dashboard** with the general numbers, and a **Reports** page giving weekly / biweekly / monthly / yearly (or custom) reports, **overall or for a specific partner**, viewable on screen and exportable as **CSV**.

## Goals

- Replace the placeholder dashboard with real, period-scoped KPIs across four groups.
- A Reports page: pick period type (WEEKLY/BIWEEKLY/MONTHLY/YEARLY/CUSTOM) + scope (all partners or one) → on-screen report + **Download CSV**.
- All numbers respect tenant isolation and the M2 lead-visibility rule.

## Non-Goals

- PDF export, scheduled/emailed reports, custom report builder, saved report configs.
- New data collection — M5 only aggregates existing data.

## Dashboard KPIs (period-scoped, default: this month)

- **Sales/CRM:** open leads (in OPEN-type stages), leads won in period (STAGE_CHANGE into a WON stage, or leads whose stage is WON with updatedAt in period — use the STAGE_CHANGE activity as the source of truth), pipeline value (Σ value of open leads) + weighted (Σ value × stage.probability/100).
- **Activity:** meetings done in period (lead Activities kind=MEETING + AccountActivity kind=MEETING), open tasks + overdue tasks (lead Tasks + AccountTasks, `!done`, dueDate < now for overdue).
- **Partners:** partner accounts count (by status), total app users (+active), payments collected in period (count + amount from PartnerPayment).
- **Finance:** settlement rollup — total collected, transferred, owed (all-time; ledger is cumulative).

Dashboard shows a period selector (same presets as reports) and is scoped to the session user's visibility (leads honor `leadVisibilityWhere`; accounts/analytics/settlements are company-wide).

## Reports

- **Period:** `PeriodType = WEEKLY | BIWEEKLY | MONTHLY | YEARLY | CUSTOM`; resolves to `{ from, to, label }` (e.g. "Week of 2026-07-13", "July 2026", "2026"). CUSTOM takes `from`/`to`; `from>to` → 400.
- **Scope:** all partners (company-wide) or one partner (`accountId`).
- **Content:** the same four KPI groups for the period + per-partner breakdown rows (when scope = all): partner, payments count/amount, collected, transferred, owed; and for partner scope: that partner's payment method/category breakdown + settlement breakdown.
- **CSV export:** `GET /api/reports/csv?...` streams `text/csv` (filename includes the period label + scope), containing the KPI summary rows + the breakdown rows. Same filters as the on-screen report.

## Architecture (reuses existing patterns)

- `src/lib/reports/period.ts` — `resolvePeriod({ type, from?, to? }, now?) → { from, to, label }`.
- `src/lib/tenant/dashboard.ts` — `getDashboardStats(db, user, range) → { sales, activity, partners, finance }` (scoped; leads via `leadVisibilityWhere`).
- `src/lib/tenant/reports.ts` — `getReport(db, user, { range, accountId? }) → { label, scope, kpis, partnerRows[], breakdowns? }`; `toCsv(report) → string` (pure, unit-testable).
- Routes: `GET /api/dashboard?period&from&to`, `GET /api/reports?period&from&to&accountId`, `GET /api/reports/csv?...` (same params, `text/csv`). All session-guarded; any member; out-of-scope account → 404.
- UI: `src/app/(app)/dashboard/page.tsx` — period selector + four KPI card groups (design system, lucide icons, tabular numbers). `src/app/(app)/reports/page.tsx` + `ReportView.tsx` — period + partner selectors, KPI summary, per-partner table (or partner breakdowns), **Download CSV** button. Sidebar gains a **Reports** item.

## Error Handling

- Invalid/reversed range → 400. Out-of-scope `accountId` → 404. Empty period → zeroed KPIs + empty tables (never an error).

## Testing

- **Period resolution:** WEEKLY/BIWEEKLY/MONTHLY/YEARLY windows + labels; CUSTOM honored; `from>to` throws.
- **Dashboard math:** seeded fixtures → open-lead count, won-in-period, pipeline + weighted value, meetings counted from both lead and account activities, open/overdue tasks, partner/app-user counts, payments in period, settlement rollup.
- **Visibility:** with `shareAllLeads=false`, a member's dashboard lead numbers cover only their own leads while the admin's cover all.
- **Isolation:** company A's dashboard/report never includes B's data.
- **Report scope:** partner-scoped report only includes that partner; unknown/other-tenant accountId → 404.
- **CSV:** `toCsv` produces a header + the expected rows; values escaped (commas/quotes).

## Success Criteria

- Dashboard shows real numbers for the chosen period across Sales/Activity/Partners/Finance, honoring visibility.
- Reports page produces a weekly/biweekly/monthly/yearly/custom report, overall or for one partner, and downloads a matching CSV.
- All tests pass; `npm run build` clean; sidebar Reports works.
