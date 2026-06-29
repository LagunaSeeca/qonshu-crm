# Qonshu CRM — Milestone 3: Account Management (Partner Workspace)

**Date:** 2026-06-29
**Status:** Approved design
**Subsystem:** 3 of 5 (depends on M1 tenant foundation + M2 sales CRM + design system)

## Context

M1 gave multi-tenant foundation; M2 gave the sales CRM (leads pipeline) with a
scoped service layer (`src/lib/tenant/*`), zod-validated routes, and disk file
storage (`src/lib/files/storage.ts`); the design system gave shadcn/ui + the app
shell. M3 adds **Account Management**: a workspace for the companies a tenant has
already partnered with. Each partner Account holds an activity/meeting timeline,
tasks, "asks" (partner requests tracked to resolution), and files. Accounts are the
anchor that M4 (mobile-app analytics) will attach partner stats to.

A WON lead can be **converted** into an Account; accounts can also be created
standalone. All company members see all accounts (collaborative account management).

## Goals

- Create partner Accounts (standalone, or by converting a WON lead).
- Per account: log activities/meetings, manage tasks, track asks (open→resolved),
  upload files. Assign an account manager; set account status.
- Accounts list + account detail UI, inheriting the design system. Wire the existing
  sidebar "Accounts" entry.

## Non-Goals (this milestone)

- Mobile-app analytics per partner (M4) — leave a clearly-marked placeholder in the
  account detail for it.
- Dashboard/reporting aggregates (M5).
- Per-member account visibility toggle (accounts are company-wide by decision).
- Contracts/billing, contact-list management beyond a primary contact, automation.

## Roles & Visibility

- **MEMBER / COMPANY_ADMIN**: create/edit accounts and all workspace items; any
  member is assignable as account manager. Accounts are visible to ALL members of the
  company (scoped by `companyId` only — no per-owner restriction).
- **Deleting an account** (cascades its workspace items + files): COMPANY_ADMIN only.
- **SUPER_ADMIN**: no access (platform role; already redirected out of the tenant app).

## Data Model (Prisma; all tenant tables carry `companyId` + index)

```
Account
  id, companyId, name, website?, industry?,
  status AccountStatus @default(ACTIVE),         // ACTIVE | AT_RISK | CHURNED
  accountManagerId,                              // a company user
  primaryContactName?, primaryContactEmail?, primaryContactPhone?,
  value Decimal @default(0), currency String @default("USD"),
  sourceLeadId? ,                                // set when converted from a Won lead
  createdAt, updatedAt
  @@index([companyId]) @@index([companyId, status]) @@index([companyId, accountManagerId])

AccountActivity                                  // timeline: notes + meetings
  id, companyId, accountId, authorId?, kind AccountActivityKind, body,
  outcome?, occurredAt @default(now()), createdAt
  @@index([companyId, accountId])
  AccountActivityKind = NOTE | CALL | MEETING | EMAIL
  // a "meeting" is kind=MEETING; body=agenda/notes, outcome=result; attendees go in body

AccountTask
  id, companyId, accountId, title, dueDate?, done Boolean @default(false),
  assigneeId?, createdAt
  @@index([companyId, accountId])

AccountAsk                                       // partner requests tracked to resolution
  id, companyId, accountId, title, detail?, status AskStatus @default(OPEN),
  authorId?, createdAt, resolvedAt?
  @@index([companyId, accountId])
  AskStatus = OPEN | RESOLVED

AccountAttachment
  id, companyId, accountId, filename, diskPath, size Int, mime, uploadedById, createdAt
  @@index([companyId, accountId])
```

Deleting an Account cascades its activities, tasks, asks, and attachments (and removes
its files from disk). Files live under `uploads/<companyId>/account-<accountId>/`.

## Lead → Account conversion

On a lead whose current stage `type === "WON"`, the lead detail shows a **Convert to
Account** action. It creates an Account with `name = lead.companyName ?? lead.title`,
`primaryContactName/Email/Phone` from the lead, `value` from the lead,
`accountManagerId = lead.ownerId`, `sourceLeadId = lead.id`; it does NOT delete the
lead. Guard against double-conversion (if an Account with that `sourceLeadId` exists,
return 409 / show "already converted").

## Architecture (reuses M2 patterns)

- `src/lib/tenant/accounts.ts` — scoped Account CRUD + list (filter by status/manager,
  search) + `convertLeadToAccount(db, user, leadId)`.
- `src/lib/tenant/account-activities.ts`, `account-tasks.ts`, `account-asks.ts`,
  `account-attachments.ts` — scoped workspace services (mirror the lead equivalents;
  reuse `src/lib/files/storage.ts` for attachments). Asks add `resolveAsk`/`reopenAsk`.
- All account reads are scoped by `companyId` only (company-wide visibility) via a tiny
  `accountScopeWhere(user)` returning `{ companyId }`; out-of-scope → 404.
- `src/app/api/accounts/**` and `/accounts/[id]/activities|tasks|asks|attachments` —
  zod-validated, session-guarded route handlers; account delete asserts COMPANY_ADMIN.
- `src/app/(app)/accounts/**` — list page + account detail (shadcn, design system:
  header card + Tabs Activity / Tasks / Asks / Files + an **Analytics (coming in M4)**
  placeholder tab). Wire sidebar "Accounts" → `/accounts`. Convert button on WON leads.

## Error Handling

- Cross-tenant / missing account or item → 404 (NotFoundError, existing 404 mapping).
- Non-admin deleting an account → 403.
- Converting a non-WON lead, or a lead already converted → 409 with a clear message.
- Upload over 10 MB or missing file → 400; validation → 400; unique conflicts → 409.

## Testing (Vitest, Postgres up, serial)

- **Isolation:** company A cannot read/update B's accounts or any workspace item (404/empty).
- **Conversion:** converting a WON lead creates a linked Account (sourceLeadId, carried
  fields), does not delete the lead, and blocks double-conversion (409); converting a
  non-WON lead is rejected.
- **Asks workflow:** create OPEN → resolve sets RESOLVED + resolvedAt → reopen sets OPEN.
- **Tasks/activities/attachments:** scoped create/list; account delete removes files;
  attachment download tenant-guarded.
- **Delete guard:** member cannot delete an account (403 at route); admin can.

## Success Criteria

- A member opens Accounts, creates a partner account (or converts a Won lead), logs a
  meeting + a task + an ask, resolves the ask, uploads a file.
- All accounts are visible to every member of the company, isolated from other companies.
- Isolation + conversion + asks-workflow + delete-guard tests pass; `npm run build`
  clean; pages render with the design system. Sidebar "Accounts" works.
