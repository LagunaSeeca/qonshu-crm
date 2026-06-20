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

This creates three demo accounts (idempotent — safe to run multiple times):

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

## Running Tests

Tests require Postgres to be running (step 1 above). The suite runs serially (`fileParallelism: false`) to avoid DB conflicts.

```bash
npm test
```

Expected output: 27 tests passing across 11 test files.
