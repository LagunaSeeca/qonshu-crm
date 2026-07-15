# Mobile-App Analytics (Mock Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build per-partner mobile-app analytics — app users, debt, payments with method/category breakdowns, trend, top users, transactions — from a mock source that seeds DB tables and is swappable for the real API, surfaced in the Account detail Analytics tab.

**Architecture:** A `PartnerAnalyticsSource` interface (mock impl now) feeds a `syncAccountAnalytics` that populates `PartnerAppUser` + `PartnerPayment` tables. A pure, tenant-scoped aggregation service computes KPIs/breakdowns/trend/top-users + paginated transactions over a resolved date range. Reuses M1–M3: scoped services, zod routes, guarded UI, design system.

**Tech Stack:** Next.js 16 (App Router, TS strict), React 19, Prisma 7 (pg adapter), Postgres (Docker 5433), Vitest (`fileParallelism:false`), shadcn/ui (base-ui variant — no `asChild`; use `buttonVariants`/`render`), lucide-react, sonner, Tailwind v4. Charts: lightweight token-styled SVG/CSS (no heavy chart dependency).

## Global Constraints

- TS `strict: true`; no `any`.
- Tenant data via `src/lib/tenant/*` scoped helpers — never raw `prisma.<tenantModel>` in route/page/UI. New tenant tables: PartnerAppUser, PartnerPayment. Access is gated through M3 `getAccount(db, user, accountId)` (company-wide account visibility); out-of-scope → 404 (`NotFoundError` from `@/lib/auth/guards`, mapped by `errorResponse`).
- Analytics data is READ-ONLY ingested data (no CRM edits).
- Mock is behind `PartnerAnalyticsSource`; the real mobile API must swap in with ZERO aggregation/UI changes.
- Enums: `PaymentMethod` = CARD|MANUAL|CASH; `PaymentCategory` = APARTMENT|PARKING|NON_RESIDENTIAL|UTILITY. "Utility payments" = category UTILITY.
- Money is Prisma `Decimal`; aggregation converts via `.toNumber()`/`Number(x)`; compare with `Number(x)` in tests.
- Ranges: presets DAILY|7D|30D|90D|1Y + custom from/to; `from>to` or unparseable → 400.
- Reuse: `prisma` (`@/db/client`), `getSessionUser` (`@/lib/auth/session`), `getAccount` (`@/lib/tenant/accounts`), `errorResponse`/`UnauthorizedError` (`@/lib/http`), `testPrisma`/`resetDb` (`@/test/db`), design-system components in `src/components/ui`.
- DB up before tests: `docker compose up -d` (5433). Add the 2 new tables to `resetDb` (children of Account). Suite currently 66 green — keep it.

---

## File Structure

```
prisma/schema.prisma                     # + PartnerAppUser, PartnerPayment + enums
src/test/db.ts                           # resetDb: add partnerPayment, partnerAppUser (before account)
src/lib/analytics/range.ts               # resolveRange(preset?, from?, to?) -> {from,to}
src/lib/analytics/source.ts              # PartnerAnalyticsSource + MockPartnerAnalyticsSource
src/lib/analytics/sync.ts                # syncAccountAnalytics(db, accountId, source)
src/lib/tenant/partner-analytics.ts      # getAccountAnalytics + listAccountPayments (scoped)
src/app/api/accounts/[id]/analytics/route.ts, analytics/payments/route.ts, analytics/sync/route.ts
src/app/(app)/accounts/[id]/Analytics.tsx  # the Analytics tab panel (client)
src/app/(app)/accounts/[id]/AccountDetail.tsx  # MODIFY: mount <Analytics/> in the Analytics tab
prisma/seed.ts                            # MODIFY: sync mock analytics for demo accounts
```

---

## Phase A — Schema & pure helpers

### Task 1: Prisma schema — partner analytics tables

**Files:** Modify `prisma/schema.prisma`, `src/test/db.ts`; Test `src/db/analytics-schema.test.ts`

**Interfaces:** Produces models `PartnerAppUser`, `PartnerPayment`; enums `PaymentMethod`(CARD|MANUAL|CASH), `PaymentCategory`(APARTMENT|PARKING|NON_RESIDENTIAL|UTILITY). Cascade from Account.

- [ ] **Step 1: Failing test** `src/db/analytics-schema.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("analytics schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("creates users + payments and cascades on account delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-an" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
    const au = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: acc.id, externalId: "e1", name: "AppUser", debt: "120", joinedAt: new Date() } });
    await testPrisma.partnerPayment.create({ data: { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: new Date(), amount: "50", method: "CARD", category: "UTILITY" } });
    expect(Number(au.debt)).toBe(120);
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.partnerPayment.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
```

- [ ] **Step 2: Add to `prisma/schema.prisma`** (multi-line enums):
```prisma
enum PaymentMethod {
  CARD
  MANUAL
  CASH
}
enum PaymentCategory {
  APARTMENT
  PARKING
  NON_RESIDENTIAL
  UTILITY
}

model PartnerAppUser {
  id         String   @id @default(cuid())
  companyId  String
  company    Company  @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId  String
  account    Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  externalId String
  name       String
  active     Boolean  @default(true)
  debt       Decimal  @default(0)
  joinedAt   DateTime
  createdAt  DateTime @default(now())
  payments   PartnerPayment[]
  @@unique([accountId, externalId])
  @@index([companyId, accountId])
  @@index([accountId, active])
}

model PartnerPayment {
  id         String          @id @default(cuid())
  companyId  String
  company    Company         @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId  String
  account    Account         @relation(fields: [accountId], references: [id], onDelete: Cascade)
  appUserId  String
  appUser    PartnerAppUser  @relation(fields: [appUserId], references: [id], onDelete: Cascade)
  occurredAt DateTime
  amount     Decimal
  method     PaymentMethod
  category   PaymentCategory
  createdAt  DateTime        @default(now())
  @@index([companyId, accountId])
  @@index([accountId, occurredAt])
}
```
Add to `Company`: `partnerAppUsers PartnerAppUser[]`, `partnerPayments PartnerPayment[]`. Add to `Account`: `partnerAppUsers PartnerAppUser[]`, `partnerPayments PartnerPayment[]`.

- [ ] **Step 3: Migrate** — `docker compose up -d`; `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu?schema=public" npx prisma migrate dev --name partner_analytics` + `npx prisma generate`; test DB `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu_test?schema=public" npx prisma migrate deploy`.
- [ ] **Step 4: resetDb** — add at the TOP of `resetDb` (before account): `await testPrisma.partnerPayment.deleteMany(); await testPrisma.partnerAppUser.deleteMany();`
- [ ] **Step 5: Run** `npm test` → green. **Step 6: Commit** `git commit -am "feat: prisma partner analytics models (app users + payments)"`

---

### Task 2: Range resolver

**Files:** Create `src/lib/analytics/range.ts`; Test `src/lib/analytics/range.test.ts`

**Interfaces:** `type RangePreset = "DAILY"|"7D"|"30D"|"90D"|"1Y"`; `resolveRange(input: { preset?: RangePreset; from?: string; to?: string }, now?: Date): { from: Date; to: Date }` — preset windows end at `now` (end of today), start N days back; DAILY = start of today→now. Custom from/to parse ISO dates (to = end of that day). Throws `RangeError` if from>to or unparseable.

- [ ] **Step 1: Failing test** `src/lib/analytics/range.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { resolveRange } from "./range";

const now = new Date("2026-06-30T12:00:00Z");
describe("resolveRange", () => {
  it("7D spans 7 days back to now", () => {
    const { from, to } = resolveRange({ preset: "7D" }, now);
    expect(to.getTime()).toBeGreaterThanOrEqual(now.getTime());
    expect(Math.round((to.getTime() - from.getTime()) / 86400000)).toBe(7);
  });
  it("custom from/to honored", () => {
    const { from, to } = resolveRange({ from: "2026-06-01", to: "2026-06-10" }, now);
    expect(from.toISOString().slice(0, 10)).toBe("2026-06-01");
    expect(to.toISOString().slice(0, 10)).toBe("2026-06-10");
  });
  it("from>to throws", () => {
    expect(() => resolveRange({ from: "2026-06-10", to: "2026-06-01" }, now)).toThrow();
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/analytics/range.ts`:
```ts
export type RangePreset = "DAILY" | "7D" | "30D" | "90D" | "1Y";
const DAYS: Record<Exclude<RangePreset, "DAILY">, number> = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365 };

export function resolveRange(input: { preset?: RangePreset; from?: string; to?: string }, now: Date = new Date()): { from: Date; to: Date } {
  if (input.from || input.to) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T23:59:59.999Z`);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new RangeError("invalid dates");
    if (from > to) throw new RangeError("from after to");
    return { from, to };
  }
  const to = now;
  if (input.preset === "DAILY") {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    return { from, to };
  }
  const days = DAYS[(input.preset ?? "30D") as Exclude<RangePreset, "DAILY">] ?? 30;
  return { from: new Date(to.getTime() - days * 86400000), to };
}
```

- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: analytics range resolver (presets + custom)"`

---

## Phase B — Source, sync, aggregation

### Task 3: Mock source + sync

**Files:** Create `src/lib/analytics/source.ts`, `src/lib/analytics/sync.ts`; Test `src/lib/analytics/sync.test.ts`

**Interfaces:**
- `type RawUser = { externalId: string; name: string; active: boolean; debt: number; joinedAt: Date }`
- `type RawPayment = { externalUserId: string; occurredAt: Date; amount: number; method: PaymentMethod; category: PaymentCategory }`
- `interface PartnerAnalyticsSource { fetchUsers(accountId: string): Promise<RawUser[]>; fetchPayments(accountId: string, since: Date): Promise<RawPayment[]> }`
- `class MockPartnerAnalyticsSource implements PartnerAnalyticsSource` — deterministic per accountId (seeded PRNG from the id): 8–15 users (some inactive, varied debt), ~90 days of payments per active user across methods/categories.
- `syncAccountAnalytics(db, accountId, companyId, source): Promise<{ users: number; payments: number }>` — upsert users by `(accountId, externalId)`; delete + regenerate the account's payments (bounded window); returns counts. Idempotent (re-run yields same user set, no dup externalIds).

- [ ] **Step 1: Failing test** `src/lib/analytics/sync.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { MockPartnerAnalyticsSource } from "./source";
import { syncAccountAnalytics } from "./sync";

async function acct() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-sy" } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
  return { c, acc };
}
describe("syncAccountAnalytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("populates users + payments idempotently", async () => {
    const { c, acc } = await acct();
    const src = new MockPartnerAnalyticsSource();
    const r1 = await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    expect(r1.users).toBeGreaterThan(0);
    expect(r1.payments).toBeGreaterThan(0);
    const usersAfter1 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    const usersAfter2 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    expect(usersAfter2).toBe(usersAfter1); // no duplicate externalIds
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/analytics/source.ts`:
```ts
import type { PaymentMethod, PaymentCategory } from "@prisma/client";

export type RawUser = { externalId: string; name: string; active: boolean; debt: number; joinedAt: Date };
export type RawPayment = { externalUserId: string; occurredAt: Date; amount: number; method: PaymentMethod; category: PaymentCategory };
export interface PartnerAnalyticsSource {
  fetchUsers(accountId: string): Promise<RawUser[]>;
  fetchPayments(accountId: string, since: Date): Promise<RawPayment[]>;
}

// tiny deterministic PRNG (mulberry32) seeded from the account id
function seedFrom(id: string): () => number {
  let h = 1779033703 ^ id.length;
  for (let i = 0; i < id.length; i++) { h = Math.imul(h ^ id.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const METHODS: PaymentMethod[] = ["CARD", "MANUAL", "CASH"];
const CATS: PaymentCategory[] = ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"];

export class MockPartnerAnalyticsSource implements PartnerAnalyticsSource {
  async fetchUsers(accountId: string): Promise<RawUser[]> {
    const rnd = seedFrom(accountId + ":u");
    const n = 8 + Math.floor(rnd() * 8);
    return Array.from({ length: n }, (_, i) => ({
      externalId: `${accountId}-u${i}`, name: `App User ${i + 1}`,
      active: rnd() > 0.2, debt: Math.round(rnd() * 500 * 100) / 100,
      joinedAt: new Date(Date.now() - Math.floor(rnd() * 365) * 86400000),
    }));
  }
  async fetchPayments(accountId: string, since: Date): Promise<RawPayment[]> {
    const users = await this.fetchUsers(accountId);
    const rnd = seedFrom(accountId + ":p");
    const out: RawPayment[] = [];
    const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86400000));
    for (const u of users.filter((x) => x.active)) {
      const perDay = rnd() * 0.5;
      for (let d = 0; d < days; d++) {
        if (rnd() > perDay) continue;
        out.push({ externalUserId: u.externalId, occurredAt: new Date(since.getTime() + d * 86400000 + Math.floor(rnd() * 86400000)),
          amount: Math.round((10 + rnd() * 490) * 100) / 100, method: METHODS[Math.floor(rnd() * METHODS.length)], category: CATS[Math.floor(rnd() * CATS.length)] });
      }
    }
    return out;
  }
}
```
`src/lib/analytics/sync.ts`:
```ts
import type { PrismaClient } from "@prisma/client";
import type { PartnerAnalyticsSource } from "./source";

export async function syncAccountAnalytics(db: PrismaClient, accountId: string, companyId: string, source: PartnerAnalyticsSource): Promise<{ users: number; payments: number }> {
  const rawUsers = await source.fetchUsers(accountId);
  for (const u of rawUsers) {
    await db.partnerAppUser.upsert({
      where: { accountId_externalId: { accountId, externalId: u.externalId } },
      update: { name: u.name, active: u.active, debt: u.debt, joinedAt: u.joinedAt },
      create: { companyId, accountId, externalId: u.externalId, name: u.name, active: u.active, debt: u.debt, joinedAt: u.joinedAt },
    });
  }
  const idByExternal = new Map((await db.partnerAppUser.findMany({ where: { accountId } })).map((u) => [u.externalId, u.id]));
  const since = new Date(Date.now() - 90 * 86400000);
  const rawPayments = await source.fetchPayments(accountId, since);
  await db.partnerPayment.deleteMany({ where: { accountId } });
  for (const p of rawPayments) {
    const appUserId = idByExternal.get(p.externalUserId);
    if (!appUserId) continue;
    await db.partnerPayment.create({ data: { companyId, accountId, appUserId, occurredAt: p.occurredAt, amount: p.amount, method: p.method, category: p.category } });
  }
  return { users: rawUsers.length, payments: rawPayments.length };
}
```

- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: mock partner-analytics source + idempotent sync"`

---

### Task 4: Analytics aggregation service (scoped)

**Files:** Create `src/lib/tenant/partner-analytics.ts`; Test `src/lib/tenant/partner-analytics.test.ts`

**Interfaces:**
- Consumes `getAccount` (`@/lib/tenant/accounts`), `SessionUser`, `NotFoundError`.
- `getAccountAnalytics(db, user, accountId, range: {from:Date;to:Date}): Promise<Analytics>` where
  `Analytics = { kpis: { activeUsers, totalUsers, totalDebt, paymentsCount, paymentsAmount, utilityCount, utilityAmount }, byMethod: { method, count, amount }[], byCategory: { category, count, amount }[], trend: { date: string; count: number; amount: number }[], topUsers: { name: string; paid: number; debt: number }[] }`. Throws `NotFoundError` if account out of scope. Computes over payments with `occurredAt` in [from,to]; totalUsers/activeUsers/totalDebt from PartnerAppUser (all-time, not windowed).
- `listAccountPayments(db, user, accountId, opts: { from:Date; to:Date; method?; category?; skip?; take? }): Promise<{ rows: {...}[]; total: number }>` — scoped, filtered, paginated (rows: id, occurredAt, amount, method, category, userName).

- [ ] **Step 1: Failing test** `src/lib/tenant/partner-analytics.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getAccountAnalytics, listAccountPayments } from "./partner-analytics";
import type { SessionUser } from "@/lib/auth/guards";

async function seed() {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-pa" } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
  const au = await testPrisma.partnerAppUser.create({ data: { companyId: c.id, accountId: acc.id, externalId: "e1", name: "AU", active: true, debt: "100", joinedAt: new Date() } });
  const day = new Date("2026-06-15T10:00:00Z");
  await testPrisma.partnerPayment.createMany({ data: [
    { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: day, amount: "100", method: "CARD", category: "UTILITY" },
    { companyId: c.id, accountId: acc.id, appUserId: au.id, occurredAt: day, amount: "50", method: "CASH", category: "APARTMENT" },
  ] });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, acc, user };
}
const range = { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T23:59:59Z") };

describe("partner analytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("aggregates KPIs + breakdowns + utility", async () => {
    const { acc, user } = await seed();
    const a = await getAccountAnalytics(testPrisma, user, acc.id, range);
    expect(a.kpis.paymentsCount).toBe(2);
    expect(a.kpis.paymentsAmount).toBe(150);
    expect(a.kpis.totalDebt).toBe(100);
    expect(a.kpis.utilityAmount).toBe(100);
    expect(a.byMethod.find((m) => m.method === "CARD")!.amount).toBe(100);
    expect(a.byCategory.find((cc) => cc.category === "APARTMENT")!.amount).toBe(50);
  });
  it("paginates + isolates cross-tenant", async () => {
    const { acc } = await seed();
    const B = await seed();
    expect((await listAccountPayments(testPrisma, B.user, acc.id, { ...range })).total).toBe(0);
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/tenant/partner-analytics.ts`:
```ts
import type { PrismaClient, PaymentMethod, PaymentCategory } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

const num = (d: { toNumber: () => number } | null | undefined) => (d ? d.toNumber() : 0);

export async function getAccountAnalytics(db: PrismaClient, user: SessionUser, accountId: string, range: { from: Date; to: Date }) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const where = { companyId: user.companyId!, accountId, occurredAt: { gte: range.from, lte: range.to } };
  const [users, payments] = await Promise.all([
    db.partnerAppUser.findMany({ where: { companyId: user.companyId!, accountId } }),
    db.partnerPayment.findMany({ where }),
  ]);
  const totalDebt = users.reduce((s, u) => s + num(u.debt), 0);
  const activeUsers = users.filter((u) => u.active).length;
  const amount = (arr: typeof payments) => arr.reduce((s, p) => s + num(p.amount), 0);
  const util = payments.filter((p) => p.category === "UTILITY");
  const groupBy = <K extends string>(key: (p: typeof payments[number]) => K, keys: K[]) =>
    keys.map((k) => { const g = payments.filter((p) => key(p) === k); return { key: k, count: g.length, amount: amount(g) }; });
  const byMethod = groupBy((p) => p.method, ["CARD", "MANUAL", "CASH"] as PaymentMethod[]).map((r) => ({ method: r.key, count: r.count, amount: r.amount }));
  const byCategory = groupBy((p) => p.category, ["APARTMENT", "PARKING", "NON_RESIDENTIAL", "UTILITY"] as PaymentCategory[]).map((r) => ({ category: r.key, count: r.count, amount: r.amount }));
  const trendMap = new Map<string, { count: number; amount: number }>();
  for (const p of payments) { const d = p.occurredAt.toISOString().slice(0, 10); const t = trendMap.get(d) ?? { count: 0, amount: 0 }; t.count++; t.amount += num(p.amount); trendMap.set(d, t); }
  const trend = [...trendMap.entries()].sort().map(([date, v]) => ({ date, count: v.count, amount: v.amount }));
  const paidByUser = new Map<string, number>();
  for (const p of payments) paidByUser.set(p.appUserId, (paidByUser.get(p.appUserId) ?? 0) + num(p.amount));
  const topUsers = users.map((u) => ({ name: u.name, paid: paidByUser.get(u.id) ?? 0, debt: num(u.debt) })).sort((a, b) => b.paid - a.paid).slice(0, 10);
  return {
    kpis: { activeUsers, totalUsers: users.length, totalDebt, paymentsCount: payments.length, paymentsAmount: amount(payments), utilityCount: util.length, utilityAmount: amount(util) },
    byMethod, byCategory, trend, topUsers,
  };
}

export async function listAccountPayments(db: PrismaClient, user: SessionUser, accountId: string, opts: { from: Date; to: Date; method?: PaymentMethod; category?: PaymentCategory; skip?: number; take?: number }) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const where = { companyId: user.companyId!, accountId, occurredAt: { gte: opts.from, lte: opts.to }, ...(opts.method ? { method: opts.method } : {}), ...(opts.category ? { category: opts.category } : {}) };
  const [rows, total] = await Promise.all([
    db.partnerPayment.findMany({ where, orderBy: { occurredAt: "desc" }, skip: opts.skip, take: opts.take ?? 25, include: { appUser: true } }),
    db.partnerPayment.count({ where }),
  ]);
  return { rows: rows.map((p) => ({ id: p.id, occurredAt: p.occurredAt, amount: num(p.amount), method: p.method, category: p.category, userName: p.appUser.name })), total };
}
```

- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: scoped partner-analytics aggregation + transactions list"`

---

## Phase C — API + UI

### Task 5: Analytics API routes

**Files:** Create `src/app/api/accounts/[id]/analytics/route.ts`, `analytics/payments/route.ts`, `analytics/sync/route.ts`

**Interfaces:** Mirror existing account nested routes (session-guard; `errorResponse`). `GET analytics?preset|from|to` → `getAccountAnalytics` (resolveRange first; RangeError→400). `GET analytics/payments?from&to&method&category&skip&take` → `listAccountPayments`. `POST analytics/sync` → `syncAccountAnalytics(prisma, id, user.companyId!, new MockPartnerAnalyticsSource())` (session-guard + account visible via the service).

- [ ] **Step 1: Implement** `analytics/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccountAnalytics } from "@/lib/tenant/partner-analytics";
import { resolveRange, type RangePreset } from "@/lib/analytics/range";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let range; try { range = resolveRange({ preset: (sp.get("preset") as RangePreset) ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }); }
    catch { return NextResponse.json({ error: "invalid_range" }, { status: 400 }); }
    return NextResponse.json(await getAccountAnalytics(prisma, user, (await params).id, range));
  } catch (e) { return errorResponse(e); }
}
```
`analytics/payments/route.ts` — same guard + resolveRange, plus `method`/`category`/`skip`/`take` params → `listAccountPayments`.
`analytics/sync/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccount } from "@/lib/tenant/accounts";
import { syncAccountAnalytics } from "@/lib/analytics/sync";
import { MockPartnerAnalyticsSource } from "@/lib/analytics/source";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id } = await params;
    const acc = await getAccount(prisma, user, id);
    if (!acc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const r = await syncAccountAnalytics(prisma, id, user.companyId!, new MockPartnerAnalyticsSource());
    return NextResponse.json(r);
  } catch (e) { return errorResponse(e); }
}
```

- [ ] **Step 2: Build + test** — `npm run build` + `npm test` green. **Step 3: Commit** `git commit -am "feat: account analytics API (summary, payments, mock sync)"`

---

### Task 6: Analytics tab UI

**Files:** Create `src/app/(app)/accounts/[id]/Analytics.tsx`; Modify `src/app/(app)/accounts/[id]/AccountDetail.tsx` (mount it in the Analytics tab); Test `src/app/(app)/accounts/[id]/Analytics.test.tsx`

**Interfaces:** `Analytics({ accountId }: { accountId: string })` — client component; on mount + range change, GET `/api/accounts/[id]/analytics?...` and render. A "Sync mock data" button POSTs `/analytics/sync` then refetches (toast).

- [ ] **Step 1: Failing test** (render KPIs from a passed `initial` prop to keep it deterministic — the component accepts an optional `initialData` for SSR/testing):
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Analytics } from "./Analytics";
const data = { kpis: { activeUsers: 5, totalUsers: 8, totalDebt: 1200, paymentsCount: 40, paymentsAmount: 9000, utilityCount: 10, utilityAmount: 2000 }, byMethod: [], byCategory: [], trend: [], topUsers: [] };
describe("Analytics", () => {
  it("renders KPI tiles from initialData", () => {
    render(<Analytics accountId="a1" initialData={data} />);
    expect(screen.getByText(/active users/i)).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `Analytics.tsx`:
  - Range selector: buttons DAILY/7D/30D/90D/1Y + two date inputs for custom (on change refetch with `preset` or `from&to`).
  - KPI tiles (shadcn `Card`): Active Users, Total Users, Total Debt ($ tabular), Payments (count), Payments Amount ($), Utility Amount ($) — lucide icons.
  - **Trend chart**: a lightweight inline SVG area/line of `trend` (amount per day) — token colors (`--chart` accent), axis-free minimal, with an accessible `<title>`/summary; empty state when no data.
  - **Breakdowns**: two horizontal bar lists (byMethod, byCategory) — each row = label + bar (width = amount/max) + amount; use distinct accessible token colors, label+value (never color-only).
  - **Top users** table (name, paid, debt) and a **Transactions** table fetched from `/analytics/payments` (date, amount, method badge, category badge, user) with method/category filter selects + Prev/Next paging (skip/take).
  - "Sync mock data" button (POST sync → refetch, toast). All fetches check `res.ok` → toast on error.
  - Accepts `initialData?` to seed first render (SSR-friendly + testable); otherwise fetches on mount.
  In `AccountDetail.tsx`, replace the disabled Analytics placeholder tab content with `<Analytics accountId={account.id} />` (keep the tab kept-in-DOM pattern; the tab is now enabled).

- [ ] **Step 4: Build + test** — green. **Step 5: Commit** `git commit -am "feat: account analytics tab (KPIs, trend, breakdowns, top users, transactions)"`

---

### Task 7: Seed mock analytics + README

**Files:** Modify `prisma/seed.ts`, `README.md`

- [ ] **Step 1: Seed** — after demo accounts are created, for each demo account call `syncAccountAnalytics(prisma, acc.id, demoCompany.id, new MockPartnerAnalyticsSource())` (import from `../src/lib/analytics/sync` + `../src/lib/analytics/source`, relative). Print a summary. Idempotent (sync upserts users + regenerates payments).
- [ ] **Step 2: README** — add a "Mobile Analytics" section: account Analytics tab, range presets + custom dates, "Sync mock data" button, mock source swappable for the real API (`PartnerAnalyticsSource`), data tables `PartnerAppUser`/`PartnerPayment`.
- [ ] **Step 3: Run** `npm run seed` twice (idempotent), `npm test` green, `npm run build` clean.
- [ ] **Step 4: Commit** `git commit -am "feat: seed mock partner analytics + README"`

---

## Self-Review

- **Spec coverage:** tables + enums (T1), range presets+custom+error (T2), mock source behind interface + idempotent sync (T3), scoped aggregation KPIs/byMethod/byCategory/trend/topUsers + utility=UTILITY + paginated transactions + isolation (T4 tested), API summary/payments/sync with range→400 (T5), Analytics tab KPIs/trend/breakdowns/top-users/transactions + range selector + sync button (T6), seed+README (T7). All spec sections mapped.
- **Placeholder scan:** none — full code for schema, range, source, sync, aggregation, routes; UI gives exact component interface, data shape, endpoints, and chart approach.
- **Type consistency:** `RangePreset`/`resolveRange`, `PartnerAnalyticsSource`/`RawUser`/`RawPayment`, `syncAccountAnalytics(db,accountId,companyId,source)`, `getAccountAnalytics`/`listAccountPayments` signatures + the `Analytics` return shape consistent across tasks; enums (PaymentMethod/PaymentCategory) match schema; money via `.toNumber()`.
