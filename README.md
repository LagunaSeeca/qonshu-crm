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
  - **Analytics** — Placeholder for M4 health metrics and trends.
- **Account Status** — Monitor account health: ACTIVE, AT_RISK, or CHURNED.
- **Admin Delete** — Only COMPANY_ADMIN can delete an account; cascades to all related activities, tasks, asks, and files.
