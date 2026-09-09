import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SessionUser } from "@/lib/auth/guards";
import { InvalidApiKeyError, UnknownPartnerError, PartnerApiUnavailableError } from "@/lib/partner-api/errors";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// This route is GLOBAL (not per-account) — no account row to look up, so unlike the
// accounts/[id]/objects route test there is no need for testPrisma. Just mock the session and
// the external client.
let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { GET } from "./route";

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

describe("GET /api/partners — global live partner picker list", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(() => {
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

  it("returns the partner list for a signed-in admin", async () => {
    mockUser = ADMIN;
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

  it("also allows a MEMBER (same gating as creating/editing accounts)", async () => {
    mockUser = MEMBER;
    vi.mocked(fetchPartners).mockResolvedValue(rawList());

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("401s when there is no signed-in user", async () => {
    mockUser = null;

    const res = await GET();
    expect(res.status).toBe(401);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("403s for a role that isn't admin/member (e.g. PARTNER_VIEWER)", async () => {
    mockUser = PARTNER_VIEWER;

    const res = await GET();
    expect(res.status).toBe(403);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("reports not_configured without calling the API when PARTNER_API_KEY is unset", async () => {
    mockUser = ADMIN;
    delete process.env.PARTNER_API_KEY;

    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("not_configured");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("reports not_configured when PARTNER_API_KEY is an empty string", async () => {
    mockUser = ADMIN;
    process.env.PARTNER_API_KEY = "";

    const res = await GET();
    expect((await res.json()).status).toBe("not_configured");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("maps InvalidApiKeyError -> invalid_api_key (502)", async () => {
    mockUser = ADMIN;
    vi.mocked(fetchPartners).mockRejectedValue(new InvalidApiKeyError());

    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).status).toBe("invalid_api_key");
  });

  it("maps UnknownPartnerError -> partner_api_unavailable (503) — no partner param on this endpoint", async () => {
    mockUser = ADMIN;
    vi.mocked(fetchPartners).mockRejectedValue(new UnknownPartnerError());

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });

  it("maps PartnerApiUnavailableError -> partner_api_unavailable (503)", async () => {
    mockUser = ADMIN;
    vi.mocked(fetchPartners).mockRejectedValue(new PartnerApiUnavailableError());

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });

  it("maps an unexpected error (e.g. zod validation) -> partner_api_unavailable (503), never a raw 500", async () => {
    mockUser = ADMIN;
    vi.mocked(fetchPartners).mockRejectedValue(new Error("unexpected shape"));

    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).status).toBe("partner_api_unavailable");
  });
});
