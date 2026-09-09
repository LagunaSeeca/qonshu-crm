import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";
import { recordPartnerLinkChange } from "@/lib/tenant/partner-link-audit";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";

function post(id: string, body: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/accounts/${id}/activities`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
}

function get(id: string) {
  return GET(
    new NextRequest(`http://localhost/api/accounts/${id}/activities`),
    { params: Promise.resolve({ id }) },
  );
}

async function seed(slug: string) {
  const c = await testPrisma.company.create({ data: { name: `Co ${slug}`, slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
  });
  const acc = await testPrisma.account.create({
    data: { companyId: c.id, name: `Acct ${slug}`, accountManagerId: u.id },
  });
  return { c, u, acc, user: { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" } as SessionUser };
}

// AccountActivity is where the partner-link audit trail lives (src/lib/tenant/partner-link-audit.ts)
// AND where the tenant writes its own timeline. This route is the tenant's door to it, and it takes
// a free-text `outcome` plus a caller-chosen `occurredAt` from any COMPANY_ADMIN/MEMBER — so
// without a reservation the company being audited could plant rows that read exactly like the
// platform admin's, backdated to wherever they liked.
describe("POST /api/accounts/[id]/activities — the partner_link: outcome is reserved", () => {
  let ts = "";
  beforeEach(async () => { await resetDb(); ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`; });
  afterEach(() => { mockUser = null; });
  afterAll(() => testPrisma.$disconnect());

  it("400s a forged audit outcome and writes nothing", async () => {
    const { acc, user } = await seed(`forge-${ts}`);
    mockUser = user;

    for (const outcome of ["partner_link:assign", "partner_link:clear", "partner_link:auto_link"]) {
      const res = await post(acc.id, {
        kind: "NOTE",
        body: 'Partner link set to "Komplex B" by a platform admin',
        outcome,
        occurredAt: "2020-01-01T00:00:00.000Z",
      });
      expect(res.status).toBe(400);
    }
    expect(await testPrisma.accountActivity.count()).toBe(0);
  });

  it("201s an ordinary outcome — the reservation is the prefix, not the field", async () => {
    const { acc, user } = await seed(`ok-${ts}`);
    mockUser = user;

    const res = await post(acc.id, { kind: "CALL", body: "left a voicemail", outcome: "no answer" });
    expect(res.status).toBe(201);
    expect((await res.json()).outcome).toBe("no answer");
  });

  it("lets a SUPER_ADMIN GET the trail they write, but still refuses them the POST", async () => {
    const { c, acc } = await seed(`su-${ts}`);
    await recordPartnerLinkChange(testPrisma, {
      companyId: c.id, accountId: acc.id, authorId: "su", action: "assign", partnerName: "Komplex B",
    });
    mockUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };

    const res = await get(acc.id);
    expect(res.status).toBe(200);
    expect((await res.json()).map((r: { outcome: string }) => r.outcome)).toEqual(["partner_link:assign"]);

    // Read-only: a platform admin must never author rows on a tenant's timeline.
    expect((await post(acc.id, { kind: "NOTE", body: "hello" })).status).toBe(403);
    expect(await testPrisma.accountActivity.count()).toBe(1);
  });
});
