import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
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
  const team = await makeTeam({ name: slug });
  const c = { id: team.companyId };
  const u = await makeUser("COMPANY_ADMIN", team);
  const acc = await testPrisma.account.create({
    data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey(`Acct ${slug}`), name: `Acct ${slug}`, accountManagerId: u.id },
  });
  return { c, u, acc, user: su(u) };
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

  // CHANGED ON PURPOSE (teams refactor): the partner-link audit trail moved from AccountActivity to
  // the durable PartnerLinkAudit table, so the timeline a SUPER_ADMIN GETs no longer contains
  // `partner_link:*` rows. The read stays allowed. The POST is NO LONGER refused: assertRole now
  // lets SUPER_ADMIN through any list that admits COMPANY_ADMIN (guards.ts), which is how the
  // refactor defines "a super admin can do anything a team admin can". The route's own comment
  // ("They stay OUT of POST") predates that and is stale -- flagged to the conductor.
  it("lets a SUPER_ADMIN GET the timeline (audit rows live in PartnerLinkAudit, not in it) and POST to it", async () => {
    const { c, acc, user } = await seed(`su-${ts}`);
    mockUser = user;
    expect((await post(acc.id, { kind: "NOTE", body: "tenant note" })).status).toBe(201);
    const admin = await makeUser("SUPER_ADMIN");
    await recordPartnerLinkChange(testPrisma, {
      companyId: c.id, accountId: acc.id, accountName: acc.name, actorId: admin.id, action: "assign", partnerName: "Komplex B",
    });
    mockUser = su(admin);

    const res = await get(acc.id);
    expect(res.status).toBe(200);
    expect((await res.json()).map((r: { body: string }) => r.body)).toEqual(["tenant note"]);
    expect(await testPrisma.partnerLinkAudit.count({ where: { accountId: acc.id } })).toBe(1);

    // The super admin's POST lands on the ACCOUNT's company, attributed to them, and the reserved
    // partner_link: prefix is still refused for them like everyone else.
    const created = await post(acc.id, { kind: "NOTE", body: "hello" });
    expect(created.status).toBe(201);
    expect(await testPrisma.accountActivity.findFirst({ where: { body: "hello" } }))
      .toMatchObject({ companyId: c.id, accountId: acc.id, authorId: admin.id });
    expect((await post(acc.id, { kind: "NOTE", body: "x", outcome: "partner_link:assign" })).status).toBe(400);
    expect(await testPrisma.accountActivity.count()).toBe(2);
  });
});
