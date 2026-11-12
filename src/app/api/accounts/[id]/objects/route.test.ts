import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerObjectsResponse } from "@/lib/partner-api/schema";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

// LIVE, read-only structure endpoint — mock the external client so normalization is exercised
// against a controlled response, never a real network call.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartnerObjects: vi.fn() }));

import { fetchPartnerObjects } from "@/lib/partner-api/client";
import { GET } from "./route";

const KEY_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHARED_API_KEY = "sk_live_objects";

function rawObjects(): PartnerObjectsResponse {
  return {
    partner: "acme",
    complex_type: "RESIDENTIAL",
    buildings: [
      {
        id: 1,
        name: "Building A",
        blocks: [
          {
            id: 10,
            name: "Block 1",
            apartments: [
              // owned unit — net must be recomputed as balance - debt (10 - 50 = -40), never
              // trust the upstream `net` (deliberately wrong here at -999).
              { id: 100, owner_id: 5, owner_name: "Jane", owner_mobile: "+100", debt: 50, balance: 10, net: -999, apartment_number: "12B" },
            ],
          },
        ],
        // vacant parking: owner_* all null, must pass straight through as null (not coerced to 0/"").
        parkings: [
          { id: 200, owner_id: null, owner_name: null, owner_mobile: null, debt: 0, balance: 0, net: 0, parking_number: "P-7" },
        ],
        properties: [
          { id: 300, owner_id: 9, owner_name: "Acme LLC", owner_mobile: null, debt: 5, balance: 0, net: -5, property_number: "R-1", type: "SHOP" },
        ],
        offices: [
          { id: 400, owner_id: 9, owner_name: "Acme LLC", owner_mobile: "+200", debt: 0, balance: 100, net: 100, office_number: "O-2" },
        ],
      },
    ],
  };
}

// "Configured" now means only a partner NAME — the account goes live off the shared
// PARTNER_API_KEY env var (set in beforeEach below); there is no per-account key entry anymore.
async function seedConfiguredAccount(slug: string) {
  const team = await makeTeam({ name: slug });
  const c = { id: team.companyId };
  const u = await makeUser("COMPANY_ADMIN", team);
  const acc = await testPrisma.account.create({
    data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Partner"), name: "Partner", accountManagerId: u.id, ...confirmedPartnerLink("acme") },
  });
  const user: SessionUser = su(u);
  return { c, u, acc, user };
}

describe("GET /api/accounts/[id]/objects — live normalization", () => {
  let savedSecret: string | undefined;
  let savedBaseUrl: string | undefined;
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedSecret = process.env.PARTNER_API_KEY_SECRET;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY_SECRET = KEY_SECRET;
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    process.env.PARTNER_API_KEY = SHARED_API_KEY;
    mockUser = null;
    vi.mocked(fetchPartnerObjects).mockReset();
  });
  afterEach(() => {
    if (savedSecret === undefined) delete process.env.PARTNER_API_KEY_SECRET; else process.env.PARTNER_API_KEY_SECRET = savedSecret;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
  });
  afterAll(() => testPrisma.$disconnect());

  it("produces the nested buildings▸blocks▸apartments tree plus flat parkings/properties/offices, recomputing net", async () => {
    const { acc, user } = await seedConfiguredAccount("obj-normalize");
    mockUser = user;
    vi.mocked(fetchPartnerObjects).mockResolvedValue(rawObjects());

    const res = await GET(new NextRequest(`http://localhost/api/accounts/${acc.id}/objects`), { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.status).toBe("ok");
    expect(body.partner).toBe("acme");
    expect(body.complexType).toBe("RESIDENTIAL");
    expect(body.buildings).toHaveLength(1);

    const building = body.buildings[0];
    expect(building.id).toBe(1);
    expect(building.name).toBe("Building A");

    // nested: blocks -> apartments
    expect(building.blocks).toHaveLength(1);
    const apt = building.blocks[0].apartments[0];
    expect(apt.number).toBe("12B");
    expect(apt.ownerId).toBe(5);
    expect(apt.ownerName).toBe("Jane");
    expect(apt.debt).toBe(50);
    expect(apt.balance).toBe(10);
    // net is recomputed (balance - debt), never the upstream value
    expect(apt.net).toBe(10 - 50);
    expect(apt.net).not.toBe(-999);

    // flat, directly on the building (not nested under blocks)
    expect(building.parkings).toHaveLength(1);
    expect(building.properties).toHaveLength(1);
    expect(building.offices).toHaveLength(1);

    // vacant unit: null owner fields pass straight through
    const parking = building.parkings[0];
    expect(parking.number).toBe("P-7");
    expect(parking.ownerId).toBeNull();
    expect(parking.ownerName).toBeNull();
    expect(parking.ownerMobile).toBeNull();
    expect(parking.net).toBe(0 - 0);

    // property carries the extra `type` field
    const property = building.properties[0];
    expect(property.number).toBe("R-1");
    expect(property.type).toBe("SHOP");
    expect(property.net).toBe(0 - 5); // -5, recomputed

    const office = building.offices[0];
    expect(office.number).toBe("O-2");
    expect(office.net).toBe(100 - 0);

    expect(fetchPartnerObjects).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://partner.example.com", partner: "acme", apiKey: "sk_live_objects" }),
    );
  });

  it("reports not_configured without calling the API when the account has no partner key/API key", async () => {
    const team = await makeTeam();
    const c = { id: team.companyId };
    const u = await makeUser("COMPANY_ADMIN", team);
    const acc = await testPrisma.account.create({ data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Unlinked"), name: "Unlinked", accountManagerId: u.id } });
    mockUser = su(u);

    const res = await GET(new NextRequest(`http://localhost/api/accounts/${acc.id}/objects`), { params: Promise.resolve({ id: acc.id }) });
    const body = await res.json();
    expect(body.status).toBe("not_configured");
    expect(fetchPartnerObjects).not.toHaveBeenCalled();
  });

  it("maps InvalidApiKeyError -> invalid_api_key (502)", async () => {
    const { acc, user } = await seedConfiguredAccount("obj-badkey");
    mockUser = user;
    vi.mocked(fetchPartnerObjects).mockRejectedValue(new InvalidApiKeyError());
    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(502);
    expect((await res.json()).status).toBe("invalid_api_key");
  });

  it("maps UnknownPartnerError -> unknown_partner (502)", async () => {
    const { acc, user } = await seedConfiguredAccount("obj-unknown");
    mockUser = user;
    vi.mocked(fetchPartnerObjects).mockRejectedValue(new UnknownPartnerError());
    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(502);
    expect((await res.json()).status).toBe("unknown_partner");
  });

  it("maps PartnerApiUnavailableError -> partner_api_unavailable (503)", async () => {
    const { acc, user } = await seedConfiguredAccount("obj-down");
    mockUser = user;
    vi.mocked(fetchPartnerObjects).mockRejectedValue(new PartnerApiUnavailableError());
    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });

  it("404s for a foreign (cross-tenant) account without calling the API", async () => {
    const { acc: foreignAcc } = await seedConfiguredAccount("obj-x1");
    const u = await makeUser("COMPANY_ADMIN", await makeTeam());
    mockUser = su(u);

    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: foreignAcc.id }) });
    expect(res.status).toBe(404);
    expect(fetchPartnerObjects).not.toHaveBeenCalled();
  });

  // ---- role gate: enforced in the service (getAccountObjects), shared with server components ----

  function twoBuildings(): PartnerObjectsResponse {
    const raw = rawObjects();
    raw.buildings.push({
      id: 2,
      name: "Building B",
      blocks: [
        { id: 20, name: "Block 2", apartments: [
          { id: 101, owner_id: 6, owner_name: "Secret Owner", owner_mobile: "+777", debt: 1, balance: 2, net: 1, apartment_number: "1" },
          { id: 102, owner_id: null, owner_name: null, owner_mobile: null, debt: 0, balance: 0, net: 0, apartment_number: "2" },
        ] },
      ],
      parkings: [
        { id: 201, owner_id: null, owner_name: null, owner_mobile: null, debt: 0, balance: 0, net: 0, parking_number: "P-1" },
        { id: 202, owner_id: null, owner_name: null, owner_mobile: null, debt: 0, balance: 0, net: 0, parking_number: "P-2" },
      ],
      properties: [],
      offices: [],
    });
    return raw;
  }

  async function seedMemberAccount() {
    const team = await makeTeam();
    const member = await makeUser("MEMBER", team);
    const acc = await testPrisma.account.create({
      data: { companyId: team.companyId, teamId: team.id, buildingKey: buildingKey("Mine"), name: "Mine", accountManagerId: member.id, ...confirmedPartnerLink("acme") },
    });
    return { team, member, acc };
  }

  it("a MEMBER receives totals only: no buildings key, no unit, owner or money detail anywhere in the payload", async () => {
    const { member, acc } = await seedMemberAccount();
    mockUser = su(member);
    vi.mocked(fetchPartnerObjects).mockResolvedValue(twoBuildings());

    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) });
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);

    expect(body).toEqual({
      status: "ok",
      detail: "summary",
      partner: "acme",
      complexType: "RESIDENTIAL",
      totals: { buildings: 2, blocks: 2, apartments: 3, parkings: 3, properties: 1, offices: 1 },
    });
    expect(body).not.toHaveProperty("buildings");
    // serialized-payload check: nothing identifying a unit or its owner may appear at all
    for (const leak of ["Building A", "Building B", "Block 1", "12B", "P-7", "Jane", "Secret Owner", "+777", "Acme LLC", "ownerName", "debt", "balance"]) {
      expect(text).not.toContain(leak);
    }
  });

  it("the service itself (not just the route) strips detail for a MEMBER and keeps it for COMPANY_ADMIN", async () => {
    const { getAccountObjects } = await import("@/lib/tenant/account-objects");
    const { member, acc } = await seedMemberAccount();
    vi.mocked(fetchPartnerObjects).mockResolvedValue(twoBuildings());

    const asMember = await getAccountObjects(su(member), acc.id);
    expect(asMember.status).toBe("ok");
    expect(JSON.stringify(asMember)).not.toContain("Secret Owner");
    expect(asMember).not.toHaveProperty("buildings");

    const adminUser = await makeUser("COMPANY_ADMIN", { id: member.teamId!, companyId: member.companyId! } as never);
    const asAdmin = await getAccountObjects(su(adminUser), acc.id);
    expect(asAdmin).toMatchObject({ status: "ok", detail: "full" });
    expect((asAdmin as { buildings: unknown[] }).buildings).toHaveLength(2);
  });

  it("COMPANY_ADMIN gets full detail plus the same totals", async () => {
    const { acc, user } = await seedConfiguredAccount("obj-admin-full");
    mockUser = user;
    vi.mocked(fetchPartnerObjects).mockResolvedValue(twoBuildings());

    const body = await (await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) })).json();
    expect(body.detail).toBe("full");
    expect(body.buildings).toHaveLength(2);
    expect(body.totals).toEqual({ buildings: 2, blocks: 2, apartments: 3, parkings: 3, properties: 1, offices: 1 });
  });

  it("PARTNER_VIEWER gets full detail for its own account and 404 for any other", async () => {
    const { c, acc } = await seedConfiguredAccount("obj-pv");
    const team = await testPrisma.team.findFirstOrThrow({ where: { companyId: c.id } });
    const pv = await makeUser("PARTNER_VIEWER", team, { accountId: acc.id });
    const other = await testPrisma.account.create({
      data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Other"), name: "Other", accountManagerId: (await makeUser("COMPANY_ADMIN", team)).id, ...confirmedPartnerLink("beta") },
    });
    vi.mocked(fetchPartnerObjects).mockResolvedValue(twoBuildings());
    mockUser = su(pv);

    const own = await (await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: acc.id }) })).json();
    expect(own.detail).toBe("full");
    expect(own.buildings).toHaveLength(2);

    vi.mocked(fetchPartnerObjects).mockClear();
    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: other.id }) });
    expect(res.status).toBe(404);
    expect(fetchPartnerObjects).not.toHaveBeenCalled();
  });

  it("a MEMBER gets 404, and no upstream call, for an account they do not manage (totals never cover other books)", async () => {
    const { team, member } = await seedMemberAccount();
    const admin = await makeUser("COMPANY_ADMIN", team);
    const notMine = await testPrisma.account.create({
      data: { companyId: team.companyId, teamId: team.id, buildingKey: buildingKey("NotMine"), name: "NotMine", accountManagerId: admin.id, ...confirmedPartnerLink("beta") },
    });
    mockUser = su(member);
    const res = await GET(new NextRequest(`http://localhost/x`), { params: Promise.resolve({ id: notMine.id }) });
    expect(res.status).toBe(404);
    expect(fetchPartnerObjects).not.toHaveBeenCalled();
  });
});
