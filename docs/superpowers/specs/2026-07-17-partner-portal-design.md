# Qonshu CRM — Partner Portal (read-only partner logins)

**Date:** 2026-07-17
**Status:** Approved design
**Scope:** New access model on top of M1 auth + M3 accounts + M4 analytics + settlements/service fees.

## Context

Today only **your company's** staff log in (COMPANY_ADMIN / MEMBER), and partner companies (Acme Towers, TechFlow…) exist purely as **Account records** — data, not users.

Requested: give each partner company its own **read-only login** that shows **only their own data** — their analytics plus the settlement/payment records that concern them. They must not see other partners, must not see your sales pipeline, and must not be able to edit or add anything.

## Goals

- A partner user logs in and sees **only their own account's** Analytics, Settlements ledger, and Service fees.
- Everything is **read-only** for them — no create/update/delete anywhere.
- Your Company Admin sees **all partners** and can **filter Analytics by company**; Members keep today's access.
- Isolation is enforced in the **data layer**, not just hidden in the UI.

## Non-Goals

- Partner self-service (they can't edit their profile, dispute a fee, or upload files).
- Partner users seeing leads, tasks, meetings, custom fields, reports, other partners, or your team.
- Multiple accounts per partner user (exactly one).
- Partner-facing branding/theming.

## Roles

| Role | Scope |
|---|---|
| `SUPER_ADMIN` | Platform only (unchanged — redirected out of the tenant app). |
| `COMPANY_ADMIN` | Everything in their company; manages users incl. partner logins; **can filter Analytics by company**. |
| `MEMBER` | Today's access (CRM, accounts, settlements…), sees all partners. |
| **`PARTNER_VIEWER`** *(new)* | Tied to **exactly one Account**. Read-only. Sees only that account's Analytics, Settlements, Service fees. |

## Data model

```
User
  + accountId String?          // REQUIRED when role = PARTNER_VIEWER, null otherwise
  + account   Account?  @relation(fields: [accountId], references: [id])
  @@index([accountId])

enum Role { SUPER_ADMIN  COMPANY_ADMIN  MEMBER  PARTNER_VIEWER }   // extend existing enum
Invitation.role may now also be PARTNER_VIEWER, and gains accountId String? (carried to the created user)
```

Session (`SessionUser`) gains `accountId: string | null` so guards can act without a DB round-trip.

## Enforcement (the important part)

**Single chokepoint:** every account-scoped read already flows through `getAccount(db, user, accountId)` (analytics, settlements, service fees, activities, tasks, asks, attachments, custom fields). Extend it:

```
getAccount(db, user, id):
  where = { id, companyId: user.companyId }
  if (user.role === "PARTNER_VIEWER") where.id must also equal user.accountId   // else -> null (404)
```
So a partner user requesting another partner's id gets a 404 from every one of those paths — no per-route patching needed.

Additionally:
- `listAccounts(db, user)` → returns **only** their own account for PARTNER_VIEWER.
- `listCompanySettlements` / `listCompanyServiceFees` / `getCompanyAnalytics` → filtered to their single account for PARTNER_VIEWER (company-wide only for admin/member).
- `leadVisibilityWhere` / CRM services → PARTNER_VIEWER must never reach them; CRM routes and pages reject with `ForbiddenError` (403).
- **All writes**: every mutating route already calls `assertRole(user, [...])`. PARTNER_VIEWER appears in **no** write allowlist → 403 everywhere. Routes that currently allow "any authenticated member" to write (add activity/task/ask/attachment/field value, settlement/fee writes are already admin-only) MUST be tightened to `assertRole(user, ["COMPANY_ADMIN","MEMBER"])`.

## UI

- **Sidebar** for PARTNER_VIEWER: only **Analytics**, **Settlements**, **Service fees**. No Dashboard/My Work/CRM/Accounts/Reports/Users.
- Landing page after login: `/analytics`.
- `(app)/layout.tsx`: PARTNER_VIEWER hitting a non-permitted route → redirect to `/analytics`.
- **Analytics page**: gains a **company filter** (`All companies` + one entry per partner) for COMPANY_ADMIN/MEMBER. For PARTNER_VIEWER the filter is **absent** and the page is locked to their account.
- **Settlements page** (partner view): only their ledger + balances — no company totals across partners, no add/delete controls.
- **Service fees page** (partner view): only their fees — no add/mark-paid controls.
- Every screen renders read-only for them (no forms, no action buttons).

## Managing partner logins

Company Admin, in **Users**: invite a user with role **Partner (read-only)** + pick the **partner account**. Reuses the existing invitation flow (`Invitation` gains `accountId`); the accept page is unchanged. Validation: role PARTNER_VIEWER requires an `accountId` belonging to the company (else 400).

## Error handling

- Partner user requesting another account (any resource) → **404** (never reveal existence).
- Partner user attempting any write → **403**.
- Partner user hitting CRM/reports/users routes → **403** (API) / redirect to `/analytics` (pages).
- PARTNER_VIEWER without `accountId` (data bug) → treated as no access: 403, never "sees everything".

## Testing (security-critical)

- `getAccount` returns null for a PARTNER_VIEWER asking for another account; returns their own fine.
- Partner user: `listAccounts` → exactly one; `getCompanyAnalytics`/`listCompanySettlements`/`listCompanyServiceFees` → only their account's numbers.
- Partner user is denied (403) on: create lead, add activity/task/ask/attachment, set custom field value, settlement entry add/delete, service fee add/markPaid, stage/user admin.
- Partner user cannot read another tenant's data at all (existing companyId isolation still holds).
- Admin/member behaviour unchanged (regression).
- Invite validation: PARTNER_VIEWER without accountId → rejected; accountId from another company → rejected.

## Success criteria

- Admin filters Analytics by company; sees all partners.
- A partner login sees only their own Analytics/Settlements/Service fees, with no edit controls, and 404/403 on anything else.
- All existing tests stay green; new isolation + read-only tests pass; `npm run build` + `tsc` clean.
