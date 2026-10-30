import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
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
    data: { companyId: c.id, teamId: team.id, buildingKey: buildingKey("Partner"), name: "Partner", accountManagerId: u.id, externalPartnerKey: "acme" },
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
});
