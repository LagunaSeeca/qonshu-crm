# Tenant Foundation + Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-tenant foundation for Qonshu CRM — company onboarding, isolated per-company users with 3 roles, and authentication — that all later subsystems attach to.

**Architecture:** Next.js App Router (UI + API in one codebase). PostgreSQL via Prisma. A server-side tenant layer derives `companyId` from the session and injects it into every query so tenants cannot read each other's data. Auth.js (next-auth v5) Credentials provider carries `companyId` + `role` in the session. UI in Tailwind + shadcn/ui.

**Tech Stack:** Next.js 15 (App Router, TypeScript strict), React 19, Prisma 6 + PostgreSQL (Docker), next-auth@5 (beta), bcryptjs, Tailwind CSS, shadcn/ui, Vitest + @testing-library, Docker Compose.

## Global Constraints

- TypeScript `strict: true`; no `any` in committed code.
- Node 20+.
- Every read/write of tenant data (`User`, `Invitation`, and all later tables) goes through `lib/tenant/` scoped helpers — **never** call `prisma.<tenantModel>` directly from app/route code. Platform (Super Admin) access uses the explicit `lib/platform/` unscoped path only.
- Roles are exactly three: `SUPER_ADMIN`, `COMPANY_ADMIN`, `MEMBER`.
- Passwords hashed with `bcryptjs` (cost 10). Never store or log plaintext passwords.
- Invite emails are mocked: log the invite URL via `lib/email/sendInvite.ts` (console for now) — no real SMTP.
- Secrets (`DATABASE_URL`, `AUTH_SECRET`) from `.env`; never hardcode.
- Tests run against a separate database (`DATABASE_URL_TEST` → `qonshu_test`).

---

## File Structure

```
docker-compose.yml              # local postgres
.env.example                    # documented env vars
prisma/schema.prisma            # Company, User, Invitation + enums
prisma/seed.ts                  # super admin + demo company/users
src/db/client.ts                # singleton PrismaClient
src/lib/auth/password.ts        # hash/verify
src/lib/auth/config.ts          # next-auth config (Credentials)
src/lib/auth/guards.ts          # requireRole, can() permission checks
src/lib/auth/session.ts         # getSession / typed session
src/lib/tenant/context.ts       # getTenantContext(session)
src/lib/tenant/users.ts         # scoped user queries
src/lib/tenant/invitations.ts   # scoped invitation queries + accept
src/lib/platform/companies.ts   # unscoped company create (super admin)
src/lib/email/sendInvite.ts     # mocked invite email (console)
src/app/api/...                 # route handlers
src/app/(auth)/login            # login page
src/app/(platform)/...          # super admin company management
src/app/(app)/...               # tenant shell + users admin
src/app/invite/accept           # invite accept page
vitest.config.ts, src/test/setup.ts, src/test/db.ts
```

---

## Phase A — Scaffold & Schema

### Task 1: Project scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `src/app/globals.css`, `src/app/layout.tsx`, `src/app/page.tsx`, `vitest.config.ts`, `src/test/setup.ts`, `docker-compose.yml`, `.env.example`
- Test: `src/test/smoke.test.ts`

**Interfaces:**
- Produces: working `npm run dev`, `npm test`, `docker compose up` Postgres on `localhost:5432`.

- [ ] **Step 1: Scaffold Next.js app**

Run in project root:
```bash
npx create-next-app@latest . --typescript --tailwind --app --src-dir --eslint --import-alias "@/*" --no-turbopack --use-npm
```
Accept overwrite of existing files; keep `docs/` and `.git`.

- [ ] **Step 2: Add dependencies**

```bash
npm i @prisma/client next-auth@beta bcryptjs zod
npm i -D prisma vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom @types/bcryptjs tsx
```

- [ ] **Step 3: docker-compose for Postgres**

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: qonshu
      POSTGRES_PASSWORD: qonshu
      POSTGRES_DB: qonshu
    ports: ["5432:5432"]
    volumes: ["qonshu_pg:/var/lib/postgresql/data"]
volumes:
  qonshu_pg:
```

- [ ] **Step 4: .env.example + .env**

`.env.example`:
```
DATABASE_URL="postgresql://qonshu:qonshu@localhost:5432/qonshu?schema=public"
DATABASE_URL_TEST="postgresql://qonshu:qonshu@localhost:5432/qonshu_test?schema=public"
AUTH_SECRET="dev-secret-change-me"
```
Copy to `.env`. Create the test DB: `docker compose up -d && docker compose exec -T db psql -U qonshu -c "CREATE DATABASE qonshu_test;"`

- [ ] **Step 5: Vitest config**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  test: { environment: "jsdom", setupFiles: ["src/test/setup.ts"], globals: true },
  resolve: { alias: { "@": "/src" } },
});
```
`src/test/setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```
Add scripts to `package.json`: `"test": "vitest run"`, `"test:watch": "vitest"`, `"seed": "tsx prisma/seed.ts"`.

- [ ] **Step 6: Smoke test**

`src/test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";
describe("smoke", () => {
  it("runs", () => { expect(1 + 1).toBe(2); });
});
```

- [ ] **Step 7: Run tests + verify build**

Run: `npm test`
Expected: PASS (smoke). Run: `npm run build` → succeeds.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + Prisma + Vitest + docker postgres"
```

---

### Task 2: Prisma schema + migration

**Files:**
- Create: `prisma/schema.prisma`, `src/db/client.ts`, `src/test/db.ts`
- Test: `src/db/schema.test.ts`

**Interfaces:**
- Produces: `prisma` client singleton from `@/db/client`; models `Company`, `User`, `Invitation`; enums `Role`, `CompanyStatus`, `UserStatus`, `InviteStatus`; test helper `resetDb()` and `testPrisma`.

- [ ] **Step 1: Write schema**

`prisma/schema.prisma`:
```prisma
generator client { provider = "prisma-client-js" }
datasource db { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role { SUPER_ADMIN COMPANY_ADMIN MEMBER }
enum CompanyStatus { ACTIVE SUSPENDED }
enum UserStatus { ACTIVE INACTIVE }
enum InviteStatus { PENDING ACCEPTED REVOKED }

model Company {
  id          String        @id @default(cuid())
  name        String
  slug        String        @unique
  status      CompanyStatus @default(ACTIVE)
  createdAt   DateTime      @default(now())
  users       User[]
  invitations Invitation[]
}

model User {
  id           String     @id @default(cuid())
  companyId    String?
  company      Company?   @relation(fields: [companyId], references: [id])
  email        String     @unique
  passwordHash String
  name         String
  role         Role
  status       UserStatus @default(ACTIVE)
  createdAt    DateTime   @default(now())
  @@index([companyId])
}

model Invitation {
  id          String       @id @default(cuid())
  companyId   String
  company     Company      @relation(fields: [companyId], references: [id])
  email       String
  role        Role
  token       String       @unique
  status      InviteStatus @default(PENDING)
  invitedById String
  expiresAt   DateTime
  createdAt   DateTime     @default(now())
  @@index([companyId])
  @@index([token])
}
```

- [ ] **Step 2: Generate + migrate**

Run: `npx prisma migrate dev --name init`
Expected: migration applied, client generated.

- [ ] **Step 3: Prisma client singleton**

`src/db/client.ts`:
```ts
import { PrismaClient } from "@prisma/client";
const g = globalThis as unknown as { prisma?: PrismaClient };
export const prisma = g.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.prisma = prisma;
```

- [ ] **Step 4: Test DB helper**

`src/test/db.ts`:
```ts
import { PrismaClient } from "@prisma/client";
export const testPrisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL_TEST } },
});
export async function resetDb() {
  await testPrisma.invitation.deleteMany();
  await testPrisma.user.deleteMany();
  await testPrisma.company.deleteMany();
}
```
Add to `package.json` script: `"test:migrate": "dotenv -e .env -- prisma migrate deploy"` — but simplest: before tests run `DATABASE_URL=$DATABASE_URL_TEST npx prisma migrate deploy`. Document this in README.

- [ ] **Step 5: Schema test**

`src/db/schema.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates company with scoped user", async () => {
    const c = await testPrisma.company.create({ data: { name: "Acme", slug: "acme" } });
    const u = await testPrisma.user.create({
      data: { companyId: c.id, email: "a@acme.com", passwordHash: "x", name: "A", role: "COMPANY_ADMIN" },
    });
    expect(u.companyId).toBe(c.id);
  });

  it("enforces unique email", async () => {
    const c = await testPrisma.company.create({ data: { name: "Acme", slug: "acme2" } });
    await testPrisma.user.create({ data: { companyId: c.id, email: "dup@x.com", passwordHash: "x", name: "A", role: "MEMBER" } });
    await expect(
      testPrisma.user.create({ data: { companyId: c.id, email: "dup@x.com", passwordHash: "y", name: "B", role: "MEMBER" } })
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 6: Run migration on test DB, then tests**

Run: `DATABASE_URL="$DATABASE_URL_TEST" npx prisma migrate deploy`
Run: `npm test`
Expected: schema tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: prisma schema for company/user/invitation with enums"
```

---

## Phase B — Core Logic (pure-ish, TDD)

### Task 3: Password hashing

**Files:**
- Create: `src/lib/auth/password.ts`
- Test: `src/lib/auth/password.test.ts`

**Interfaces:**
- Produces: `hashPassword(plain: string): Promise<string>`, `verifyPassword(plain: string, hash: string): Promise<boolean>`.

- [ ] **Step 1: Failing test**

`src/lib/auth/password.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("password", () => {
  it("hashes and verifies", async () => {
    const h = await hashPassword("s3cret");
    expect(h).not.toBe("s3cret");
    expect(await verifyPassword("s3cret", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
});
```

- [ ] **Step 2: Run → fail** — `npm test` → FAIL (module not found).

- [ ] **Step 3: Implement**

`src/lib/auth/password.ts`:
```ts
import bcrypt from "bcryptjs";
export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);
```

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `git commit -am "feat: password hashing util"`

---

### Task 4: Role guards & permissions

**Files:**
- Create: `src/lib/auth/guards.ts`
- Test: `src/lib/auth/guards.test.ts`

**Interfaces:**
- Consumes: `Role` from `@prisma/client`.
- Produces: type `SessionUser = { id: string; companyId: string | null; role: Role }`; `can(user, action)` where `action ∈ "manage_users" | "manage_companies" | "view_company_data"`; `assertRole(user, roles): void` (throws `ForbiddenError`); class `ForbiddenError extends Error`.

- [ ] **Step 1: Failing test**

`src/lib/auth/guards.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { can, assertRole, ForbiddenError, type SessionUser } from "./guards";

const su: SessionUser = { id: "1", companyId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "2", companyId: "c1", role: "COMPANY_ADMIN" };
const member: SessionUser = { id: "3", companyId: "c1", role: "MEMBER" };

describe("guards", () => {
  it("super admin manages companies, not company data", () => {
    expect(can(su, "manage_companies")).toBe(true);
    expect(can(admin, "manage_companies")).toBe(false);
  });
  it("company admin manages users", () => {
    expect(can(admin, "manage_users")).toBe(true);
    expect(can(member, "manage_users")).toBe(false);
  });
  it("members view company data", () => {
    expect(can(member, "view_company_data")).toBe(true);
    expect(can(su, "view_company_data")).toBe(false);
  });
  it("assertRole throws ForbiddenError when role not allowed", () => {
    expect(() => assertRole(member, ["COMPANY_ADMIN"])).toThrow(ForbiddenError);
    expect(() => assertRole(admin, ["COMPANY_ADMIN"])).not.toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`src/lib/auth/guards.ts`:
```ts
import type { Role } from "@prisma/client";

export type SessionUser = { id: string; companyId: string | null; role: Role };
export type Action = "manage_users" | "manage_companies" | "view_company_data";
export class ForbiddenError extends Error {}

const MATRIX: Record<Action, Role[]> = {
  manage_companies: ["SUPER_ADMIN"],
  manage_users: ["COMPANY_ADMIN"],
  view_company_data: ["COMPANY_ADMIN", "MEMBER"],
};

export function can(user: SessionUser, action: Action): boolean {
  return MATRIX[action].includes(user.role);
}
export function assertRole(user: SessionUser, roles: Role[]): void {
  if (!roles.includes(user.role)) throw new ForbiddenError(`requires ${roles.join("|")}`);
}
```

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `git commit -am "feat: role guards + permission matrix"`

---

### Task 5: Tenant context + scoped user queries

**Files:**
- Create: `src/lib/tenant/context.ts`, `src/lib/tenant/users.ts`
- Test: `src/lib/tenant/users.test.ts`

**Interfaces:**
- Consumes: `prisma`/`testPrisma`, `SessionUser`.
- Produces:
  - `getTenantContext(user: SessionUser): { companyId: string }` (throws if `companyId` null).
  - `listUsers(db, ctx): Promise<User[]>` — only `ctx.companyId`.
  - `getUser(db, ctx, id): Promise<User | null>` — null if other tenant.
  - `setUserStatus(db, ctx, id, status): Promise<User>` — scoped; throws if not in tenant.
  - `db` param is a `PrismaClient` so tests can pass `testPrisma`.

- [ ] **Step 1: Failing isolation test**

`src/lib/tenant/users.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getTenantContext } from "./context";
import { listUsers, getUser, setUserStatus } from "./users";
import type { SessionUser } from "@/lib/auth/guards";

async function seedTwoCompanies() {
  const a = await testPrisma.company.create({ data: { name: "A", slug: "a" } });
  const b = await testPrisma.company.create({ data: { name: "B", slug: "b" } });
  const ua = await testPrisma.user.create({ data: { companyId: a.id, email: "ua@a.com", passwordHash: "x", name: "UA", role: "COMPANY_ADMIN" } });
  const ub = await testPrisma.user.create({ data: { companyId: b.id, email: "ub@b.com", passwordHash: "x", name: "UB", role: "MEMBER" } });
  return { a, b, ua, ub };
}

describe("tenant user scoping", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("listUsers returns only own company", async () => {
    const { a, ua } = await seedTwoCompanies();
    const ctx = getTenantContext({ id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" });
    const users = await listUsers(testPrisma, ctx);
    expect(users.map((u) => u.email)).toEqual(["ua@a.com"]);
  });

  it("getUser cannot read another tenant's user", async () => {
    const { a, ua, ub } = await seedTwoCompanies();
    const ctx = getTenantContext({ id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" });
    expect(await getUser(testPrisma, ctx, ub.id)).toBeNull();
  });

  it("getTenantContext throws when companyId null", () => {
    const su: SessionUser = { id: "1", companyId: null, role: "SUPER_ADMIN" };
    expect(() => getTenantContext(su)).toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement context**

`src/lib/tenant/context.ts`:
```ts
import type { SessionUser } from "@/lib/auth/guards";
export type TenantContext = { companyId: string };
export function getTenantContext(user: SessionUser): TenantContext {
  if (!user.companyId) throw new Error("no tenant context for this user");
  return { companyId: user.companyId };
}
```

- [ ] **Step 4: Implement scoped users**

`src/lib/tenant/users.ts`:
```ts
import type { PrismaClient, User, UserStatus } from "@prisma/client";
import type { TenantContext } from "./context";

export function listUsers(db: PrismaClient, ctx: TenantContext): Promise<User[]> {
  return db.user.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: "asc" } });
}
export function getUser(db: PrismaClient, ctx: TenantContext, id: string): Promise<User | null> {
  return db.user.findFirst({ where: { id, companyId: ctx.companyId } });
}
export async function setUserStatus(db: PrismaClient, ctx: TenantContext, id: string, status: UserStatus): Promise<User> {
  const found = await getUser(db, ctx, id);
  if (!found) throw new Error("user not in tenant");
  return db.user.update({ where: { id }, data: { status } });
}
```

- [ ] **Step 5: Run → pass.** **Step 6: Commit** `git commit -am "feat: tenant context + scoped user queries with isolation tests"`

---

### Task 6: Scoped invitations + accept flow

**Files:**
- Create: `src/lib/tenant/invitations.ts`, `src/lib/email/sendInvite.ts`
- Test: `src/lib/tenant/invitations.test.ts`

**Interfaces:**
- Consumes: `prisma`, `TenantContext`, `hashPassword`.
- Produces:
  - `createInvitation(db, ctx, { email, role, invitedById }): Promise<Invitation>` — scoped; generates `token` (`crypto.randomUUID()`), `expiresAt` = now + 7 days; logs URL via `sendInvite`.
  - `acceptInvitation(db, { token, name, password }): Promise<User>` — validates PENDING + not expired; creates ACTIVE user in invite's company with invite's role; marks invite ACCEPTED. Throws on invalid/expired/used token.
  - `sendInvite(email: string, url: string): Promise<void>` (console.log for now).

- [ ] **Step 1: Failing test**

`src/lib/tenant/invitations.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getTenantContext } from "./context";
import { createInvitation, acceptInvitation } from "./invitations";
import { verifyPassword } from "@/lib/auth/password";

async function seed() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a" } });
  const admin = await testPrisma.user.create({ data: { companyId: c.id, email: "admin@a.com", passwordHash: "x", name: "Ad", role: "COMPANY_ADMIN" } });
  return { c, admin };
}

describe("invitations", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates scoped invite and accepts it into the right company/role", async () => {
    const { c, admin } = await seed();
    const ctx = getTenantContext({ id: admin.id, companyId: c.id, role: "COMPANY_ADMIN" });
    const inv = await createInvitation(testPrisma, ctx, { email: "new@a.com", role: "MEMBER", invitedById: admin.id });
    expect(inv.companyId).toBe(c.id);
    expect(inv.status).toBe("PENDING");

    const user = await acceptInvitation(testPrisma, { token: inv.token, name: "New", password: "pw123456" });
    expect(user.companyId).toBe(c.id);
    expect(user.role).toBe("MEMBER");
    expect(user.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", user.passwordHash)).toBe(true);

    const reused = acceptInvitation(testPrisma, { token: inv.token, name: "X", password: "y2345678" });
    await expect(reused).rejects.toThrow();
  });

  it("rejects expired invite", async () => {
    const { c, admin } = await seed();
    const inv = await testPrisma.invitation.create({
      data: { companyId: c.id, email: "e@a.com", role: "MEMBER", token: "tok-exp", invitedById: admin.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acceptInvitation(testPrisma, { token: inv.token, name: "E", password: "pw345678" })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement sendInvite**

`src/lib/email/sendInvite.ts`:
```ts
export async function sendInvite(email: string, url: string): Promise<void> {
  console.log(`[invite] to=${email} url=${url}`);
}
```

- [ ] **Step 4: Implement invitations**

`src/lib/tenant/invitations.ts`:
```ts
import { randomUUID } from "crypto";
import type { PrismaClient, Invitation, Role, User } from "@prisma/client";
import type { TenantContext } from "./context";
import { hashPassword } from "@/lib/auth/password";
import { sendInvite } from "@/lib/email/sendInvite";

const WEEK = 7 * 24 * 60 * 60 * 1000;
const baseUrl = () => process.env.APP_URL ?? "http://localhost:3000";

export async function createInvitation(
  db: PrismaClient, ctx: TenantContext,
  args: { email: string; role: Role; invitedById: string },
): Promise<Invitation> {
  const token = randomUUID();
  const inv = await db.invitation.create({
    data: { companyId: ctx.companyId, email: args.email, role: args.role, token,
            invitedById: args.invitedById, expiresAt: new Date(Date.now() + WEEK) },
  });
  await sendInvite(args.email, `${baseUrl()}/invite/accept?token=${token}`);
  return inv;
}

export async function acceptInvitation(
  db: PrismaClient,
  args: { token: string; name: string; password: string },
): Promise<User> {
  const inv = await db.invitation.findUnique({ where: { token: args.token } });
  if (!inv || inv.status !== "PENDING") throw new Error("invalid invitation");
  if (inv.expiresAt < new Date()) throw new Error("invitation expired");
  const passwordHash = await hashPassword(args.password);
  const [user] = await db.$transaction([
    db.user.create({ data: { companyId: inv.companyId, email: inv.email, name: args.name, passwordHash, role: inv.role, status: "ACTIVE" } }),
    db.invitation.update({ where: { id: inv.id }, data: { status: "ACCEPTED" } }),
  ]);
  return user;
}
```

- [ ] **Step 5: Run → pass.** **Step 6: Commit** `git commit -am "feat: scoped invitations + accept flow (mocked email)"`

---

### Task 7: Platform company creation (Super Admin, unscoped)

**Files:**
- Create: `src/lib/platform/companies.ts`
- Test: `src/lib/platform/companies.test.ts`

**Interfaces:**
- Consumes: `prisma`, `SessionUser`, `assertRole`, `createInvitation` (but creates company first then invitation directly since no tenant ctx exists yet — uses a local ctx `{ companyId: company.id }`).
- Produces: `createCompany(db, actor, { name, slug, adminEmail }): Promise<{ company: Company; invitation: Invitation }>` — `assertRole(actor, ["SUPER_ADMIN"])`; creates Company + a COMPANY_ADMIN invitation for `adminEmail`.

- [ ] **Step 1: Failing test**

`src/lib/platform/companies.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { createCompany } from "./companies";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "a", companyId: "c", role: "COMPANY_ADMIN" };

describe("createCompany", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("super admin creates company + admin invite", async () => {
    const { company, invitation } = await createCompany(testPrisma, su, { name: "Acme", slug: "acme", adminEmail: "boss@acme.com" });
    expect(company.slug).toBe("acme");
    expect(invitation.role).toBe("COMPANY_ADMIN");
    expect(invitation.companyId).toBe(company.id);
  });

  it("non-super-admin is forbidden", async () => {
    await expect(createCompany(testPrisma, admin, { name: "X", slug: "x", adminEmail: "e@x.com" })).rejects.toThrow(ForbiddenError);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

`src/lib/platform/companies.ts`:
```ts
import type { PrismaClient, Company, Invitation } from "@prisma/client";
import { assertRole, type SessionUser } from "@/lib/auth/guards";
import { createInvitation } from "@/lib/tenant/invitations";

export async function createCompany(
  db: PrismaClient, actor: SessionUser,
  args: { name: string; slug: string; adminEmail: string },
): Promise<{ company: Company; invitation: Invitation }> {
  assertRole(actor, ["SUPER_ADMIN"]);
  const company = await db.company.create({ data: { name: args.name, slug: args.slug } });
  const invitation = await createInvitation(db, { companyId: company.id }, {
    email: args.adminEmail, role: "COMPANY_ADMIN", invitedById: actor.id,
  });
  return { company, invitation };
}
```

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `git commit -am "feat: super-admin company creation with admin invite"`

---

## Phase C — Auth wiring

### Task 8: Auth.js Credentials config + session

**Files:**
- Create: `src/lib/auth/config.ts`, `src/lib/auth/session.ts`, `src/app/api/auth/[...nextauth]/route.ts`
- Test: `src/lib/auth/authorize.test.ts`

**Interfaces:**
- Produces:
  - `authorizeCredentials(db, { email, password }): Promise<SessionUser | null>` — null if no user, wrong password, or `status !== ACTIVE`. (Extracted so it is unit-testable without next-auth.)
  - `auth`, `signIn`, `signOut`, `handlers` from next-auth, with session carrying `id`, `companyId`, `role`.
  - `getSessionUser(): Promise<SessionUser | null>`.

- [ ] **Step 1: Failing test for authorize**

`src/lib/auth/authorize.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { authorizeCredentials } from "./config";
import { hashPassword } from "./password";

async function seedUser(status: "ACTIVE" | "INACTIVE") {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a" } });
  await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: await hashPassword("pw123456"), name: "U", role: "MEMBER", status } });
}

describe("authorizeCredentials", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns session user for valid active creds", async () => {
    await seedUser("ACTIVE");
    const u = await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" });
    expect(u?.role).toBe("MEMBER");
  });
  it("rejects wrong password", async () => {
    await seedUser("ACTIVE");
    expect(await authorizeCredentials(testPrisma, { email: "u@a.com", password: "nope" })).toBeNull();
  });
  it("rejects inactive user", async () => {
    await seedUser("INACTIVE");
    expect(await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement config (authorize + next-auth)**

`src/lib/auth/config.ts`:
```ts
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/db/client";
import { verifyPassword } from "./password";
import type { SessionUser } from "./guards";

export async function authorizeCredentials(
  db: PrismaClient, creds: { email: string; password: string },
): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: creds.email } });
  if (!user || user.status !== "ACTIVE") return null;
  if (!(await verifyPassword(creds.password, user.passwordHash))) return null;
  return { id: user.id, companyId: user.companyId, role: user.role };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (c) =>
        authorizeCredentials(prisma, { email: String(c?.email), password: String(c?.password) }),
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) { token.companyId = (user as SessionUser).companyId; token.role = (user as SessionUser).role; }
      return token;
    },
    session({ session, token }) {
      (session.user as unknown as SessionUser) = {
        id: token.sub!, companyId: (token.companyId as string | null) ?? null, role: token.role as SessionUser["role"],
      };
      return session;
    },
  },
  pages: { signIn: "/login" },
});
```

- [ ] **Step 4: Session helper + route**

`src/lib/auth/session.ts`:
```ts
import { auth } from "./config";
import type { SessionUser } from "./guards";
export async function getSessionUser(): Promise<SessionUser | null> {
  const s = await auth();
  return (s?.user as unknown as SessionUser) ?? null;
}
```
`src/app/api/auth/[...nextauth]/route.ts`:
```ts
import { handlers } from "@/lib/auth/config";
export const { GET, POST } = handlers;
```

- [ ] **Step 5: Run → pass.** **Step 6: Commit** `git commit -am "feat: auth.js credentials provider + session (companyId/role)"`

---

## Phase D — API routes

### Task 9: API route handlers (companies, invitations, users)

**Files:**
- Create: `src/lib/http.ts`, `src/app/api/platform/companies/route.ts`, `src/app/api/invitations/route.ts`, `src/app/api/invitations/accept/route.ts`, `src/app/api/users/route.ts`, `src/app/api/users/[id]/status/route.ts`
- Test: `src/lib/http.test.ts`

**Interfaces:**
- Consumes: `getSessionUser`, `assertRole`, `getTenantContext`, services from Tasks 5–7.
- Produces: `requireUser()` helper that returns `SessionUser` or throws `UnauthorizedError`; route handlers returning JSON. Validation via `zod`. `ForbiddenError`→403, `UnauthorizedError`→401, validation→400, others→500 via shared `handle()` wrapper.

- [ ] **Step 1: Failing test for http wrapper**

`src/lib/http.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { errorResponse, ForbiddenError, UnauthorizedError } from "./http";

describe("errorResponse", () => {
  it("maps known errors to status codes", () => {
    expect(errorResponse(new UnauthorizedError()).status).toBe(401);
    expect(errorResponse(new ForbiddenError()).status).toBe(403);
    expect(errorResponse(new Error("boom")).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement http helper**

`src/lib/http.ts`:
```ts
import { NextResponse } from "next/server";
import { ForbiddenError } from "@/lib/auth/guards";
export { ForbiddenError };
export class UnauthorizedError extends Error {}
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthorizedError) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (e instanceof ForbiddenError) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (e instanceof Error && e.name === "ZodError") return NextResponse.json({ error: e.message }, { status: 400 });
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
```

- [ ] **Step 4: Run → pass (http test).**

- [ ] **Step 5: Implement route handlers**

`src/app/api/platform/companies/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { createCompany } from "@/lib/platform/companies";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ name: z.string().min(1), slug: z.string().min(1), adminEmail: z.string().email() });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    const data = Body.parse(await req.json());
    const result = await createCompany(prisma, user, data);
    return NextResponse.json(result, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/invitations/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { createInvitation } from "@/lib/tenant/invitations";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ email: z.string().email(), role: z.enum(["COMPANY_ADMIN", "MEMBER"]) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const ctx = getTenantContext(user);
    const { email, role } = Body.parse(await req.json());
    const inv = await createInvitation(prisma, ctx, { email, role, invitedById: user.id });
    return NextResponse.json(inv, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/invitations/accept/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { acceptInvitation } from "@/lib/tenant/invitations";
import { errorResponse } from "@/lib/http";

const Body = z.object({ token: z.string().min(1), name: z.string().min(1), password: z.string().min(8) });
export async function POST(req: NextRequest) {
  try {
    const { token, name, password } = Body.parse(await req.json());
    const user = await acceptInvitation(prisma, { token, name, password });
    return NextResponse.json({ id: user.id }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/users/route.ts`:
```ts
import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const users = await listUsers(prisma, getTenantContext(user));
    return NextResponse.json(users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status })));
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/users/[id]/status/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { setUserStatus } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { id } = await params;
    const { status } = Body.parse(await req.json());
    const updated = await setUserStatus(prisma, getTenantContext(user), id, status);
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (e) { return errorResponse(e); }
}
```

- [ ] **Step 6: Typecheck + tests** — Run `npm run build` (compiles routes) and `npm test`. Expected: PASS.

- [ ] **Step 7: Commit** `git commit -am "feat: api routes for companies/invitations/users (guarded, validated)"`

---

## Phase E — UI

### Task 10: App shell, login, middleware

**Files:**
- Create: `src/middleware.ts`, `src/app/login/page.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/dashboard/page.tsx`, `src/components/Sidebar.tsx`
- Modify: `src/app/page.tsx` (redirect to /dashboard or /login)
- Test: `src/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: `getSessionUser`, `can`.
- Produces: `Sidebar({ role })` renders nav; "Users" link only for `COMPANY_ADMIN`, platform link only for `SUPER_ADMIN`. Middleware redirects unauthenticated users to `/login`.

- [ ] **Step 1: Failing component test**

`src/components/Sidebar.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "./Sidebar";

describe("Sidebar", () => {
  it("shows Users link for company admin only", () => {
    const { rerender } = render(<Sidebar role="MEMBER" />);
    expect(screen.queryByText("Users")).toBeNull();
    rerender(<Sidebar role="COMPANY_ADMIN" />);
    expect(screen.getByText("Users")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement Sidebar**

`src/components/Sidebar.tsx`:
```tsx
import Link from "next/link";
import type { Role } from "@prisma/client";

const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/crm", label: "Sales CRM" },
  { href: "/accounts", label: "Accounts" },
  { href: "/analytics", label: "Analytics" },
];
export function Sidebar({ role }: { role: Role }) {
  return (
    <nav className="flex flex-col gap-1 p-4 w-56 border-r min-h-screen">
      <div className="font-bold mb-4">Qonshu CRM</div>
      {NAV.map((n) => (<Link key={n.href} href={n.href} className="px-2 py-1 rounded hover:bg-gray-100">{n.label}</Link>))}
      {role === "COMPANY_ADMIN" && <Link href="/users" className="px-2 py-1 rounded hover:bg-gray-100">Users</Link>}
      {role === "SUPER_ADMIN" && <Link href="/platform/companies" className="px-2 py-1 rounded hover:bg-gray-100">Companies</Link>}
    </nav>
  );
}
```

- [ ] **Step 4: Run → pass.**

- [ ] **Step 5: Layout, middleware, login, dashboard**

`src/app/(app)/layout.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { Sidebar } from "@/components/Sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return (<div className="flex"><Sidebar role={user.role} /><main className="flex-1 p-6">{children}</main></div>);
}
```
`src/app/(app)/dashboard/page.tsx`:
```tsx
export default function Dashboard() {
  return <div><h1 className="text-2xl font-semibold">Dashboard</h1><p className="text-gray-500">Stats arrive in a later milestone.</p></div>;
}
```
`src/middleware.ts`:
```ts
export { auth as middleware } from "@/lib/auth/config";
export const config = { matcher: ["/dashboard/:path*", "/crm/:path*", "/accounts/:path*", "/analytics/:path*", "/users/:path*", "/platform/:path*"] };
```
`src/app/login/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { signIn } from "next-auth/react";
export default function Login() {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const r = await signIn("credentials", { email, password, redirect: false });
    if (r?.error) setErr("Invalid credentials"); else window.location.href = "/dashboard";
  }
  return (
    <form onSubmit={submit} className="max-w-sm mx-auto mt-24 flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Sign in</h1>
      <input className="border p-2 rounded" placeholder="Email" value={email} onChange={(e)=>setEmail(e.target.value)} />
      <input className="border p-2 rounded" type="password" placeholder="Password" value={password} onChange={(e)=>setPassword(e.target.value)} />
      {err && <p className="text-red-600 text-sm">{err}</p>}
      <button className="bg-black text-white p-2 rounded">Sign in</button>
    </form>
  );
}
```
Modify `src/app/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
export default async function Home() { redirect((await getSessionUser()) ? "/dashboard" : "/login"); }
```

- [ ] **Step 6: Build + tests** — Run `npm run build` and `npm test`. Expected: PASS.

- [ ] **Step 7: Commit** `git commit -am "feat: app shell, sidebar, login, auth middleware"`

---

### Task 11: Admin pages — users list + invite, platform company create, invite accept

**Files:**
- Create: `src/app/(app)/users/page.tsx`, `src/app/(app)/users/UserAdmin.tsx`, `src/app/(platform)/platform/companies/page.tsx`, `src/app/(platform)/platform/companies/CompanyCreate.tsx`, `src/app/invite/accept/page.tsx`
- Test: covered by API tests (Task 9) + manual; add `src/app/invite/accept/AcceptForm.test.tsx` for form render.

**Interfaces:**
- Consumes: API routes from Task 9 via `fetch`.
- Produces: client components posting to the routes. Server pages guard via `getSessionUser` + `assertRole`.

- [ ] **Step 1: Users admin (server page guards, client list + invite form)**

`src/app/(app)/users/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers } from "@/lib/tenant/users";
import { UserAdmin } from "./UserAdmin";

export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "COMPANY_ADMIN") redirect("/dashboard");
  const users = await listUsers(prisma, getTenantContext(user));
  return <UserAdmin initial={users.map((u)=>({ id:u.id, email:u.email, name:u.name, role:u.role, status:u.status }))} />;
}
```
`src/app/(app)/users/UserAdmin.tsx`:
```tsx
"use client";
import { useState } from "react";
type Row = { id: string; email: string; name: string; role: string; status: string };
export function UserAdmin({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial); const [email, setEmail] = useState(""); const [role, setRole] = useState("MEMBER");
  async function invite() {
    const r = await fetch("/api/invitations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, role }) });
    if (r.ok) { setEmail(""); alert("Invite sent (check server console for link)"); }
  }
  async function toggle(id: string, status: string) {
    const next = status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    const r = await fetch(`/api/users/${id}/status`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: next }) });
    if (r.ok) setRows((rs)=>rs.map((x)=>x.id===id?{...x,status:next}:x));
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Users</h1>
      <div className="flex gap-2">
        <input className="border p-2 rounded" placeholder="email" value={email} onChange={(e)=>setEmail(e.target.value)} />
        <select className="border p-2 rounded" value={role} onChange={(e)=>setRole(e.target.value)}><option>MEMBER</option><option>COMPANY_ADMIN</option></select>
        <button className="bg-black text-white px-3 rounded" onClick={invite}>Invite</button>
      </div>
      <table className="w-full text-left"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>{rows.map((u)=>(<tr key={u.id} className="border-t"><td>{u.name}</td><td>{u.email}</td><td>{u.role}</td><td>{u.status}</td>
          <td><button className="text-blue-600" onClick={()=>toggle(u.id,u.status)}>{u.status==="ACTIVE"?"Deactivate":"Activate"}</button></td></tr>))}</tbody></table>
    </div>
  );
}
```

- [ ] **Step 2: Platform company create**

`src/app/(platform)/platform/companies/page.tsx`:
```tsx
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { CompanyCreate } from "./CompanyCreate";
export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");
  return <CompanyCreate />;
}
```
`src/app/(platform)/platform/companies/CompanyCreate.tsx`:
```tsx
"use client";
import { useState } from "react";
export function CompanyCreate() {
  const [name,setName]=useState(""); const [slug,setSlug]=useState(""); const [adminEmail,setAdminEmail]=useState(""); const [msg,setMsg]=useState("");
  async function submit(){
    const r=await fetch("/api/platform/companies",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name,slug,adminEmail})});
    setMsg(r.ok?"Company created — admin invite logged to server console":"Error");
  }
  return (<div className="space-y-3 max-w-sm"><h1 className="text-2xl font-semibold">New Company</h1>
    <input className="border p-2 rounded w-full" placeholder="Name" value={name} onChange={(e)=>setName(e.target.value)} />
    <input className="border p-2 rounded w-full" placeholder="slug" value={slug} onChange={(e)=>setSlug(e.target.value)} />
    <input className="border p-2 rounded w-full" placeholder="Admin email" value={adminEmail} onChange={(e)=>setAdminEmail(e.target.value)} />
    <button className="bg-black text-white p-2 rounded" onClick={submit}>Create</button>{msg && <p className="text-sm">{msg}</p>}</div>);
}
```

- [ ] **Step 3: Invite accept page**

`src/app/invite/accept/page.tsx`:
```tsx
"use client";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
export default function Accept() {
  const token = useSearchParams().get("token") ?? "";
  const [name,setName]=useState(""); const [password,setPassword]=useState(""); const [msg,setMsg]=useState("");
  async function submit(){
    const r=await fetch("/api/invitations/accept",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token,name,password})});
    setMsg(r.ok?"Account created — you can sign in":"Invalid or expired invite");
  }
  return (<div className="max-w-sm mx-auto mt-24 space-y-3"><h1 className="text-xl font-semibold">Accept invitation</h1>
    <input className="border p-2 rounded w-full" placeholder="Your name" value={name} onChange={(e)=>setName(e.target.value)} />
    <input className="border p-2 rounded w-full" type="password" placeholder="Password (min 8)" value={password} onChange={(e)=>setPassword(e.target.value)} />
    <button className="bg-black text-white p-2 rounded" onClick={submit}>Create account</button>{msg && <p className="text-sm">{msg}</p>}</div>);
}
```

- [ ] **Step 4: Build + tests** — Run `npm run build` and `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `git commit -am "feat: users admin, platform company create, invite accept pages"`

---

### Task 12: Seed script + README run docs

**Files:**
- Create: `prisma/seed.ts`, `README.md`
- Test: manual (`npm run seed`)

**Interfaces:**
- Produces: 1 SUPER_ADMIN (`super@qonshu.dev`), 1 demo company "Demo Co" with a COMPANY_ADMIN (`admin@demo.co`) and a MEMBER (`member@demo.co`), all password `password123`.

- [ ] **Step 1: Seed script**

`prisma/seed.ts`:
```ts
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
const prisma = new PrismaClient();
async function main() {
  const pw = await hashPassword("password123");
  await prisma.user.upsert({ where: { email: "super@qonshu.dev" }, update: {},
    create: { email: "super@qonshu.dev", name: "Super Admin", passwordHash: pw, role: "SUPER_ADMIN" } });
  const co = await prisma.company.upsert({ where: { slug: "demo" }, update: {}, create: { name: "Demo Co", slug: "demo" } });
  await prisma.user.upsert({ where: { email: "admin@demo.co" }, update: {},
    create: { companyId: co.id, email: "admin@demo.co", name: "Demo Admin", passwordHash: pw, role: "COMPANY_ADMIN" } });
  await prisma.user.upsert({ where: { email: "member@demo.co" }, update: {},
    create: { companyId: co.id, email: "member@demo.co", name: "Demo Member", passwordHash: pw, role: "MEMBER" } });
  console.log("seeded: super@qonshu.dev / admin@demo.co / member@demo.co (password123)");
}
main().finally(() => prisma.$disconnect());
```

- [ ] **Step 2: README run docs** — `README.md` with: `docker compose up -d`, create test DB, `npx prisma migrate dev`, `npm run seed`, `npm run dev`, test logins, and the rule "test DB needs `prisma migrate deploy` with `DATABASE_URL_TEST`".

- [ ] **Step 3: Run seed + manual smoke** — `npm run seed` then `npm run dev`; log in as each user, verify nav differs by role, create a company as super admin, invite a member as admin, accept via console link.

- [ ] **Step 4: Commit** `git commit -am "feat: seed script + README run instructions"`

---

## Self-Review

- **Spec coverage:** company creation (T7), 3 roles (T4), tenant isolation (T5, tested), users add/list/deactivate (T5/T9/T11), invite flow mocked email (T6), auth + session companyId/role (T8), app shell + nav placeholders + role gating (T10/T11), seed (T12), isolation+role tests (T4/T5/T8). All spec sections mapped.
- **Placeholder scan:** none — every code step has full code.
- **Type consistency:** `SessionUser`, `TenantContext`, service signatures (`listUsers/getUser/setUserStatus`, `createInvitation/acceptInvitation`, `createCompany`, `authorizeCredentials`) consistent across tasks and route handlers.
