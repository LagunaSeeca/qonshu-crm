# Account Management (Partner Workspace) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the per-company Account Management workspace — partner accounts (created standalone or by converting a Won lead) with an activity/meeting timeline, tasks, asks (open→resolved), and files.

**Architecture:** Reuse M2 exactly: tenant-scoped services in `src/lib/tenant/*` (never raw `prisma.<tenantModel>` in route/page code), zod-validated route handlers, guarded server pages, shadcn/ui (base-ui variant) screens on the design system. Accounts are company-wide visible (scoped by `companyId` only). Prisma 7 + adapter-pg.

**Tech Stack:** Next.js 16 (App Router, TS strict), React 19, Prisma 7 (pg adapter), Postgres (Docker, host port 5433), Vitest (`fileParallelism: false`), shadcn/ui (base-ui "base-nova" variant — no `asChild`; use `buttonVariants` on `<Link>` + base-ui `render` prop), lucide-react, sonner toasts, Tailwind v4.

## Global Constraints

- TypeScript `strict: true`; no `any`.
- Every tenant table read/write goes through `src/lib/tenant/*` scoped helpers — never `prisma.<tenantModel>` in route/page/UI code. (Tenant tables now include Account, AccountActivity, AccountTask, AccountAsk, AccountAttachment.)
- All account rows carry `companyId`; **accounts are visible to ALL members of the company** (scope = `{ companyId }` only — no per-owner filter). Cross-tenant/missing → 404 via `NotFoundError` (exported from `@/lib/auth/guards`, mapped to 404 by `errorResponse` in `@/lib/http`).
- **Deleting an account is COMPANY_ADMIN only** (`assertRole(user, ["COMPANY_ADMIN"])` in the route); all other account/workspace actions are any authenticated member.
- Conversion: only a lead whose current stage `type === "WON"` converts; block double-conversion (an Account with that `sourceLeadId` already exists) with 409; do NOT delete the lead.
- Money: Prisma `Decimal`; compare in tests via `Number(x)`.
- Attachments reuse `src/lib/files/storage.ts`; account files under `uploads/<companyId>/account-<accountId>/`; 10 MB max.
- Reuse existing infra: `prisma` (`@/db/client`), `getSessionUser` (`@/lib/auth/session`), `SessionUser`/`assertRole`/`ForbiddenError`/`NotFoundError` (`@/lib/auth/guards`), `getTenantContext` (`@/lib/tenant/context`), `errorResponse`/`UnauthorizedError` (`@/lib/http`), `testPrisma`/`resetDb` (`@/test/db`), design-system components in `src/components/ui`.
- DB up before tests: `docker compose up -d` (5433). Add new tables to `resetDb` in FK-safe order. Suite is currently green — keep it.
- **Templates to read in the repo** (mirror their structure): `src/lib/tenant/leads.ts`, `tasks.ts`, `activities.ts`, `attachments.ts`; routes under `src/app/api/leads/**`; UI `src/app/(app)/crm/[id]/LeadDetail.tsx`, `crm/page.tsx`, `crm/LeadCreate.tsx`.

---

## File Structure

```
prisma/schema.prisma                      # + Account, AccountActivity, AccountTask, AccountAsk, AccountAttachment + enums
src/test/db.ts                            # resetDb: add the 5 new tables (FK-safe)
src/lib/tenant/accounts.ts                # scoped Account CRUD/list + convertLeadToAccount + deleteAccount(files)
src/lib/tenant/account-activities.ts      # scoped activity timeline (mirror activities.ts, accountId)
src/lib/tenant/account-tasks.ts           # scoped tasks (mirror tasks.ts, accountId)
src/lib/tenant/account-asks.ts            # scoped asks + resolveAsk/reopenAsk
src/lib/tenant/account-attachments.ts     # scoped attachments (mirror attachments.ts, account-<id> path)
src/app/api/accounts/route.ts, [id]/route.ts, from-lead/route.ts
src/app/api/accounts/[id]/activities/route.ts, tasks/route.ts, tasks/[taskId]/route.ts,
  asks/route.ts, asks/[askId]/route.ts, attachments/route.ts, attachments/[attId]/route.ts
src/app/(app)/accounts/page.tsx, AccountCreate.tsx, AccountTable.tsx
src/app/(app)/accounts/[id]/page.tsx, AccountDetail.tsx
src/app/(app)/crm/[id]/LeadDetail.tsx     # MODIFY: "Convert to Account" on WON leads
src/components/Sidebar.tsx                 # MODIFY: "Accounts" → /accounts (if not already)
prisma/seed.ts                             # MODIFY: demo accounts + workspace items
```

---

## Phase A — Schema

### Task 1: Prisma schema — account models

**Files:**
- Modify: `prisma/schema.prisma`, `src/test/db.ts`
- Test: `src/db/account-schema.test.ts`

**Interfaces:**
- Produces: models `Account`, `AccountActivity`, `AccountTask`, `AccountAsk`, `AccountAttachment`; enums `AccountStatus`(ACTIVE|AT_RISK|CHURNED), `AccountActivityKind`(NOTE|CALL|MEETING|EMAIL), `AskStatus`(OPEN|RESOLVED). Cascade Account→children.

- [ ] **Step 1: Failing test**

`src/db/account-schema.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("account schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates an account with workspace items and cascades on delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-acct" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner Co", accountManagerId: u.id, value: "5000" } });
    await testPrisma.accountActivity.create({ data: { companyId: c.id, accountId: acc.id, authorId: u.id, kind: "MEETING", body: "kickoff" } });
    await testPrisma.accountTask.create({ data: { companyId: c.id, accountId: acc.id, title: "send deck" } });
    await testPrisma.accountAsk.create({ data: { companyId: c.id, accountId: acc.id, title: "need API key", authorId: u.id } });
    expect(acc.status).toBe("ACTIVE");
    expect(Number(acc.value)).toBe(5000);
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.accountActivity.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.accountTask.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.accountAsk.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
```

- [ ] **Step 2: Add to `prisma/schema.prisma`** (use multi-line enum syntax — Prisma 7 rejects single-line):
```prisma
enum AccountStatus {
  ACTIVE
  AT_RISK
  CHURNED
}
enum AccountActivityKind {
  NOTE
  CALL
  MEETING
  EMAIL
}
enum AskStatus {
  OPEN
  RESOLVED
}

model Account {
  id                  String        @id @default(cuid())
  companyId           String
  company             Company       @relation(fields: [companyId], references: [id], onDelete: Cascade)
  name                String
  website             String?
  industry            String?
  status              AccountStatus @default(ACTIVE)
  accountManagerId    String
  value               Decimal       @default(0)
  currency            String        @default("USD")
  primaryContactName  String?
  primaryContactEmail String?
  primaryContactPhone String?
  sourceLeadId        String?       @unique
  createdAt           DateTime      @default(now())
  updatedAt           DateTime      @updatedAt
  activities          AccountActivity[]
  tasks               AccountTask[]
  asks                AccountAsk[]
  attachments         AccountAttachment[]
  @@index([companyId])
  @@index([companyId, status])
  @@index([companyId, accountManagerId])
}

model AccountActivity {
  id         String              @id @default(cuid())
  companyId  String
  company    Company             @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId  String
  account    Account             @relation(fields: [accountId], references: [id], onDelete: Cascade)
  authorId   String?
  kind       AccountActivityKind @default(NOTE)
  body       String
  outcome    String?
  occurredAt DateTime            @default(now())
  createdAt  DateTime            @default(now())
  @@index([companyId, accountId])
}

model AccountTask {
  id         String   @id @default(cuid())
  companyId  String
  company    Company  @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId  String
  account    Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  title      String
  dueDate    DateTime?
  done       Boolean  @default(false)
  assigneeId String?
  createdAt  DateTime @default(now())
  @@index([companyId, accountId])
}

model AccountAsk {
  id         String    @id @default(cuid())
  companyId  String
  company    Company   @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId  String
  account    Account   @relation(fields: [accountId], references: [id], onDelete: Cascade)
  title      String
  detail     String?
  status     AskStatus @default(OPEN)
  authorId   String?
  createdAt  DateTime  @default(now())
  resolvedAt DateTime?
  @@index([companyId, accountId])
}

model AccountAttachment {
  id           String   @id @default(cuid())
  companyId    String
  company      Company  @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId    String
  account      Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  filename     String
  diskPath     String
  size         Int
  mime         String
  uploadedById String
  createdAt    DateTime @default(now())
  @@index([companyId, accountId])
}
```
Add to `Company`: relations `accounts Account[]`, `accountActivities AccountActivity[]`, `accountTasks AccountTask[]`, `accountAsks AccountAsk[]`, `accountAttachments AccountAttachment[]`.

- [ ] **Step 3: Migrate** — `docker compose up -d` then
  `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu?schema=public" npx prisma migrate dev --name account_models` and `npx prisma generate`; then test DB:
  `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu_test?schema=public" npx prisma migrate deploy`

- [ ] **Step 4: Update `resetDb`** in `src/test/db.ts` — add BEFORE the lead/stage deletes (children first), keep existing order valid:
```ts
await testPrisma.accountAttachment.deleteMany();
await testPrisma.accountAsk.deleteMany();
await testPrisma.accountTask.deleteMany();
await testPrisma.accountActivity.deleteMany();
await testPrisma.account.deleteMany();
```
(Place these at the top of `resetDb`, before the existing `attachment`/`task`/`activity`/`lead`/`stage`/… deletes.)

- [ ] **Step 5: Run** `npm test` → account-schema test + all prior green.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: prisma account models (account/activity/task/ask/attachment)"`

---

## Phase B — Services

### Task 2: Account service + lead conversion

**Files:**
- Create: `src/lib/tenant/accounts.ts`
- Test: `src/lib/tenant/accounts.test.ts`

**Interfaces:**
- Consumes: `prisma`, `SessionUser`, `NotFoundError`, lead service (`getLead`), stage type lookup.
- Produces:
  - `accountScopeWhere(user): { companyId: string }` — throws if `user.companyId` null.
  - `createAccount(db, user, data): Promise<Account>` — companyId from user; `accountManagerId` defaults to `user.id`.
  - `listAccounts(db, user, opts?): Promise<Account[]>` — `{companyId}` scope; filter `status?`, `accountManagerId?`, `q?` (name/industry contains), order by `updatedAt desc`.
  - `getAccount(db, user, id): Promise<Account | null>` — `{companyId}` scope.
  - `updateAccount(db, user, id, data): Promise<Account>` — scoped; `NotFoundError` if missing; if `accountManagerId` provided, validate same-company user.
  - `deleteAccount(db, user, id): Promise<void>` — scoped; removes account files dir; deletes (cascade). (Route enforces admin.)
  - `convertLeadToAccount(db, user, leadId): Promise<Account>` — lead must be visible + its stage `type==="WON"` (else `NotFoundError`/`Error`); if an Account with `sourceLeadId===leadId` exists → throw `AlreadyConvertedError` (export; route maps 409). Creates Account with carried fields; does not delete lead.
  - Export `class AlreadyConvertedError extends Error {}`.

- [ ] **Step 1: Failing test**

`src/lib/tenant/accounts.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { createAccount, listAccounts, getAccount, convertLeadToAccount, AlreadyConvertedError } from "./accounts";
import type { SessionUser } from "@/lib/auth/guards";

async function setup() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-acs" } });
  await seedDefaultStages(testPrisma, c.id);
  const stages = await listStages(testPrisma, { companyId: c.id });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, stages, user };
}

describe("accounts", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates and lists accounts; cross-tenant getAccount is null", async () => {
    const A = await setup();
    const acc = await createAccount(testPrisma, A.user, { name: "Partner", value: 1000 });
    expect((await listAccounts(testPrisma, A.user)).length).toBe(1);
    const B = await setup();
    expect(await getAccount(testPrisma, B.user, acc.id)).toBeNull();
  });

  it("converts a WON lead, carries fields, links sourceLeadId, keeps lead, blocks double-convert", async () => {
    const { stages, user } = await setup();
    const won = stages.find((s) => s.type === "WON")!;
    const lead = await createLead(testPrisma, user, { title: "BigCo deal", contactName: "Jane", companyName: "BigCo", stageId: stages[0].id, value: 7000 });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await convertLeadToAccount(testPrisma, user, lead.id);
    expect(acc.name).toBe("BigCo");
    expect(acc.sourceLeadId).toBe(lead.id);
    expect(Number(acc.value)).toBe(7000);
    expect(await testPrisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    await expect(convertLeadToAccount(testPrisma, user, lead.id)).rejects.toThrow(AlreadyConvertedError);
  });

  it("rejects converting a non-WON lead", async () => {
    const { stages, user } = await setup();
    const lead = await createLead(testPrisma, user, { title: "Open deal", contactName: "C", stageId: stages[0].id });
    await expect(convertLeadToAccount(testPrisma, user, lead.id)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/lib/tenant/accounts.ts`:
```ts
import type { PrismaClient, Account, AccountStatus, Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getLead } from "./leads";
import { removeLeadDir } from "@/lib/files/storage";

export class AlreadyConvertedError extends Error {}

export function accountScopeWhere(user: SessionUser): { companyId: string } {
  if (!user.companyId) throw new Error("no tenant context");
  return { companyId: user.companyId };
}

export function createAccount(db: PrismaClient, user: SessionUser, data: {
  name: string; website?: string; industry?: string; status?: AccountStatus;
  accountManagerId?: string; value?: number | string; primaryContactName?: string;
  primaryContactEmail?: string; primaryContactPhone?: string; sourceLeadId?: string;
}): Promise<Account> {
  return db.account.create({ data: {
    companyId: user.companyId!, name: data.name, website: data.website, industry: data.industry,
    status: data.status ?? "ACTIVE", accountManagerId: data.accountManagerId ?? user.id,
    value: data.value ?? 0, primaryContactName: data.primaryContactName,
    primaryContactEmail: data.primaryContactEmail, primaryContactPhone: data.primaryContactPhone,
    sourceLeadId: data.sourceLeadId ?? null,
  } });
}

export function listAccounts(db: PrismaClient, user: SessionUser, opts?: { status?: AccountStatus; accountManagerId?: string; q?: string }): Promise<Account[]> {
  const where: Prisma.AccountWhereInput = { ...accountScopeWhere(user) };
  if (opts?.status) where.status = opts.status;
  if (opts?.accountManagerId) where.accountManagerId = opts.accountManagerId;
  if (opts?.q) where.OR = [
    { name: { contains: opts.q, mode: "insensitive" } },
    { industry: { contains: opts.q, mode: "insensitive" } },
  ];
  return db.account.findMany({ where, orderBy: { updatedAt: "desc" } });
}

export function getAccount(db: PrismaClient, user: SessionUser, id: string): Promise<Account | null> {
  return db.account.findFirst({ where: { id, ...accountScopeWhere(user) } });
}

export async function updateAccount(db: PrismaClient, user: SessionUser, id: string, data: Partial<{
  name: string; website: string | null; industry: string | null; status: AccountStatus;
  accountManagerId: string; value: number | string; primaryContactName: string | null;
  primaryContactEmail: string | null; primaryContactPhone: string | null;
}>): Promise<Account> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  if (data.accountManagerId) {
    const mgr = await db.user.findFirst({ where: { id: data.accountManagerId, companyId: user.companyId! } });
    if (!mgr) throw new NotFoundError("manager not in tenant");
  }
  return db.account.update({ where: { id }, data });
}

export async function deleteAccount(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  await removeLeadDir(user.companyId!, `account-${id}`); // reuse storage dir-removal under uploads/<companyId>/account-<id>
  await db.account.delete({ where: { id } });
}

export async function convertLeadToAccount(db: PrismaClient, user: SessionUser, leadId: string): Promise<Account> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const stage = await db.stage.findFirst({ where: { id: lead.stageId, companyId: user.companyId! } });
  if (!stage || stage.type !== "WON") throw new Error("lead is not in a Won stage");
  const existing = await db.account.findFirst({ where: { companyId: user.companyId!, sourceLeadId: leadId } });
  if (existing) throw new AlreadyConvertedError("lead already converted");
  return createAccount(db, user, {
    name: lead.companyName ?? lead.title, value: lead.value as unknown as number,
    accountManagerId: lead.ownerId, primaryContactName: lead.contactName,
    primaryContactEmail: lead.email ?? undefined, primaryContactPhone: lead.phone ?? undefined,
    sourceLeadId: lead.id,
  });
}
```
Note: account files live under `uploads/<companyId>/account-<accountId>/`; `removeLeadDir(companyId, "account-<id>")` removes exactly that dir (its second arg is used as the lead/sub-folder segment).

- [ ] **Step 4: Run → pass.** **Step 5: Commit** `git commit -am "feat: account service + Won-lead conversion (company-wide scope)"`

---

### Task 3: Account workspace services (activities, tasks, asks, attachments)

**Files:**
- Create: `src/lib/tenant/account-activities.ts`, `account-tasks.ts`, `account-asks.ts`, `account-attachments.ts`
- Test: `src/lib/tenant/account-asks.test.ts`, `src/lib/tenant/account-workspace.test.ts`

**Interfaces:**
- Consumes: `prisma`, `SessionUser`, `getAccount` (scope/existence), `NotFoundError`, `@/lib/files/storage`.
- Produces (each verifies the account is in scope via `getAccount`, else NotFoundError / empty list):
  - activities: `addAccountActivity(db,user,accountId,{kind,body,outcome?,occurredAt?})`, `listAccountActivities(db,user,accountId)`.
  - tasks: `addAccountTask(db,user,accountId,{title,dueDate?,assigneeId?})` (validate assignee same-company if provided), `toggleAccountTask(db,user,taskId,done)`, `listAccountTasks(db,user,accountId)`, `isOverdue(task)`.
  - asks: `addAsk(db,user,accountId,{title,detail?})`, `listAsks(db,user,accountId)`, `resolveAsk(db,user,askId)` (sets status RESOLVED + resolvedAt=now), `reopenAsk(db,user,askId)` (status OPEN, resolvedAt=null).
  - attachments: `addAccountAttachment(db,user,accountId,{filename,mime,bytes})` (10MB; saved under `account-<accountId>`), `listAccountAttachments`, `getAccountAttachmentForDownload(db,user,attId)` (tenant-checked), `deleteAccountAttachment(db,user,attId)`.

Read `src/lib/tenant/activities.ts`, `tasks.ts`, `attachments.ts` and mirror them, swapping `leadId`→`accountId`, `getLead`→`getAccount`, and the storage folder segment to `account-<accountId>`. Below is the distinctive asks service in full; build the other three by mirroring their lead equivalents (no STAGE_CHANGE concept — account activities allow all four kinds).

- [ ] **Step 1: Asks test**

`src/lib/tenant/account-asks.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { createAccount } from "./accounts";
import { addAsk, listAsks, resolveAsk, reopenAsk } from "./account-asks";
import type { SessionUser } from "@/lib/auth/guards";

async function acct() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-ask" } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { user, acc: await createAccount(testPrisma, user, { name: "P" }) };
}

describe("account asks", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates OPEN, resolves, reopens", async () => {
    const { user, acc } = await acct();
    const ask = await addAsk(testPrisma, user, acc.id, { title: "need API key", detail: "prod" });
    expect(ask.status).toBe("OPEN");
    const resolved = await resolveAsk(testPrisma, user, ask.id);
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).not.toBeNull();
    const reopened = await reopenAsk(testPrisma, user, ask.id);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAt).toBeNull();
    expect((await listAsks(testPrisma, user, acc.id)).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/lib/tenant/account-asks.ts`:
```ts
import type { PrismaClient, AccountAsk } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export async function addAsk(db: PrismaClient, user: SessionUser, accountId: string, args: { title: string; detail?: string }): Promise<AccountAsk> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.accountAsk.create({ data: { companyId: user.companyId!, accountId, authorId: user.id, title: args.title, detail: args.detail } });
}
export async function listAsks(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountAsk[]> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) return [];
  return db.accountAsk.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
}
export async function resolveAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  const found = await db.accountAsk.findFirst({ where: { id: askId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("ask not in tenant");
  return db.accountAsk.update({ where: { id: askId }, data: { status: "RESOLVED", resolvedAt: new Date() } });
}
export async function reopenAsk(db: PrismaClient, user: SessionUser, askId: string): Promise<AccountAsk> {
  const found = await db.accountAsk.findFirst({ where: { id: askId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("ask not in tenant");
  return db.accountAsk.update({ where: { id: askId }, data: { status: "OPEN", resolvedAt: null } });
}
```

- [ ] **Step 4: Implement activities/tasks/attachments** by mirroring `src/lib/tenant/activities.ts`, `tasks.ts`, `attachments.ts` (swap lead→account, `getLead`→`getAccount`, storage folder `account-<accountId>`). Names per the Interfaces block above. For attachments reuse `saveFile/readFile/removeFile` from `@/lib/files/storage` with `saveFile(user.companyId!, \`account-${accountId}\`, filename, bytes)`.

- [ ] **Step 5: Workspace test** `src/lib/tenant/account-workspace.test.ts` — add a focused test: add an activity (MEETING) + a task, list both, toggle the task done, and (using a temp `process.env.UPLOADS_DIR`) add+download an attachment asserting bytes round-trip and a cross-tenant download returns null. (Mirror `attachments.test.ts` setup.)

- [ ] **Step 6: Run → all pass.** **Step 7: Commit** `git commit -am "feat: account workspace services (activities/tasks/asks/attachments)"`

---

## Phase C — API Routes

### Task 4: Account API routes

**Files:**
- Create: `src/app/api/accounts/route.ts`, `[id]/route.ts`, `from-lead/route.ts`, and nested `[id]/activities/route.ts`, `[id]/tasks/route.ts`, `[id]/tasks/[taskId]/route.ts`, `[id]/asks/route.ts`, `[id]/asks/[askId]/route.ts`, `[id]/attachments/route.ts`, `[id]/attachments/[attId]/route.ts`

**Interfaces:**
- Mirror `src/app/api/leads/**`. Every handler: `getSessionUser` → 401 if none; zod-validate; call the scoped service; `errorResponse` catch. DELETE `/api/accounts/[id]` adds `assertRole(user, ["COMPANY_ADMIN"])`. `from-lead` maps `AlreadyConvertedError`→409.

- [ ] **Step 1: Implement** `src/app/api/accounts/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listAccounts, createAccount } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(await listAccounts(prisma, user, {
      status: (sp.get("status") as "ACTIVE"|"AT_RISK"|"CHURNED"|null) ?? undefined,
      accountManagerId: sp.get("accountManagerId") ?? undefined, q: sp.get("q") ?? undefined,
    }));
  } catch (e) { return errorResponse(e); }
}
const Create = z.object({ name: z.string().min(1), website: z.string().optional(), industry: z.string().optional(),
  status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(), accountManagerId: z.string().optional(),
  value: z.number().nonnegative().optional(), primaryContactName: z.string().optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")), primaryContactPhone: z.string().optional() });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Create.parse(await req.json());
    return NextResponse.json(await createAccount(prisma, user, { ...d, primaryContactEmail: d.primaryContactEmail || undefined }), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/accounts/[id]/route.ts` — GET (getAccount → 404 if null), PATCH (updateAccount), DELETE (assertRole COMPANY_ADMIN → deleteAccount). Mirror `src/app/api/leads/[id]/route.ts` exactly, swapping the service calls; add the admin assert in DELETE:
```ts
// in DELETE, after session check:
import { assertRole } from "@/lib/auth/guards";
assertRole(user, ["COMPANY_ADMIN"]);
await deleteAccount(prisma, user, (await params).id);
```
`src/app/api/accounts/from-lead/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { convertLeadToAccount, AlreadyConvertedError } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ leadId: z.string().min(1) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { leadId } = Body.parse(await req.json());
    return NextResponse.json(await convertLeadToAccount(prisma, user, leadId), { status: 201 });
  } catch (e) {
    if (e instanceof AlreadyConvertedError) return NextResponse.json({ error: "already_converted" }, { status: 409 });
    return errorResponse(e);
  }
}
```
Nested activities/tasks/attachments routes: mirror `src/app/api/leads/[id]/{activities,tasks,attachments}/**` swapping service imports + the param name stays `id` (the account id). Asks routes:
`src/app/api/accounts/[id]/asks/route.ts` — GET `listAsks`, POST `addAsk` ({title, detail?}).
`src/app/api/accounts/[id]/asks/[askId]/route.ts` — PATCH ({action:"resolve"|"reopen"}) → `resolveAsk`/`reopenAsk`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { resolveAsk, reopenAsk } from "@/lib/tenant/account-asks";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ action: z.enum(["resolve", "reopen"]) });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; askId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { askId } = await params;
    const { action } = Body.parse(await req.json());
    const ask = action === "resolve" ? await resolveAsk(prisma, user, askId) : await reopenAsk(prisma, user, askId);
    return NextResponse.json(ask);
  } catch (e) { return errorResponse(e); }
}
```

- [ ] **Step 2: Build + test** — `npm run build` compiles all routes; `npm test` green.
- [ ] **Step 3: Commit** `git commit -am "feat: account API routes (CRUD, from-lead convert, nested workspace)"`

---

## Phase D — UI

### Task 5: Accounts list + create + convert button

**Files:**
- Create: `src/app/(app)/accounts/page.tsx`, `AccountTable.tsx`, `AccountCreate.tsx`
- Modify: `src/components/Sidebar.tsx` ("Accounts" → `/accounts` if not already), `src/app/(app)/crm/[id]/LeadDetail.tsx` (Convert button)
- Test: `src/app/(app)/accounts/AccountTable.test.tsx`

**Interfaces:**
- Server page guards session (layout already does), loads `listAccounts(prisma, user)` + member names; renders toolbar (title, search, New Account dialog) + `AccountTable`.

- [ ] **Step 1: Failing component test** (mirror `crm/LeadTable.test.tsx`)

`src/app/(app)/accounts/AccountTable.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { AccountTable } from "./AccountTable";

describe("AccountTable", () => {
  it("renders account rows with status + manager", () => {
    render(<AccountTable rows={[{ id: "1", name: "Partner Co", status: "ACTIVE", managerName: "M1", value: 5000, industry: "SaaS" }]} />);
    expect(screen.getByText("Partner Co")).toBeInTheDocument();
    expect(screen.getByText("ACTIVE")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `AccountTable.tsx` (shadcn `Table`, status `Badge` ACTIVE=green/AT_RISK=amber/CHURNED=slate, value tabular right, name→`/accounts/[id]` link, empty state). `AccountCreate.tsx` (shadcn `Dialog`, POST `/api/accounts`, sonner toast). `accounts/page.tsx` (server: load accounts + members, map to rows, toolbar). Use the design-system patterns from `crm/LeadTable.tsx` / `LeadCreate.tsx` / `crm/list/page.tsx`.
- [ ] **Step 4: Sidebar** — ensure "Accounts" nav `href="/accounts"` (lucide icon e.g. `Building2`).
- [ ] **Step 5: Convert button** — in `LeadDetail.tsx`, when the lead's current stage `type === "WON"`, show a "Convert to Account" `Button` that POSTs `/api/accounts/from-lead` `{leadId}`; on success `toast.success` + `router.push("/accounts/"+id)`; on 409 `toast.error("Already converted")`. (Pass the stage type into LeadDetail or derive from the stages prop it already receives.)
- [ ] **Step 6: Build + test** — green. **Step 7: Commit** `git commit -am "feat: accounts list + create + convert-from-won-lead"`

---

### Task 6: Account detail (tabs: Activity / Tasks / Asks / Files + M4 placeholder)

**Files:**
- Create: `src/app/(app)/accounts/[id]/page.tsx`, `AccountDetail.tsx`
- Test: `src/app/(app)/accounts/[id]/AccountDetail.test.tsx`

**Interfaces:**
- Server page: `getAccount` → `notFound()` if null; load activities, tasks, asks, attachments, members; render `AccountDetail` (client).

- [ ] **Step 1: Failing test** (renders name, an activity, a task, an ask, an attachment — mirror `crm/[id]/LeadDetail.test.tsx`, mock `next/navigation`):
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
import { AccountDetail } from "./AccountDetail";

const base = {
  account: { id: "a1", name: "Partner Co", status: "ACTIVE", website: "", industry: "SaaS", value: 5000, accountManagerId: "u", primaryContactName: "Jane", primaryContactEmail: "", primaryContactPhone: "" },
  members: [{ id: "u", name: "M1" }],
  activities: [{ id: "ac1", kind: "MEETING", body: "kickoff call", outcome: null, occurredAt: new Date().toISOString(), authorId: "u" }],
  tasks: [{ id: "t1", title: "send deck", dueDate: null, done: false }],
  asks: [{ id: "k1", title: "need API key", detail: null, status: "OPEN", createdAt: new Date().toISOString(), resolvedAt: null }],
  attachments: [{ id: "f1", filename: "msa.pdf", size: 10, mime: "application/pdf" }],
};

describe("AccountDetail", () => {
  it("renders account, activity, task, ask, attachment", () => {
    render(<AccountDetail {...base} />);
    expect(screen.getByText("Partner Co")).toBeInTheDocument();
    expect(screen.getByText("kickoff call")).toBeInTheDocument();
    expect(screen.getByText("send deck")).toBeInTheDocument();
    expect(screen.getByText("need API key")).toBeInTheDocument();
    expect(screen.getByText("msa.pdf")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `AccountDetail.tsx` — header Card (name, status badge, account manager, editable fields incl. status `Select`, value, website, industry, primary contact → PATCH `/api/accounts/[id]`), then a manual tab system (kept-in-DOM panels like the restyled `LeadDetail.tsx` so inactive panels stay testable): **Activity** (timeline + add form → `/api/accounts/[id]/activities`), **Tasks** (toggle/add → `/api/accounts/[id]/tasks` + `/tasks/[taskId]`), **Asks** (list with OPEN/RESOLVED badge; Resolve/Reopen button → PATCH `/api/accounts/[id]/asks/[askId]` `{action}`; add form → POST asks), **Files** (list + upload + download via `/api/accounts/[id]/attachments`), and a disabled **Analytics** tab labeled "Coming in a later milestone" (the M4 placeholder). All mutations use sonner toasts. `notFound()` in page when account missing.
- [ ] **Step 4: Build + test** — green. **Step 5: Commit** `git commit -am "feat: account detail with activity/tasks/asks/files + analytics placeholder"`

---

## Phase E — Seed & Docs

### Task 7: Seed demo accounts + README

**Files:**
- Modify: `prisma/seed.ts`, `README.md`

- [ ] **Step 1: Extend seed** — after demo leads, create 2 demo accounts for the demo company (one ACTIVE, one AT_RISK), `accountManagerId` = demo admin/member, each with one AccountActivity (MEETING), one AccountTask, one AccountAsk (one OPEN, one RESOLVED across the two). Idempotent: `await prisma.account.deleteMany({ where: { companyId: demoCompany.id } })` first (cascades), then recreate. Import nothing new beyond the prisma client (seed may use prisma directly).
- [ ] **Step 2: README** — add an "Account Management" section: `/accounts` list, convert a Won lead from its detail, account detail tabs (Activity/Tasks/Asks/Files), admin-only delete, files under `uploads/<companyId>/account-<id>/`.
- [ ] **Step 3: Run** `npm run seed` twice (idempotent), `npm test` green, `npm run build` clean.
- [ ] **Step 4: Commit** `git commit -am "feat: seed demo accounts + README account-management section"`

---

## Self-Review

- **Spec coverage:** account model + status + manager (T1/T2), standalone create (T2/T4/T5), convert-from-Won with guards (T2 tested, T4 route, T5 button), company-wide visibility (T2 `accountScopeWhere` = companyId only), activities/meetings (T3), tasks (T3), asks open→resolved (T3 tested, T6 UI), files reuse storage (T3), admin-only delete (T4 route assert), account detail tabs + M4 placeholder (T6), accounts list + sidebar (T5), seed + README (T7). Isolation + conversion + asks-workflow + delete-guard tested. All spec sections mapped.
- **Placeholder scan:** none — full code for schema, accounts service incl. convert, asks service, key routes, and tests; parallel services/routes/UI give exact interfaces + the in-repo template files to mirror (not vague "similar to").
- **Type consistency:** services take `(db, user, ...)`; `accountScopeWhere(user)`, `convertLeadToAccount`, `AlreadyConvertedError`, `resolveAsk/reopenAsk`, `getAccount` referenced consistently across tasks; enums (AccountStatus/AccountActivityKind/AskStatus) match schema.
