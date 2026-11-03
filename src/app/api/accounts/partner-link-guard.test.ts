import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// The partner namespace is GLOBAL (one shared PARTNER_API_KEY; `?partner=<name>` is the only
// discriminator), so a tenant that could name a partner could read another tenant's debt,
// payments and unit-level owner names/phones. These tests pin the boundary: the company-facing
// account routes must IGNORE `externalPartnerKey` in the request body no matter who sends it.
//
// WHAT CHANGED (security review finding F1): there is no auto-link any more. Creating an account
// stakes a PENDING link derived from the account's OWN NAME — never from the body — and that
// pending link grants nothing until an admin confirms it — and never the person who proposed it.
// So the question these tests pin
// is sharper than before: whatever key a caller sends, the key that lands in the row is the
// normalized form of the name they were entitled to type, and it is never live.
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
    // The pending stake comes from the NAME, so the row holds the normalized own name and NOT
    // the complex the caller tried to name.
    expect(row?.externalPartnerKey).toBe("totally unrelated name");
    expect(row?.partnerLinkConfirmedAt).toBeNull();
  });

  it("POST: a MEMBER's externalPartnerKey is not persisted either", async () => {
    await seed(`post-member-${ts}`, "MEMBER");

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Another Unrelated Name",
      externalPartnerKey: "Sabah.City",
    }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBe("another unrelated name");
    expect(row?.partnerLinkConfirmedAt).toBeNull();
  });

  it("POST: a body key cannot steal a partner already claimed by ANOTHER company", async () => {
    const holder = await seedForeignHolder("other", "Komplex B", "Holder");

    await seed(`thief-${ts}`);
    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", {
      name: "Thief Co", externalPartnerKey: "Komplex B",
    }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    // Staked off its own name, nowhere near the complex it asked for.
    expect(row?.externalPartnerKey).toBe("thief co");
    // and the rightful holder is untouched
    const holderRow = await testPrisma.account.findUnique({ where: { id: holder.id } });
    expect(holderRow?.externalPartnerKey).toBe("Komplex B");
  });

  it("POST: naming a building stakes a PENDING link and never calls the upstream", async () => {
    await seed(`autolink-${ts}`);

    const res = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "Komplex B" }));
    expect(res.status).toBe(201);
    const row = await testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    expect(row?.externalPartnerKey).toBe("komplex b");
    expect(row?.partnerLinkConfirmedAt).toBeNull();
    // The create path used to resolve this name against the live list, which made an ordinary
    // write both an upstream fan-out and a yes/no oracle for "does complex X exist".
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  // CHANGED TWICE, and the second change is the point. The teams refactor made this "a name that
  // matches a real complex DOES link, a made-up one does not" — which is precisely the oracle and
  // the entitlement hole finding F1 identified. Now the upstream is not consulted at all, so the
  // two cases are INDISTINGUISHABLE: both stake a pending claim on their own normalized name, and
  // neither grants anything. Whether the complex is real is answered at confirm time, by the owner.
  it("POST: a real complex and a made-up one are indistinguishable at creation", async () => {
    await seed(`autolink-live-${ts}`);

    const real = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "  komplex b " }));
    const fake = await POST(jsonReq("http://localhost/api/accounts", "POST", { name: "No Such Complex At All" }));
    expect(real.status).toBe(201);
    expect(fake.status).toBe(201);

    const rowOf = async (res: Response) =>
      testPrisma.account.findUnique({ where: { id: (await res.json()).account.id } });
    const realRow = await rowOf(real);
    const fakeRow = await rowOf(fake);
    // Same shape of outcome for both: own normalized name, unconfirmed.
    expect(realRow?.externalPartnerKey).toBe("komplex b");
    expect(fakeRow?.externalPartnerKey).toBe("no such complex at all");
    expect(realRow?.partnerLinkConfirmedAt).toBeNull();
    expect(fakeRow?.partnerLinkConfirmedAt).toBeNull();
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("POST: the pending stake still refuses a name already claimed elsewhere", async () => {
    await seedForeignHolder("auto-taken", "Komplex B", "Komplex B");

    // Already claimed by that other company's account: staking does not override the
    // one-account-per-complex rule, and creation still succeeds with no link at all.
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

  it("PATCH: a MEMBER cannot re-point an already-CONFIRMED account at another partner", async () => {
    const { c, u, team } = await seed(`patch-repoint-${ts}`, "MEMBER");
    // CONFIRMED, which is what "already linked" means: live data flows through this key. A rename
    // must never re-point it — that is the long-standing rule, and the only writer of a live link
    // is the SUPER_ADMIN's setAccountPartner.
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Linked"), name: "Linked",
        accountManagerId: u.id, externalPartnerKey: "Komplex B", partnerLinkConfirmedAt: new Date(),
      },
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
    expect(row?.externalPartnerKey).toBe("Komplex B"); // the live link does not
    expect(row?.partnerLinkConfirmedAt).not.toBeNull();
  });

  // A PENDING link DOES follow a rename — the pending key is derived from the name, so a typo
  // would otherwise strand an unconfirmable proposal. What must not follow is the body: the new
  // key is the new NAME, never the complex the caller asked for, and it is still unconfirmed.
  it("PATCH: renaming re-stakes a PENDING link from the NAME, never from the body", async () => {
    const { c, u, team } = await seed(`patch-pending-${ts}`, "MEMBER");
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Guesss"), name: "Guesss",
        accountManagerId: u.id, externalPartnerKey: "guesss",
      },
    });

    const res = await PATCH(
      jsonReq(`http://localhost/api/accounts/${acc.id}`, "PATCH", {
        name: "Komplex B", externalPartnerKey: "Sabah.City",
      }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(200);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("komplex b");
    expect(row?.partnerLinkConfirmedAt).toBeNull();
    // The renamer becomes the proposer, so they cannot confirm it themselves.
    expect(row?.partnerLinkProposedById).toBe(u.id);
  });

  it("PATCH: a COMPANY_ADMIN cannot CLEAR the link either", async () => {
    const { c, u, team } = await seed(`patch-clear-${ts}`);
    const acc = await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: team.id, buildingKey: buildingKey("Linked"), name: "Linked",
        accountManagerId: u.id, externalPartnerKey: "Komplex B", partnerLinkConfirmedAt: new Date(),
      },
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
