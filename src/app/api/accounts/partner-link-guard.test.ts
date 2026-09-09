import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// The partner namespace is GLOBAL (one shared PARTNER_API_KEY; `?partner=<name>` is the only
// discriminator), so a tenant that could name a partner could read another tenant's debt,
// payments and unit-level owner names/phones. These tests pin the boundary: the company-facing
// account routes must IGNORE `externalPartnerKey` in the request body no matter who sends it,
// while the SYSTEM auto-link keeps working untouched.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { POST } from "./route";
import { PATCH } from "./[id]/route";

function liveList(): PartnerListResponse {
  return {
    partners: [
      { name: "Komplex B", type: "RESIDENTIAL" },
      { name: "Sabah.City", type: "COMMERCIAL" },
    ],
  };
}

// Grants a complex to a company — the only thing that lets the SYSTEM auto-link fire at all.
async function grant(companyId: string, partnerName: string) {
  return testPrisma.partnerAllowlist.create({
    data: { companyId, partnerName, normalizedName: partnerName.trim().toLowerCase() },
  });
}

function jsonReq(url: string, method: string, body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

describe("account routes ignore externalPartnerKey in the request body", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;
  let ts = "";

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "sk_live_global";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue(liveList());
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  async function seed(slug: string, role: SessionUser["role"] = "COMPANY_ADMIN") {
    const c = await testPrisma.company.create({ data: { name: "Co", slug } });
    const u = await testPrisma.user.create({
      data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role },
    });
    mockUser = { id: u.id, companyId: c.id, role };
    return { c, u };
  }

  it("POST: a COMPANY_ADMIN's externalPartnerKey is not persisted", async () => {
    await seed(`post-admin-${ts}`);

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Totally Unrelated Name",
      externalPartnerKey: "Komplex B",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.account.externalPartnerKey).toBeNull();

    const row = await testPrisma.account.findUnique({ where: { id: body.account.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("POST: a MEMBER's externalPartnerKey is not persisted either", async () => {
    await seed(`post-member-${ts}`, "MEMBER");

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Another Unrelated Name",
      externalPartnerKey: "Sabah.City",
    }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("POST: a body key cannot steal a partner already claimed by ANOTHER company", async () => {
    const other = await testPrisma.company.create({ data: { name: "Other", slug: `other-${ts}` } });
    const otherMgr = await testPrisma.user.create({
      data: { companyId: other.id, email: `o-${ts}@a.com`, passwordHash: "x", name: "O", role: "COMPANY_ADMIN" },
    });
    const holder = await testPrisma.account.create({
      data: { companyId: other.id, name: "Holder", accountManagerId: otherMgr.id, externalPartnerKey: "Komplex B" },
    });

    await seed(`thief-${ts}`);
    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Thief Co", externalPartnerKey: "Komplex B",
    }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBeNull();
    // and the rightful holder is untouched
    const holderRow = await testPrisma.account.findUnique({ where: { id: holder.id } });
    expect(holderRow?.externalPartnerKey).toBe("Komplex B");
  });

  it("POST: the SYSTEM auto-link still fires when the complex is granted to this company", async () => {
    const { c } = await seed(`autolink-${ts}`);
    await grant(c.id, "Komplex B");

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });

  it("POST: naming an account after an UNGRANTED complex links nothing and reveals nothing", async () => {
    await seed(`autolink-nogrant-${ts}`);

    // "Komplex B" is a real upstream complex, but this company was never granted it. The 201 body
    // must be identical to one for a made-up name — no key, no error, no flag — or the response
    // becomes an oracle for enumerating every complex on the platform.
    const real = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    const fake = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "No Such Complex At All" }));
    expect(real.status).toBe(201);
    expect(fake.status).toBe(201);

    const realBody = (await real.json()).account;
    const fakeBody = (await fake.json()).account;
    expect(realBody.externalPartnerKey).toBeNull();
    expect(fakeBody.externalPartnerKey).toBeNull();
    // Same shape, same fields, nothing that separates "exists but not yours" from "doesn't exist".
    expect(Object.keys(realBody).sort()).toEqual(Object.keys(fakeBody).sort());
  });

  it("POST: a grant to ANOTHER company does not let this company claim the complex", async () => {
    const other = await testPrisma.company.create({ data: { name: "Other", slug: `grant-other-${ts}` } });
    await grant(other.id, "Komplex B");

    await seed(`grant-thief-${ts}`);
    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("POST: auto-link still refuses a name already claimed elsewhere", async () => {
    const other = await testPrisma.company.create({ data: { name: "Other", slug: `auto-taken-${ts}` } });
    const otherMgr = await testPrisma.user.create({
      data: { companyId: other.id, email: `at-${ts}@a.com`, passwordHash: "x", name: "O", role: "COMPANY_ADMIN" },
    });
    await testPrisma.account.create({
      data: { companyId: other.id, name: "Komplex B", accountManagerId: otherMgr.id, externalPartnerKey: "Komplex B" },
    });

    // Granted to US, yet already claimed by that other account: the grant authorizes the link,
    // it does not override the one-account-per-complex rule.
    const { c } = await seed(`auto-taken-me-${ts}`);
    await grant(c.id, "Komplex B");
    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("PATCH: a COMPANY_ADMIN cannot set the link on an unlinked account", async () => {
    const { c, u } = await seed(`patch-set-${ts}`);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, name: "Unlinked", accountManagerId: u.id },
    });

    const res = await PATCH(
      jsonReq(`http://localhost/api/accounts/${acc.id}`, "PATCH", { externalPartnerKey: "Komplex B" }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("PATCH: a MEMBER cannot re-point an already-linked account at another partner", async () => {
    const { c, u } = await seed(`patch-repoint-${ts}`, "MEMBER");
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, name: "Linked", accountManagerId: u.id, externalPartnerKey: "Komplex B" },
    });

    const res = await PATCH(
      jsonReq(`http://localhost/api/accounts/${acc.id}`, "PATCH", {
        name: "Renamed", externalPartnerKey: "Sabah.City",
      }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.name).toBe("Renamed"); // the rest of the patch still applies
    expect(row?.externalPartnerKey).toBe("Komplex B"); // the link does not
  });

  it("PATCH: a COMPANY_ADMIN cannot CLEAR the link either", async () => {
    const { c, u } = await seed(`patch-clear-${ts}`);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, name: "Linked", accountManagerId: u.id, externalPartnerKey: "Komplex B" },
    });

    const res = await PATCH(
      jsonReq(`http://localhost/api/accounts/${acc.id}`, "PATCH", { externalPartnerKey: null }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });
});
