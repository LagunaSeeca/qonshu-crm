import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// This route is GLOBAL (not per-account) so there is no account row to look up — but it DOES
// hit the DB now, to hide partners already claimed by an account anywhere on the platform.
// So: real testPrisma in place of the `@/db/client` singleton, plus a mocked session and a
// mocked external client.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { GET } from "./route";

// SUPER_ADMIN is the ONLY role allowed here: the partner namespace is shared across every
// tenant, so this list names other companies' complexes and linking to one exposes that
// partner's debt/payments/unit owners.
const SUPER: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };
const ADMIN: SessionUser = { id: "u1", companyId: "co1", role: "COMPANY_ADMIN" };
const MEMBER: SessionUser = { id: "u2", companyId: "co1", role: "MEMBER" };
const PARTNER_VIEWER: SessionUser = { id: "u3", companyId: "co1", role: "PARTNER_VIEWER", accountId: "acc1" };

function rawList(): PartnerListResponse {
  return {
    partners: [
      { name: "Komplex B", type: "RESIDENTIAL" },
      { name: "Sabah.City", type: "COMMERCIAL" },
    ],
  };
}

// Seeds an account (in its own company) already holding `partnerKey`.
async function seedClaim(partnerKey: string, slug: string) {
  const c = await testPrisma.company.create({ data: { name: "Co", slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
  });
  return testPrisma.account.create({
    data: { companyId: c.id, name: "Claimer", accountManagerId: u.id, externalPartnerKey: partnerKey },
  });
}

describe("GET /api/partners — SUPER_ADMIN-only list of UNCLAIMED partners", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "sk_live_global";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    mockUser = null;
    vi.mocked(fetchPartners).mockReset();
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
  });
  afterAll(() => testPrisma.$disconnect());

  it("returns the partner list for a SUPER_ADMIN", async () => {
    mockUser = SUPER;
    vi.mocked(fetchPartners).mockResolvedValue(rawList());

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.partners).toEqual([
      { name: "Komplex B", type: "RESIDENTIAL" },
      { name: "Sabah.City", type: "COMMERCIAL" },
    ]);
    expect(fetchPartners).toHaveBeenCalledWith({
      baseUrl: "https://partner.example.com",
      apiKey: "sk_live_global",
    });
    // the key must never leak into the response body
    expect(JSON.stringify(body)).not.toContain("sk_live_global");
  });

  it("403s a COMPANY_ADMIN — the namespace is global, so this list is other tenants' data", async () => {
    mockUser = ADMIN;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("403s a MEMBER", async () => {
    mockUser = MEMBER;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("403s a PARTNER_VIEWER", async () => {
    mockUser = PARTNER_VIEWER;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("401s when there is no signed-in user", async () => {
    mockUser = null;

    const res = await GET();
    expect(res.status).toBe(401);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("excludes a partner already claimed by an account", async () => {
    mockUser = SUPER;
    await seedClaim("Komplex B", `claimed-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vi.mocked(fetchPartners).mockResolvedValue(rawList());

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.partners).toEqual([{ name: "Sabah.City", type: "COMMERCIAL" }]);
  });

  it("excludes a claim held by ANOTHER company — the partner namespace is not tenant-scoped", async () => {
    mockUser = SUPER;
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedClaim("Komplex B", `other-a-${ts}`);
    await seedClaim("Sabah.City", `other-b-${ts}`);
    vi.mocked(fetchPartners).mockResolvedValue(rawList());

    const res = await GET();
    const body = await res.json();
    expect(body.partners).toEqual([]);
  });

  it("keeps partners whose name merely resembles a claim (exact match only)", async () => {
    mockUser = SUPER;
    await seedClaim("komplex b", `case-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    vi.mocked(fetchPartners).mockResolvedValue(rawList());

    const res = await GET();
    const body = await res.json();
    expect(body.partners.map((p: { name: string }) => p.name)).toEqual(["Komplex B", "Sabah.City"]);
  });

  it("reports not_configured without calling the API when PARTNER_API_KEY is unset", async () => {
    mockUser = SUPER;
    delete process.env.PARTNER_API_KEY;

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_configured");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("reports not_configured when PARTNER_API_KEY is an empty string", async () => {
    mockUser = SUPER;
    process.env.PARTNER_API_KEY = "";

    const res = await GET();
    expect((await res.json()).status).toBe("not_configured");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("maps InvalidApiKeyError -> invalid_api_key (502)", async () => {
    mockUser = SUPER;
    vi.mocked(fetchPartners).mockRejectedValue(new InvalidApiKeyError());

    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).status).toBe("invalid_api_key");
  });

  it("maps UnknownPartnerError -> partner_api_unavailable (503) — no partner param on this endpoint", async () => {
    mockUser = SUPER;
    vi.mocked(fetchPartners).mockRejectedValue(new UnknownPartnerError());

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });

  it("maps PartnerApiUnavailableError -> partner_api_unavailable (503)", async () => {
    mockUser = SUPER;
    vi.mocked(fetchPartners).mockRejectedValue(new PartnerApiUnavailableError());

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });

  it("maps an unexpected error (e.g. zod validation) -> partner_api_unavailable (503), never a raw 500", async () => {
    mockUser = SUPER;
    vi.mocked(fetchPartners).mockRejectedValue(new Error("unexpected shape"));

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });
});
