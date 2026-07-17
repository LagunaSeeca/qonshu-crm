# Qonshu CRM — Account Extensions: App Installs, Custom Fields, Service Fees

**Date:** 2026-07-17
**Status:** Approved design
**Scope:** Three user-requested features on top of M3 Accounts + M4 Analytics.

## Context

Three requests, all account-centric:
1. Track **app installations** (iOS vs Android) coming from the partner API, plus the **app token** that tells us a user actually downloaded *and logged in* → an activation signal.
2. **Custom fields per account** (e.g. total area, contract value) definable by the company.
3. Track the **service fee each account pays us** monthly for using our app — kept strictly separate from the resident payments collected *through* the app (M4 `PartnerPayment`) and from the settlement ledger.

## Non-Goals

- Real partner API calls (mock continues; same `PartnerAnalyticsSource` seam).
- Invoicing/PDF, tax, proration, payment gateway for service fees (manual status tracking only).
- Custom fields on leads (accounts only), field-level permissions, formula fields.

---

## 1. App installs + activation

**Model** — extend `PartnerAppUser`:
```
platform   AppPlatform @default(UNKNOWN)   // IOS | ANDROID | UNKNOWN
installedAt DateTime?                       // when the app was installed
lastLoginAt DateTime?                       // set when the app token is issued/seen
appToken    String?                         // opaque token from the partner API; presence => signed in
enum AppPlatform { IOS  ANDROID  UNKNOWN }
```
**Activation definition:** a user is *activated* when `lastLoginAt` is set (equivalently, an `appToken` exists) — i.e. downloaded **and** logged in. This is the valuable insight: installs alone don't prove usage.

**Source:** `MockPartnerAnalyticsSource.fetchUsers` also returns `platform`, `installedAt`, `lastLoginAt`, `appToken` (a share of users deliberately un-activated). The real API maps its fields the same way — no aggregation/UI change.

**Analytics (account Analytics tab):** an **Installs & activation** block — total installs, **iOS** count, **Android** count, activated (signed-in) count, and an **activation rate** (activated / installs). Installs counted from `PartnerAppUser` with `installedAt` (all-time; the period filter still drives payments/trend).

**Dashboard:** a **Partners** tile "App installs" (iOS/Android split shown as a hint), linking to `/accounts`.

## 2. Custom fields per account

**Model:**
```
AccountFieldDef    id, companyId, label, type AccountFieldType, order Int, createdAt
                   @@index([companyId])  @@unique([companyId, label])
AccountFieldValue  id, companyId, accountId, fieldDefId, value String, updatedAt
                   @@unique([accountId, fieldDefId])  @@index([companyId, accountId])
enum AccountFieldType { TEXT  NUMBER  CURRENCY  DATE }
```
Values stored as strings, parsed/formatted per `type` for display (CURRENCY/NUMBER right-aligned tabular; DATE localized). Deleting a def cascades its values; deleting an account cascades its values.

**Rules:** **COMPANY_ADMIN** manages definitions (add/rename/reorder/delete). Any member may set values on an account. Definitions are company-wide, so every account shows the same field set (empty until filled).

**UI:** account detail gains a **Details** card listing each defined field with an inline editable value. A `/accounts/fields` admin page manages the definitions.

## 3. Service fees (what the account pays us)

**Model:**
```
ServiceFee  id, companyId, accountId,
            periodMonth DateTime,        // first day of the month the fee covers
            amount Decimal, dueDate DateTime?,
            status ServiceFeeStatus @default(UNPAID),   // UNPAID | PAID
            paidAt DateTime?, method SettlementMethod?, note String?,
            createdById, createdAt
            @@unique([accountId, periodMonth])          // one fee per account per month
            @@index([companyId, status])  @@index([companyId, accountId])
enum ServiceFeeStatus { UNPAID  PAID }
```
Explicitly **separate** from `PartnerPayment` (residents → account, via our app) and `SettlementEntry` (bank collected/cash transferred). This is *our revenue*: account → us.

**Rules:** **COMPANY_ADMIN** creates/edits/deletes fees and marks paid/unpaid; members view. `markPaid` sets `status=PAID`, `paidAt=now`, optional `method`; `markUnpaid` reverses (clears `paidAt`).

**Aggregation:** `getAccountServiceFees(db, user, accountId)` → `{ fees[], totalBilled, totalPaid, totalOutstanding }`. `listCompanyServiceFees(db, user, { status?, from?, to? })` → per-account rows + company totals (billed / paid / outstanding).

**UI:** a **Service fees** tab on the account detail (totals + fee table + admin add/mark-paid) and a company page `/service-fees` (totals + per-account rows + unpaid filter), with a sidebar item. A dashboard **Finance** tile "Service fees outstanding" → `/service-fees`.

---

## Architecture

Reuses M1–M5 patterns: tenant-scoped services in `src/lib/tenant/*` (gated via `getAccount`), zod-validated route handlers (admin-only writes where stated), design-system UI (base-ui shadcn — Selects need `items` value→label maps), sonner toasts. No raw `prisma.<tenantModel>` in route/page/UI.

## Error Handling

- Cross-tenant/unknown account, field def, or fee → 404 (`NotFoundError`). Non-admin writes where admin-only → 403. Invalid amount/date/type → 400. Duplicate fee for an account+month → 409. Duplicate field label per company → 409.

## Testing

- **Installs:** analytics returns installs total, iOS/Android split, activated count, activation rate; users without `lastLoginAt` are not activated; tenant isolation.
- **Custom fields:** admin-only def CRUD (member → 403); value upsert per account+def; duplicate label → 409; isolation; deleting a def removes its values.
- **Service fees:** create + unique per account/month (409); markPaid/markUnpaid transitions; totals (billed/paid/outstanding) math; company rollup; admin guard; isolation.

## Success Criteria

- Account Analytics shows installs (iOS/Android) + activation rate; dashboard shows an App-installs tile.
- Admin defines "Total area" + "Contract value"; both appear on every account and are editable; values persist.
- Admin bills an account a monthly service fee, marks it paid; `/service-fees` shows outstanding across accounts; these numbers never mix with app-collected payments or the settlement ledger.
- All tests green; `npm run build` + `npx tsc --noEmit` clean.
