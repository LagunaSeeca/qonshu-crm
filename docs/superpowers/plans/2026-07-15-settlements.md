# Settlements / Bank Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-partner settlement ledger — manually recorded COLLECTED (money into the bank) and TRANSFER (cash paid to the partner) entries, with `owed = collected − transferred`, a company Settlements page, and a per-partner registry on the account detail.

**Architecture:** Reuses M1–M4: one `SettlementEntry` table scoped by companyId+accountId, a tenant-scoped service (access gated through M3 `getAccount`), zod-validated routes (admin-only writes), and design-system UI (new `/settlements` page + a Settlement tab on the account detail).

**Tech Stack:** Next.js 16 (App Router, TS strict), React 19, Prisma 7 (pg adapter), Postgres (Docker 5433), Vitest (`fileParallelism:false`), shadcn/ui (base-ui variant — no `asChild`; use `buttonVariants`/`render`), lucide-react, sonner, Tailwind v4.

## Global Constraints

- TS `strict: true`; no `any`.
- Tenant data via `src/lib/tenant/*` scoped helpers — never raw `prisma.<tenantModel>` in route/page/UI. Access gated via `getAccount(db, user, accountId)` (company-wide account visibility); out-of-scope → 404 (`NotFoundError` from `@/lib/auth/guards`).
- **Writes are COMPANY_ADMIN only** — `assertRole(user, ["COMPANY_ADMIN"])` in the POST/DELETE routes (403 otherwise). Reads: any authenticated member.
- Entries are MANUAL — never derive collected from `PartnerPayment`.
- `owed = collected − transferred` (may be negative). Money is Decimal → `.toNumber()` in aggregation, `Number(x)` in tests.
- Enums: `SettlementType` = COLLECTED|TRANSFER; `SettlementMethod` = CASH|BANK_TRANSFER.
- Reuse: `prisma` (`@/db/client`), `getSessionUser` (`@/lib/auth/session`), `assertRole`/`NotFoundError` (`@/lib/auth/guards`), `getAccount` (`@/lib/tenant/accounts`), `errorResponse`/`UnauthorizedError` (`@/lib/http`), `testPrisma`/`resetDb` (`@/test/db`), UI components in `src/components/ui`.
- Docker flaky: `docker ps`; if it errors start `"/c/Program Files/Docker/Docker/Docker Desktop.exe"`, wait, retry. Then `docker compose up -d` (5433). Add the new table to `resetDb` (before account). Suite is 75 green — keep it.

---

## File Structure
```
prisma/schema.prisma                          # + SettlementEntry + 2 enums
src/test/db.ts                                # resetDb: settlementEntry (before account)
src/lib/tenant/settlements.ts                 # scoped service
src/app/api/settlements/route.ts              # GET company summary
src/app/api/accounts/[id]/settlement/route.ts # GET ledger, POST entry (admin)
src/app/api/accounts/[id]/settlement/[entryId]/route.ts  # DELETE (admin)
src/app/(app)/settlements/page.tsx            # company Settlements page
src/app/(app)/accounts/[id]/Settlement.tsx    # Settlement tab panel
src/app/(app)/accounts/[id]/AccountDetail.tsx # MODIFY: add Settlement tab
src/components/Sidebar.tsx                    # MODIFY: + Settlements nav item
```

---

### Task 1: Schema

**Files:** Modify `prisma/schema.prisma`, `src/test/db.ts`; Test `src/db/settlement-schema.test.ts`

**Interfaces:** Produces `SettlementEntry` model + `SettlementType`(COLLECTED|TRANSFER), `SettlementMethod`(CASH|BANK_TRANSFER). Cascades from Account + Company.

- [ ] **Step 1: Failing test** `src/db/settlement-schema.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("settlement schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("creates entries and cascades on account delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-se" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id } });
    const e = await testPrisma.settlementEntry.create({ data: { companyId: c.id, accountId: acc.id, type: "COLLECTED", amount: "500", occurredAt: new Date(), createdById: u.id } });
    expect(Number(e.amount)).toBe(500);
    expect(e.type).toBe("COLLECTED");
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.settlementEntry.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
```
- [ ] **Step 2: Schema** (multi-line enums):
```prisma
enum SettlementType {
  COLLECTED
  TRANSFER
}
enum SettlementMethod {
  CASH
  BANK_TRANSFER
}

model SettlementEntry {
  id          String            @id @default(cuid())
  companyId   String
  company     Company           @relation(fields: [companyId], references: [id], onDelete: Cascade)
  accountId   String
  account     Account           @relation(fields: [accountId], references: [id], onDelete: Cascade)
  type        SettlementType
  amount      Decimal
  method      SettlementMethod?
  occurredAt  DateTime
  note        String?
  createdById String
  createdAt   DateTime          @default(now())
  @@index([companyId, accountId])
  @@index([companyId, type])
}
```
Add `settlementEntries SettlementEntry[]` to BOTH `Company` and `Account`.
- [ ] **Step 3: Migrate** — `docker compose up -d`; `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu?schema=public" npx prisma migrate dev --name settlements` + `npx prisma generate`; test DB: `DATABASE_URL="postgresql://qonshu:qonshu@localhost:5433/qonshu_test?schema=public" npx prisma migrate deploy`.
- [ ] **Step 4: resetDb** — add `await testPrisma.settlementEntry.deleteMany();` at the TOP of `resetDb` (before account deletes).
- [ ] **Step 5: Run** `npm test` → green. **Step 6: Commit** `git commit -am "feat: prisma settlement entry model"`

---

### Task 2: Settlements service

**Files:** Create `src/lib/tenant/settlements.ts`; Test `src/lib/tenant/settlements.test.ts`

**Interfaces:**
- `addSettlementEntry(db, user, accountId, { type, amount, method?, occurredAt, note? }): Promise<SettlementEntry>` — account must be visible (`getAccount`), else NotFoundError; `createdById = user.id`.
- `deleteSettlementEntry(db, user, entryId): Promise<void>` — scoped by companyId; NotFoundError if absent.
- `getAccountSettlement(db, user, accountId): Promise<{ collected: number; transferred: number; owed: number; entries: SettlementEntry[] }>` — entries newest-first; NotFoundError if account not visible.
- `listCompanySettlements(db, user): Promise<{ totals: { collected: number; transferred: number; owed: number }; rows: { accountId: string; accountName: string; collected: number; transferred: number; owed: number }[] }>` — every account in the company (zeros when no entries).

- [ ] **Step 1: Failing test** `src/lib/tenant/settlements.test.ts`:
```ts
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { addSettlementEntry, getAccountSettlement, listCompanySettlements, deleteSettlementEntry } from "./settlements";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("settlements", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("computes owed = collected - transferred", async () => {
    const { acc, user } = await setup("s1");
    await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 500, occurredAt: new Date() });
    await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 300, occurredAt: new Date() });
    await addSettlementEntry(testPrisma, user, acc.id, { type: "TRANSFER", amount: 200, method: "CASH", occurredAt: new Date() });
    const s = await getAccountSettlement(testPrisma, user, acc.id);
    expect(s.collected).toBe(800);
    expect(s.transferred).toBe(200);
    expect(s.owed).toBe(600);
    expect(s.entries.length).toBe(3);
  });

  it("company summary totals match rows; cross-tenant isolated", async () => {
    const A = await setup("s2");
    await addSettlementEntry(testPrisma, A.user, A.acc.id, { type: "COLLECTED", amount: 100, occurredAt: new Date() });
    const B = await setup("s3");
    const sumA = await listCompanySettlements(testPrisma, A.user);
    expect(sumA.totals.collected).toBe(100);
    expect(sumA.rows.length).toBe(1);
    const sumB = await listCompanySettlements(testPrisma, B.user);
    expect(sumB.totals.collected).toBe(0);
    await expect(getAccountSettlement(testPrisma, B.user, A.acc.id)).rejects.toThrow();
  });

  it("delete updates totals", async () => {
    const { acc, user } = await setup("s4");
    const e = await addSettlementEntry(testPrisma, user, acc.id, { type: "COLLECTED", amount: 50, occurredAt: new Date() });
    await deleteSettlementEntry(testPrisma, user, e.id);
    expect((await getAccountSettlement(testPrisma, user, acc.id)).collected).toBe(0);
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `src/lib/tenant/settlements.ts`:
```ts
import type { PrismaClient, SettlementEntry, SettlementType, SettlementMethod } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

const num = (d: { toNumber: () => number }) => d.toNumber();
const sum = (rows: SettlementEntry[], t: SettlementType) =>
  rows.filter((r) => r.type === t).reduce((s, r) => s + num(r.amount), 0);

export async function addSettlementEntry(db: PrismaClient, user: SessionUser, accountId: string, args: {
  type: SettlementType; amount: number; method?: SettlementMethod; occurredAt: Date; note?: string;
}): Promise<SettlementEntry> {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  return db.settlementEntry.create({ data: {
    companyId: user.companyId!, accountId, type: args.type, amount: args.amount,
    method: args.method ?? null, occurredAt: args.occurredAt, note: args.note ?? null, createdById: user.id,
  } });
}

export async function deleteSettlementEntry(db: PrismaClient, user: SessionUser, entryId: string): Promise<void> {
  const found = await db.settlementEntry.findFirst({ where: { id: entryId, companyId: user.companyId! } });
  if (!found) throw new NotFoundError("entry not in tenant");
  await db.settlementEntry.delete({ where: { id: entryId } });
}

export async function getAccountSettlement(db: PrismaClient, user: SessionUser, accountId: string) {
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const entries = await db.settlementEntry.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { occurredAt: "desc" } });
  const collected = sum(entries, "COLLECTED");
  const transferred = sum(entries, "TRANSFER");
  return { collected, transferred, owed: collected - transferred, entries };
}

export async function listCompanySettlements(db: PrismaClient, user: SessionUser) {
  if (!user.companyId) throw new Error("no tenant context");
  const [accounts, entries] = await Promise.all([
    db.account.findMany({ where: { companyId: user.companyId }, orderBy: { name: "asc" } }),
    db.settlementEntry.findMany({ where: { companyId: user.companyId } }),
  ]);
  const rows = accounts.map((a) => {
    const mine = entries.filter((e) => e.accountId === a.id);
    const collected = sum(mine, "COLLECTED");
    const transferred = sum(mine, "TRANSFER");
    return { accountId: a.id, accountName: a.name, collected, transferred, owed: collected - transferred };
  });
  const totals = rows.reduce((t, r) => ({ collected: t.collected + r.collected, transferred: t.transferred + r.transferred, owed: t.owed + r.owed }), { collected: 0, transferred: 0, owed: 0 });
  return { totals, rows };
}
```
- [ ] **Step 4: Run → pass. Step 5: Commit** `git commit -am "feat: settlements service (per-partner ledger + company summary)"`

---

### Task 3: API routes

**Files:** Create `src/app/api/settlements/route.ts`, `src/app/api/accounts/[id]/settlement/route.ts`, `src/app/api/accounts/[id]/settlement/[entryId]/route.ts`

- [ ] **Step 1: Implement** `src/app/api/settlements/route.ts`:
```ts
import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listCompanySettlements } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listCompanySettlements(prisma, user));
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/accounts/[id]/settlement/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccountSettlement, addSettlementEntry } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountSettlement(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({
  type: z.enum(["COLLECTED", "TRANSFER"]),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER"]).optional(),
  occurredAt: z.string().min(1),
  note: z.string().optional(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const d = Body.parse(await req.json());
    const occurredAt = new Date(d.occurredAt);
    if (isNaN(occurredAt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    const entry = await addSettlementEntry(prisma, user, (await params).id, { type: d.type, amount: d.amount, method: d.method, occurredAt, note: d.note });
    return NextResponse.json(entry, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
```
`src/app/api/accounts/[id]/settlement/[entryId]/route.ts`:
```ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { deleteSettlementEntry } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteSettlementEntry(prisma, user, (await params).entryId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
```
- [ ] **Step 2: Build + test** — `npm run build` + `npm test` green. **Step 3: Commit** `git commit -am "feat: settlements API (company summary, ledger, admin writes)"`

---

### Task 4: UI — Settlement tab + company Settlements page + nav

**Files:** Create `src/app/(app)/accounts/[id]/Settlement.tsx`, `src/app/(app)/settlements/page.tsx`; Modify `src/app/(app)/accounts/[id]/AccountDetail.tsx`, `src/components/Sidebar.tsx`; Test `src/app/(app)/accounts/[id]/Settlement.test.tsx`

- [ ] **Step 1: Failing test** (mock `next/navigation`):
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { Settlement } from "./Settlement";

const data = { collected: 800, transferred: 200, owed: 600, entries: [{ id: "e1", type: "COLLECTED", amount: 800, method: null, occurredAt: new Date().toISOString(), note: "june", createdById: "u" }] };
describe("Settlement", () => {
  it("renders balances + registry", () => {
    render(<Settlement accountId="a1" isAdmin initialData={data} />);
    expect(screen.getByText(/owed/i)).toBeInTheDocument();
    expect(screen.getByText("june")).toBeInTheDocument();
  });
});
```
- [ ] **Step 2: Run → fail. Step 3: Implement** `Settlement.tsx` (client): props `{ accountId: string; isAdmin: boolean; initialData?: {collected,transferred,owed,entries[]} }`; fetches `GET /api/accounts/[id]/settlement` on mount when no `initialData`. Renders three shadcn `Card` balance tiles — **Collected**, **Transferred**, **Owed** (tabular currency; owed emphasized) — then, for admins, an **Add entry** form (type `Select` COLLECTED/TRANSFER, amount `Input` number, method `Select` CASH/BANK_TRANSFER shown when type=TRANSFER, date `Input type=date`, note `Input`) POSTing to the settlement route; then the **registry** shadcn `Table` (date, type `Badge` — COLLECTED green / TRANSFER amber, method, amount tabular, note, and a delete `Button` per row for admins → DELETE `/settlement/[entryId]`). All mutations check `res.ok` → sonner `toast`; refetch after success. Empty state when no entries.
  In `AccountDetail.tsx`: add a **Settlement** tab (kept-in-DOM pattern, same as the other tabs) rendering `<Settlement accountId={account.id} isAdmin={...} />`. Pass an `isAdmin` prop into AccountDetail from its server page (`page.tsx`: `user.role === "COMPANY_ADMIN"`).
- [ ] **Step 4: Company page** `src/app/(app)/settlements/page.tsx` (server): guard is handled by the (app) layout; load `listCompanySettlements(prisma, user)`; render a page header "Settlements", three totals `Card`s (Collected / Transferred / Owed), and a shadcn `Table` of rows (partner name → link `/accounts/[accountId]`, collected, transferred, owed — all tabular right-aligned). Empty state when the company has no accounts.
- [ ] **Step 5: Sidebar** — add a **Settlements** item (`/settlements`, lucide `Landmark` or `Wallet` icon) to the tenant nav in `src/components/Sidebar.tsx`, keeping the existing role-gating + the Sidebar test green.
- [ ] **Step 6: Build + test** — `npm run build` + `npm test` green (75 + new Settlement test). **Step 7: Commit** `git commit -am "feat: settlements UI (ledger tab, company page, nav)"`

---

### Task 5: Seed demo entries + README

**Files:** Modify `prisma/seed.ts`, `README.md`

- [ ] **Step 1: Seed** — after the demo accounts exist, wipe + create demo settlement entries for the demo company: `await prisma.settlementEntry.deleteMany({ where: { companyId: demoCompany.id } })`, then for each demo account create 2 COLLECTED entries and 1 TRANSFER entry (varied amounts/dates, `createdById` = demo admin id, TRANSFER `method: "CASH"`). Print a summary line. Idempotent.
- [ ] **Step 2: README** — add a "Settlements" section: `/settlements` company page (totals + per-partner collected/transferred/owed), the Settlement tab on an account (registry + add entry), entries are manual, admin-only writes.
- [ ] **Step 3: Run** `npm run seed` twice, `npm test` green, `npm run build` clean.
- [ ] **Step 4: Commit** `git commit -am "feat: seed demo settlement entries + README"`

---

## Self-Review
- **Spec coverage:** model+enums+cascade (T1), manual entries + owed math + company summary + isolation + delete (T2 tested), routes with admin-only writes + 404/403/400 (T3), Settlement tab registry + add/delete + company page + nav (T4), seed+README (T5). All spec sections mapped.
- **Placeholder scan:** none — full code for schema, service, routes, tests; UI gives exact props, endpoints, components, behavior.
- **Type consistency:** `addSettlementEntry`/`deleteSettlementEntry`/`getAccountSettlement`/`listCompanySettlements` signatures + return shapes consistent across tasks; enums match schema; money via `.toNumber()`.
