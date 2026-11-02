import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// The partner namespace is GLOBAL (one shared PARTNER_API_KEY; `?partner=<name>` is the only
// discriminator), so a tenant that could name a partner could read another tenant's debt,
// payments and unit-level owner names/phones. These tests pin the boundary: the company-facing
// account routes must IGNORE `externalPartnerKey` in the request body no matter who sends it,
// while the SYSTEM auto-link keeps working untouched. (Auto-link now resolves against the LIVE
// upstream list — the per-company PartnerAllowlist is gone — so there is nothing to "grant".)
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
    const team = await makeTeam({ name: slug });
    const c = { id: team.companyId };
    const u = await makeUser(role, team);
    mockUser = su(u);
    return { c, u, team };
  }

  // An account in a different company already holding `partnerKey` (the namespace is global).
  async function seedForeignHolder(label: string, partnerKey: string, name: string) {
    const otherTeam = await makeTeam({ name: `${label}-${ts}` });
    const otherMgr = await makeUser("COMPANY_ADMIN", otherTeam);
    return testPrisma.account.create({
      data: {
        companyId: otherTeam.companyId, teamId: otherTeam.id, buildingKey: buildingKey(name),
        name, accountManagerId: otherMgr.id, externalPartnerKey: partnerKey,
      },
    });
  }

  it("POST: a COMPANY_ADMIN's externalPartnerKey is not persisted", async () => {
    await seed(`post-admin-${ts}`);

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Totally Unrelated Name",
      externalPartnerKey: "Komplex B",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    // The response never carries the field at all now (it was an enumeration oracle — see
    // src/lib/tenant/account-dto.ts), so the stored row is the only thing worth asserting.
    expect("externalPartnerKey" in body.account).toBe(false);

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
    const holder = await seedForeignHolder("other", "Komplex B", "Holder");

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

  it("POST: the SYSTEM auto-link still fires when the account's name matches a live upstream complex", async () => {
    await seed(`autolink-${ts}`);

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });

  // CHANGED ON PURPOSE (teams refactor): this was "naming an account after an UNGRANTED complex
  // links nothing and reveals nothing", guarding an enumeration oracle between TENANTS. The
  // allowlist (and Company as the customer boundary) is gone: there is one org and the boundary is
  // the team, enforced by the building claim guard. Auto-link now keys purely off the live upstream
  // list, so a name that matches a real complex DOES link and a made-up one does not. The
  // security-relevant half of the old test is kept: a body externalPartnerKey still has no effect
  // (see the tests above) and the stored key is the upstream's exact spelling, never the caller's.
  it("POST: naming an account after a live complex links it (exact upstream spelling); a made-up name links nothing", async () => {
    await seed(`autolink-live-${ts}`);

    const real = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "  komplex b " }));
    const fake = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "No Such Complex At All" }));
    expect(real.status).toBe(201);
    expect(fake.status).toBe(201);

    // Asserted on the STORED ROW, not the response: the body no longer answers the question (it
    // was the enumeration oracle), while the link behaviour itself is unchanged.
    const rowOf = async (res: Response) =>
      testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect((await rowOf(real))?.externalPartnerKey).toBe("Komplex B");
    expect((await rowOf(fake))?.externalPartnerKey).toBeNull();
  });

  it("POST: auto-link still refuses a name already claimed elsewhere", async () => {
    await seedForeignHolder("auto-taken", "Komplex B", "Komplex B");

    // A real upstream complex, but already claimed by that other company's account: auto-link
    // does not override the one-account-per-complex rule, and creation still succeeds, unlinked.
    await seed(`auto-taken-me-${ts}`);
    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("PATCH: a COMPANY_ADMIN cannot set the link on an unlinked account", async () => {
    const { c, u, team } = await seed(`patch-set-${ts}`);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Unlinked"), name: "Unlinked", accountManagerId: u.id },
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
    const { c, u, team } = await seed(`patch-repoint-${ts}`, "MEMBER");
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Linked"), name: "Linked", accountManagerId: u.id, externalPartnerKey: "Komplex B" },
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
    const { c, u, team } = await seed(`patch-clear-${ts}`);
    const acc = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Linked"), name: "Linked", accountManagerId: u.id, externalPartnerKey: "Komplex B" },
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
