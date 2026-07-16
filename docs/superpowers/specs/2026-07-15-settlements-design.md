# Qonshu CRM — Settlements / Bank Ledger

**Date:** 2026-07-15
**Status:** Approved design
**Scope:** Feature module (after M4 analytics; before/alongside M5 reporting)

## Context

Money the partner apps collect lands in the company's bank account; the company then
disburses cash to partners. The operator needs to see, per partner, how much has been
collected and how much has been handed over, plus a registry of every entry. Entries
are **manually recorded** (not derived from the M4 payment feed) — the ledger is the
operator's own bookkeeping of bank reality.

Builds on M1 tenant foundation, M3 partner Accounts, and the design system.

## Goals

- Per partner Account: record **COLLECTED** (money into the bank) and **TRANSFER**
  (cash paid out to the partner) entries; see `owed = collected − transferred`.
- A company-level **Settlements** page: company totals + per-partner breakdown.
- A full chronological **registry** of entries per partner.
- Company Admin records/deletes entries; all members can view.

## Non-Goals

- Auto-deriving collected amounts from `PartnerPayment` (explicitly manual per decision).
- Invoicing, fees/commission calculation, multi-currency, bank API integration, exports (M5 may add reports).

## Roles

- **COMPANY_ADMIN**: create + delete settlement entries.
- **MEMBER**: view settlements + registry (read-only).
- **SUPER_ADMIN**: no access (platform role, redirected out of tenant app).

## Data Model (Prisma)

```
SettlementEntry
  id, companyId, accountId,
  type SettlementType,          // COLLECTED | TRANSFER
  amount Decimal,
  method SettlementMethod?,     // CASH | BANK_TRANSFER  (used for TRANSFER; optional otherwise)
  occurredAt DateTime,
  note String?,
  createdById String,
  createdAt DateTime @default(now())
  @@index([companyId, accountId])
  @@index([companyId, type])

enum SettlementType { COLLECTED  TRANSFER }
enum SettlementMethod { CASH  BANK_TRANSFER }
```
Cascades from Account (deleting a partner removes its ledger) and from Company.

## Aggregation

- `getAccountSettlement(db, user, accountId)` → `{ collected, transferred, owed, entries[] }`
  — scoped via M3 `getAccount` (company-wide account visibility); entries newest-first;
  `owed = collected − transferred` (may be negative if over-paid).
- `listCompanySettlements(db, user)` → `{ totals: { collected, transferred, owed }, rows: [{ accountId, accountName, collected, transferred, owed }] }`
  — all accounts in the company (including those with no entries → zeros).

## Architecture (reuses existing patterns)

- `src/lib/tenant/settlements.ts` — scoped `addSettlementEntry` (admin enforced at route),
  `deleteSettlementEntry`, `getAccountSettlement`, `listCompanySettlements`.
- `src/app/api/settlements/route.ts` (GET company summary);
  `src/app/api/accounts/[id]/settlement/route.ts` (GET ledger, POST entry — `assertRole(["COMPANY_ADMIN"])`);
  `src/app/api/accounts/[id]/settlement/[entryId]/route.ts` (DELETE — admin only).
- UI: `src/app/(app)/settlements/page.tsx` — company totals cards + per-partner table
  (name, collected, transferred, **owed**), rows link to the partner's account detail.
  `src/app/(app)/accounts/[id]/Settlement.tsx` — a new **Settlement** tab on the account
  detail: balance cards, add-entry form (type/amount/method/date/note — admin only),
  and the registry table with delete (admin only). Sidebar gains a **Settlements** item.
- All amounts Decimal → `.toNumber()`; money right-aligned tabular in UI; sonner toasts.

## Error Handling

- Cross-tenant / unknown account or entry → 404 (`NotFoundError` → existing mapping).
- Non-admin POST/DELETE → 403 (`assertRole`).
- amount ≤ 0 or invalid date → 400 (zod).

## Testing

- **Isolation:** company A cannot read/modify B's ledger (404/empty).
- **Owed math:** COLLECTED 500 + 300, TRANSFER 200 → collected 800, transferred 200, owed 600.
- **Company summary:** totals equal the sum of per-partner rows; accounts with no entries show zeros.
- **Admin guard:** member POST/DELETE → 403; admin succeeds.
- **Delete:** removing an entry updates the totals.

## Success Criteria

- Admin opens **Settlements**, sees company totals + per-partner collected/transferred/owed;
  opens a partner's **Settlement** tab, records a COLLECTED and a TRANSFER entry, sees the
  balance update and both in the registry; a member sees the same data but no add/delete.
- Isolation + math + guard tests pass; `npm run build` clean.
