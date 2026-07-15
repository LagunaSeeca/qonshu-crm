# Qonshu CRM — Milestone 4: Mobile-App Analytics (Mock Integration)

**Date:** 2026-06-30
**Status:** Approved design
**Subsystem:** 4 of 5 (depends on M3 accounts; feeds M5 dashboards)

## Context

Each partner Account (M3) has a mobile app whose stats Qonshu ingests. M4 builds
that ingestion + per-partner analytics behind a swappable source interface — a
**mock** implementation now (generates realistic data into DB tables), the real
mobile API later, with no changes to aggregation or UI. The analytics fill the
Account detail **Analytics tab** (currently a placeholder). Company-wide dashboards
(M5) reuse the same data + aggregation.

## Goals

- Per partner Account: active/total app users, outstanding user debt, payments
  (count + amount) with **method** (card/manual/cash) and **category** (apartment/
  parking/non-residential/utility) breakdowns, a **daily trend**, **top users**, and
  a **paginated transactions** list — over selectable date ranges.
- A mock data source that seeds ~90 days of users + payments per account, swappable
  for the real API behind one interface.

## Non-Goals (this milestone)

- Real mobile-API HTTP integration (mock now; interface ready). No credentials/webhooks.
- Company-wide/cross-partner dashboards + weekly/biweekly/monthly/yearly report exports (M5).
- Editing partner data from the CRM (analytics are read-only ingested data).

## Data Model (Prisma; scoped by companyId + accountId)

```
PartnerAppUser
  id, companyId, accountId, externalId, name,
  active Boolean @default(true), debt Decimal @default(0), joinedAt DateTime,
  createdAt
  @@index([companyId, accountId]) @@index([accountId, active])

PartnerPayment
  id, companyId, accountId, appUserId,
  occurredAt DateTime, amount Decimal,
  method PaymentMethod,      // CARD | MANUAL | CASH
  category PaymentCategory,  // APARTMENT | PARKING | NON_RESIDENTIAL | UTILITY
  createdAt
  @@index([companyId, accountId]) @@index([accountId, occurredAt])
```

Both cascade-delete when their Account is deleted (already M3 behavior extends via
the Account relation). "Utility payments" = payments where `category = UTILITY`.

## Source interface (mock now, real later)

```
interface PartnerAnalyticsSource {
  // pull raw data for an account (mock generates; real calls the mobile API)
  fetchUsers(accountId): Promise<RawUser[]>
  fetchPayments(accountId, since): Promise<RawPayment[]>
}
```
- `MockPartnerAnalyticsSource` — deterministic-ish generation: N app users (some
  inactive, varied debt) + ~90 days of payments per user across methods/categories.
- `syncAccountAnalytics(db, accountId, source)` — idempotent upsert of users +
  (re)generation of the account's payments window into the DB tables. Run by the seed
  and by a manual "Sync mock data" action.

## Analytics service (pure aggregation over the DB tables)

`getAccountAnalytics(db, user, accountId, range)` — scoped by companyId+accountId
(visible-account check via M3 `getAccount`); `range = { preset | from,to }` resolved
to a `[from,to]` window. Returns:
- **KPIs:** activeUsers, totalUsers, totalDebt, paymentsCount, paymentsAmount,
  utilityCount, utilityAmount (all within window).
- **byMethod:** amount + count per CARD/MANUAL/CASH.
- **byCategory:** amount + count per APARTMENT/PARKING/NON_RESIDENTIAL/UTILITY.
- **trend:** daily series `[{ date, amount, count }]` across the window.
- **topUsers:** top N app users by paid amount (name, paid, debt).
`listAccountPayments(db, user, accountId, { from, to, method?, category?, skip, take })`
— paginated transactions (occurredAt, amount, method, category, userName).

## Ranges

Presets **DAILY (today), 7D, 30D, 90D, 1Y** + **custom** `from`/`to`. A helper
`resolveRange(preset?, from?, to?)` returns `{ from, to }` (UTC day bounds).

## Architecture (reuses M1–M3)

- `src/lib/analytics/source.ts` — `PartnerAnalyticsSource` + `MockPartnerAnalyticsSource`.
- `src/lib/analytics/sync.ts` — `syncAccountAnalytics`.
- `src/lib/analytics/range.ts` — `resolveRange`.
- `src/lib/tenant/partner-analytics.ts` — scoped `getAccountAnalytics` + `listAccountPayments`.
- `src/app/api/accounts/[id]/analytics/route.ts` (GET, `?preset|from|to`),
  `.../analytics/payments/route.ts` (GET paginated), `.../analytics/sync/route.ts` (POST mock sync).
- UI: replace the Account detail **Analytics** placeholder tab with a real panel —
  range selector, KPI tiles, a payments-over-time trend chart, method + category
  breakdown charts, top-users table, transactions table (client component fetching
  the analytics + payments routes). Charts styled with the design system tokens.
- `prisma/seed.ts` — run `syncAccountAnalytics` (mock) for the demo accounts.

## Error Handling

- Cross-tenant / out-of-scope account → 404 (analytics service checks `getAccount`).
- Invalid range (from > to, unparseable) → 400.
- Empty data → analytics returns zeroed KPIs + empty series (UI shows empty states),
  never an error.

## Testing (Vitest, Postgres up)

- **Isolation:** company A cannot read B's account analytics/payments (404/empty).
- **Aggregation math:** seed a known set of payments; assert KPIs, byMethod, byCategory
  totals, utility = UTILITY category sum, and the daily trend bucket sums equal the
  raw totals within the window.
- **Range resolution:** presets map to correct windows; custom from/to honored;
  from>to → error.
- **Mock sync idempotency:** running `syncAccountAnalytics` twice yields a consistent
  user set (no duplicate externalIds) and a bounded payments window.
- **Pagination:** `listAccountPayments` respects skip/take + method/category filters,
  scoped to the account.

## Success Criteria

- Opening a partner account's Analytics tab shows KPIs, a trend chart, method +
  category breakdowns, top users, and a filterable/paginated transactions table; the
  range selector (presets + custom dates) updates all of them.
- A "Sync mock data" action (or the seed) populates realistic data; isolation +
  aggregation + range + pagination tests pass; `npm run build` clean.
- The mobile API can later replace `MockPartnerAnalyticsSource` with zero changes to
  the aggregation service or UI.
