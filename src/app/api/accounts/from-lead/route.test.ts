import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "@/lib/tenant/stages";
import { createLead } from "@/lib/tenant/leads";
import { encryptSecret } from "@/lib/crypto/secret";
import type { SessionUser } from "@/lib/auth/guards";

// Same shape as the sibling account route tests: run the handler against testPrisma with a
// session we control, off the network and off the real DB.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => mockUser }));

// Account creation auto-links a partner by name; keep that off the network here.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn(async () => ({ partners: [] })) }));

import { POST } from "./route";

function post(leadId: unknown) {
  return new NextRequest("http://localhost/api/accounts/from-lead", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leadId }),
  });
}

describe("POST /api/accounts/from-lead", () => {
  beforeEach(resetDb);
  afterEach(() => { mockUser = null; });
  afterAll(() => testPrisma.$disconnect());

  // Seeds a company with a lead already sitting in Won (created straight into the stage, so no
  // auto-conversion has run yet) and returns roles bound to that tenant.
  async function seed(slug: string) {
    const c = await testPrisma.company.create({ data: { name: "Co", slug } });
    await seedDefaultStages(testPrisma, c.id);
    const stages = await listStages(testPrisma, { companyId: c.id });
    const won = stages.find((s) => s.type === "WON")!;
    const member = await testPrisma.user.create({
      data: { companyId: c.id, email: `m-${slug}@a.com`, passwordHash: "x", name: "M", role: "MEMBER" },
    });
    const memberUser: SessionUser = { id: member.id, companyId: c.id, role: "MEMBER" };
    const lead = await createLead(testPrisma, memberUser, {
      title: "Deal", contactName: "C", companyName: "WonCo", stageId: won.id,
    });
    return { c, lead, memberUser };
  }

  it("rejects a PARTNER_VIEWER with 403 and creates nothing", async () => {
    const { c, lead } = await seed("fl-viewer");
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, name: "Their Account", accountManagerId: (await testPrisma.user.findFirstOrThrow({ where: { companyId: c.id } })).id },
    });
    const viewer = await testPrisma.user.create({
      data: { companyId: c.id, email: "pv@a.com", passwordHash: "x", name: "PV", role: "PARTNER_VIEWER", accountId: acc.id },
    });
    mockUser = { id: viewer.id, companyId: c.id, role: "PARTNER_VIEWER", accountId: acc.id };

    const res = await POST(post(lead.id));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
  });

  it("rejects an unauthenticated caller with 401", async () => {
    const { lead } = await seed("fl-anon");
    mockUser = null;
    const res = await POST(post(lead.id));
    expect(res.status).toBe(401);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
  });

  it("lets a MEMBER convert (201), then returns the SAME account on a repeat call (200)", async () => {
    const { lead, memberUser } = await seed("fl-member");
    mockUser = memberUser;

    const first = await POST(post(lead.id));
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.sourceLeadId).toBe(lead.id);
    expect(created.name).toBe("WonCo");

    // Double-click / retry: no 409, no duplicate — points at the account that already exists.
    const second = await POST(post(lead.id));
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(created.id);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
  });

  it("lets a COMPANY_ADMIN convert", async () => {
    const { c, lead } = await seed("fl-admin");
    const admin = await testPrisma.user.create({
      data: { companyId: c.id, email: "adm@a.com", passwordHash: "x", name: "A", role: "COMPANY_ADMIN" },
    });
    mockUser = { id: admin.id, companyId: c.id, role: "COMPANY_ADMIN" };
    const res = await POST(post(lead.id));
    expect(res.status).toBe(201);
  });

  it("404s on a lead outside the caller's tenant", async () => {
    const A = await seed("fl-tenant-a");
    const B = await seed("fl-tenant-b");
    mockUser = B.memberUser;
    const res = await POST(post(A.lead.id));
    expect(res.status).toBe(404);
    expect(await testPrisma.account.count({ where: { sourceLeadId: A.lead.id } })).toBe(0);
  });

  it("400s on a malformed body", async () => {
    const { memberUser } = await seed("fl-bad");
    mockUser = memberUser;
    const res = await POST(post(""));
    expect(res.status).toBe(400);
  });

  // The partner-API secret columns are dormant (the shared X-API-Key from env is what's used now)
  // but still exist, and this route used to return the raw Account row while its two siblings
  // masked it. The created===false branch is the sharp edge: it hands back a PRE-EXISTING row,
  // which is exactly the one that could carry a leftover externalApiKeyEnc.
  describe("never leaks the partner key columns", () => {
    const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    let savedSecret: string | undefined;

    beforeEach(() => {
      savedSecret = process.env.PARTNER_API_KEY_SECRET;
      process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    });
    afterEach(() => {
      if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET;
      else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    });

    it("201 (freshly created): the response carries no key columns", async () => {
      const { lead, memberUser } = await seed("fl-mask-new");
      mockUser = memberUser;

      const res = await POST(post(lead.id));

      expect(res.status).toBe(201);
      const body = await res.json();
      expect("externalApiKeyEnc" in body).toBe(false);
      expect("externalApiKeyLast4" in body).toBe(false);
    });

    it("200 (idempotent reuse): a pre-existing row's dormant override key never reaches the client", async () => {
      const { c, lead, memberUser } = await seed("fl-mask-existing");
      const plaintext = "sk_live_fromlead987";
      const ciphertext = encryptSecret(plaintext);
      // The lead was already converted, and that account carries a dormant per-account key.
      await testPrisma.account.create({
        data: {
          companyId: c.id, name: "Already Converted", accountManagerId: memberUser.id,
          sourceLeadId: lead.id, externalPartnerKey: "partner-fl",
          externalApiKeyEnc: ciphertext, externalApiKeyLast4: "9876",
        },
      });
      mockUser = memberUser;

      const res = await POST(post(lead.id));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect("externalApiKeyEnc" in body).toBe(false);
      expect("externalApiKeyLast4" in body).toBe(false);
      expect(body.externalPartnerKey).toBe("partner-fl"); // the partner NAME is not a secret
      const raw = JSON.stringify(body);
      expect(raw).not.toContain(plaintext);
      expect(raw).not.toContain(ciphertext);
    });
  });
});
