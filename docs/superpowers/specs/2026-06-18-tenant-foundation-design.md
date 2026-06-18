# Qonshu CRM — Milestone 1: Tenant Foundation + Auth

**Date:** 2026-06-18
**Status:** Approved design
**Subsystem:** 1 of 5 (see project roadmap)

## Context

Qonshu CRM is a multi-tenant SaaS for sales and account management. The platform
owner (Qonshu) creates company profiles; each company manages its own users and
runs an isolated CRM. This milestone builds the foundation every later subsystem
depends on: tenancy, users, roles, and authentication. No CRM features yet.

Later milestones (Sales CRM, Account Management, Mobile Analytics, Dashboard +
Reporting) all attach to the `companyId` boundary established here.

## Goals

- Platform Super Admin can create a company and its first Company Admin.
- Company Admin can invite, list, and deactivate users within their own company.
- Strict per-company data isolation — no tenant can read another's data.
- Authenticated, role-gated app shell ready for later subsystems to plug into.

## Non-Goals (this milestone)

- Any CRM, account-management, analytics, or reporting feature.
- Custom/configurable roles and permission matrices (fixed 3-role model for now).
- Real transactional email delivery (invites are logged/mocked locally).
- Billing, deployment, SSO, password reset flows beyond invite-set-password.

## Roles (fixed, 3-role model)

| Role | Scope | Capabilities |
|------|-------|--------------|
| **Super Admin** | Platform (Qonshu) | Create/suspend companies; create a company's first admin; view all tenants. No access to tenant CRM data unless impersonating (out of scope now). |
| **Company Admin** | Own company | Invite/list/deactivate users; manage company settings; full access to own company's data. |
| **Member** | Own company | Access own company's CRM/accounts/analytics (built later). No user administration. |

## Architecture

- **Next.js (App Router, TypeScript)** — UI + API route handlers in one codebase.
- **PostgreSQL via Prisma** — local Postgres in Docker (`docker-compose.yml`).
- **Tailwind CSS + shadcn/ui** — component layer.
- **Auth.js (NextAuth) Credentials provider** — email + password, JWT/session cookie.
  Session carries `userId`, `companyId`, `role`.
- **Tenant scoping** — a server-side data-access layer derives `companyId` from the
  session and injects it into every Prisma query. Super Admin platform views use a
  separate, explicit unscoped path. App code never queries Prisma directly without
  going through this layer.

### Layering

1. `db/` — Prisma client + schema.
2. `lib/auth/` — Auth.js config, session helpers, `requireRole()` guards.
3. `lib/tenant/` — `getTenantContext()` + scoped query helpers (`companyId` injection).
4. `app/(platform)/` — Super Admin routes (company management).
5. `app/(app)/` — tenant app shell + user management; later subsystems mount here.
6. `app/api/` — route handlers for invites, auth, company/user CRUD.

Each unit has one purpose and a defined interface; tenant scoping is testable in
isolation from UI.

## Data Model (Prisma)

```
Company       id, name, slug, status(active|suspended), createdAt
User          id, companyId(nullable for Super Admin), email(unique),
              passwordHash, name, role(SUPER_ADMIN|COMPANY_ADMIN|MEMBER),
              status(active|inactive), createdAt
Invitation    id, companyId, email, role, token(unique), status(pending|accepted|revoked),
              invitedById, expiresAt, createdAt
Session       handled by Auth.js (JWT strategy; no DB session table required)
```

Indexes: `User(companyId)`, `User(email)`, `Invitation(token)`, `Invitation(companyId)`.

## Key Flows

1. **Create company (Super Admin):** form → create `Company` + first `User`
   (COMPANY_ADMIN) via invite → invite link logged to console.
2. **Invite user (Company Admin):** enter email + role → create `Invitation`
   (scoped to own `companyId`) → link logged. Token-gated accept page sets name +
   password → creates active `User`, marks invite accepted.
3. **Login:** email + password → Auth.js validates `passwordHash` → session with
   `companyId` + `role`.
4. **Deactivate user:** Company Admin sets `status=inactive`; inactive users can't log in.

## App Shell

Tenant-aware layout: sidebar nav with placeholders **Dashboard / Sales CRM /
Accounts / Analytics / Users (admin only)**. Routes gated by `requireRole()`.
Later milestones fill the placeholder sections.

## Error Handling

- Unauthorized/role-denied → redirect to login or 403 page.
- Cross-tenant access attempt → 404 (don't leak existence).
- Expired/used invite token → clear error on accept page.
- Duplicate email → validation error.

## Testing

- **Tenant isolation:** seed two companies; assert company A's session cannot read
  company B's users/invites (expect 404/empty).
- **Role permissions:** Member cannot reach user-admin or platform routes; Company
  Admin cannot reach platform (Super Admin) routes.
- **Auth flows:** login success/failure, inactive user blocked, invite accept sets
  working credentials.
- **Seed script:** 1 Super Admin + 1 demo company + demo admin/member, runnable via
  `npm run seed`.

## Success Criteria

- `docker compose up` + `npm run dev` boots the app against local Postgres.
- Super Admin creates a company and its admin; that admin logs in and invites a member.
- Isolation + role tests pass.
- App shell renders role-appropriate nav, ready for Milestone 2.
