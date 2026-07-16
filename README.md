# Qonshu CRM

Multi-tenant CRM built with Next.js 16, Prisma 7, PostgreSQL, and Tailwind CSS.

## Prerequisites

- Node 20+
- Docker Desktop (running)

## Local Setup

### 1. Start Postgres

```bash
docker compose up -d
```

This starts Postgres on host port **5433** (container port 5432). The dev database is `qonshu` and the test database is `qonshu_test`.

### 2. Create the test database and migrate it

```bash
# Create the test DB (one-time)
docker exec -it qonshucrm-db-1 psql -U qonshu -c "CREATE DATABASE qonshu_test;"

# Migrate the test DB
DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu_test?schema=public" npx prisma migrate deploy
```

### 3. Migrate the dev database

Prisma 7 requires `DATABASE_URL` to be set in the shell environment for migrate commands:

```bash
DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu?schema=public" npx prisma migrate deploy
```

### 4. Seed demo data

```bash
DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu?schema=public" npm run seed
```

This creates three demo accounts and demo CRM data (idempotent — safe to run multiple times):

| Email | Password | Role |
|---|---|---|
| super@qonshu.dev | password123 | SUPER_ADMIN |
| admin@demo.co | password123 | COMPANY_ADMIN |
| member@demo.co | password123 | MEMBER |

### 5. Run the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and sign in with any demo account above.

## Sales CRM

The Sales CRM module provides lead tracking and pipeline management for each tenant.

### Features

- **Board View** (`/crm`) — Kanban board organized by customizable pipeline stages.
- **List View** (`/crm/list`) — Searchable, filterable lead table with priority and value.
- **Stage Admin** (`/crm/stages`) — Configure stages, set win/loss probability, reorder the pipeline.
- **Visibility Control** — "Share all leads" toggle in company settings determines whether members see all leads or only their own.
- **Activities** — Track notes, calls, meetings, emails, and automatic stage-change records per lead.
- **Tasks** — Create and track tasks tied to leads with due dates; mark as done.
- **Attachments** — Upload files to leads; stored locally under `uploads/` (gitignored). Set `UPLOADS_DIR` env var to override (used by tests).

### Running Tests

Tests require Postgres to be running (step 1 above). The suite runs serially (`fileParallelism: false`) to avoid DB conflicts.

```bash
npm test
```

Expected output: 66 tests passing across 12 test files.

## Account Management

The Account Management module provides enterprise account tracking, activities, and customer health monitoring.

### Features

- **Accounts List** (`/accounts`) — Searchable table of active accounts with status, value, and manager.
- **Convert to Account** — Convert a Won lead to a customer account from the lead detail view; sets primary contact and initial account manager.
- **Account Detail** — Tabbed interface with:
  - **Activity** — Track meetings, calls, emails, and notes with outcomes; sortable timeline.
  - **Tasks** — Manage action items with due dates and completion tracking.
  - **Asks** — Track customer asks and requests; mark as open or resolved.
  - **Files** — Upload and download account-related documents; stored under `uploads/<companyId>/account-<id>/` (gitignored).
- **Account Status** — Monitor account health: ACTIVE, AT_RISK, or CHURNED.
- **Admin Delete** — Only COMPANY_ADMIN can delete an account; cascades to all related activities, tasks, asks, and files.

## Mobile Analytics

The Mobile Analytics module tracks app usage, payments, and user activity for partner applications integrated with customer accounts.

### Features

- **Analytics Tab** (`/accounts/:id/analytics`) — Comprehensive dashboard showing:
  - **Date Range Selector** — Presets for DAILY, 7D, 30D, 90D, 1Y plus custom date picker.
  - **KPI Cards** — Total app users, total payments, active users, and average payment amount.
  - **Trend Chart** — Line chart showing payment volume and user activity over the selected range.
  - **Payment Breakdown** — Pie charts for payment method (CARD/MANUAL/CASH) and category (APARTMENT/PARKING/NON_RESIDENTIAL/UTILITY).
  - **Top Users** — Table of highest-spending app users with cumulative totals.
  - **Transactions** — Paginated log of all payments with timestamp, amount, method, and category.
- **Sync Mock Data** — Button to refresh analytics from the mock partner analytics source (idempotent).
- **Data Tables** — Analytics stored in `PartnerAppUser` (linked to accounts, tracks debt and active status) and `PartnerPayment` (payment events with method and category).
- **Extensibility** — The `PartnerAnalyticsSource` interface allows swapping the mock implementation for a real mobile API later.

### Demo Data

Run `npm run seed` to populate demo accounts with mock partner app users and payment history (90 days). The seed is idempotent and safe to re-run.

## Settlements

The Settlements module tracks cash collected from partners and cash transfers to partners, maintaining a running balance of funds owed.

### Features

- **Company Settlements Page** (`/settlements`) — Company-wide settlement dashboard showing:
  - Total funds collected across all partners.
  - Total transfers made to partners.
  - **Owed** balance (collected minus transferred).
  - Per-partner breakdown with collected, transferred, and owed amounts.
  - Partner cards linking to each account's settlement details.

- **Settlement Tab** (`/accounts/:id/settlement`) — Account-specific settlement view with:
  - Balance cards displaying collected, transferred, and owed totals for the account.
  - Settlement registry — paginated log of all settlement entries (COLLECTED or TRANSFER) with timestamp, amount, method, and notes.
  - **Add Entry** button (admin-only) to manually record a new settlement event.
  - **Delete Entry** button (admin-only) to remove entries if needed.
  - Members can view the registry but cannot add or delete entries.

- **Manual Entry** — Entries are manually recorded by company admins; not derived from app payments (PartnerPayment).
  - **COLLECTED** entries track cash received from partners (no method specified).
  - **TRANSFER** entries track cash sent to partners (method: CASH or BANK_TRANSFER).
  - Each entry records amount, date occurred, optional notes, and the admin who created it.

- **Admin-Only Access** — Only COMPANY_ADMIN users can add or delete settlement entries. MEMBER users see the registry and balances but cannot modify.

### Demo Data

Run `npm run seed` to populate demo accounts with demo settlement entries (2 COLLECTED + 1 TRANSFER per account). The seed is idempotent and safe to re-run.
