import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";
import { InvalidApiKeyError } from "@/lib/partner-api/errors";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { PATCH } from "./route";

// A real SUPER_ADMIN row (created in beforeEach, after resetDb) so the audit row can resolve the actor email.
let SUPER: SessionUser;

function patchReq(id: string, body: unknown) {
  return new NextRequest(`http://localhost/api/platform/accounts/${id}/partner`, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function call(id: string, body: unknown) {
  return PATCH(patchReq(id, body), { params: Promise.resolve({ id }) });
}

function liveList(): PartnerListResponse {
  return {
    partners: [
      { name: "Komplex B", type: "RESIDENTIAL" },
      { name: "Sabah.City", type: "COMMERCIAL" },
    ],
  };
}

async function seedCompanyWithAccount(slug: string, opts?: { partnerKey?: string; role?: "COMPANY_ADMIN" | "MEMBER" }) {
  const team = await makeTeam({ name: slug });
  const c = await testPrisma.company.update({ where: { id: team.companyId }, data: { name: `Co ${slug}` } });
  const u = await makeUser(opts?.role ?? "COMPANY_ADMIN", team);
  const acc = await testPrisma.account.create({
    data: {
      companyId: c.id, teamId: team.id, buildingKey: buildingKey(`Acct ${slug}`),
      name: `Acct ${slug}`, accountManagerId: u.id,
      externalPartnerKey: opts?.partnerKey ?? null,
    },
  });
  return { c, u, team, acc };
}

describe("PATCH /api/platform/accounts/[id]/partner — SUPER_ADMIN-only partner assignment", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;
  let ts = "";

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "sk_live_global";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    SUPER = su(await makeUser("SUPER_ADMIN"));
    mockUser = SUPER;
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

  it("a SUPER_ADMIN sets the link on an account in ANY company (no tenant scoping)", async () => {
    // The actor has companyId: null, and the account belongs to some other company entirely —
    // the whole point of this route existing alongside the tenant-scoped one.
    const { acc } = await seedCompanyWithAccount(`assign-${ts}`);

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(200);
    expect((await res.json()).externalPartnerKey).toBe("Komplex B");

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });

  it("clears the link back to null", async () => {
    const { acc } = await seedCompanyWithAccount(`clear-${ts}`, { partnerKey: "Komplex B" });

    const res = await call(acc.id, { externalPartnerKey: null });
    expect(res.status).toBe(200);
    expect((await res.json()).externalPartnerKey).toBeNull();

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
    // Clearing must not need the upstream list — unlinking can't expose anything.
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("403s a COMPANY_ADMIN and leaves the row untouched", async () => {
    const { u, acc } = await seedCompanyWithAccount(`forbid-${ts}`);
    mockUser = su(u);

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(403);
    expect(fetchPartners).not.toHaveBeenCalled();
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  // The role check used to run AFTER Body.parse, so a non-super-admin with a malformed body got
  // 400 — a reply only a real, reachable route produces. 403 is the only answer they may get,
  // whatever they send.
  it("403s a non-super-admin BEFORE parsing the body — a bad body must not turn 403 into 400", async () => {
    const { u, acc } = await seedCompanyWithAccount(`forbid-order-${ts}`);
    mockUser = su(u);

    for (const body of [{}, { externalPartnerKey: 42 }, { nonsense: true }]) {
      const res = await call(acc.id, body);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
    }
    expect(fetchPartners).not.toHaveBeenCalled();
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("403s a MEMBER even when clearing", async () => {
    const { u, acc } = await seedCompanyWithAccount(`forbid-member-${ts}`, { partnerKey: "Komplex B", role: "MEMBER" });
    mockUser = su(u);

    const res = await call(acc.id, { externalPartnerKey: null });
    expect(res.status).toBe(403);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });

  it("401s when there is no signed-in user", async () => {
    const { acc } = await seedCompanyWithAccount(`anon-${ts}`);
    mockUser = null;

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(401);
  });

  // CHANGED ON PURPOSE (teams refactor): the error code is now "partner_name_held", not
  // "partner_already_claimed". setAccountPartner runs the building-claim check (findNameHolder)
  // BEFORE the global-link check (isPartnerKeyTaken), and an account holding the link is itself a
  // holder of the building (its externalPartnerKey normalizes to the same key), so the earlier,
  // richer 409 always wins and names the holding record. Still 409, still nothing persisted.
  it("409s a partner already held by another account — even in a different company", async () => {
    const holder = await seedCompanyWithAccount(`holder-${ts}`, { partnerKey: "Komplex B" });
    const { acc } = await seedCompanyWithAccount(`taker-${ts}`);

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("partner_name_held");
    expect(body.holder).toEqual({ kind: "account", id: holder.acc.id });
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("re-saving an account's OWN current partner is allowed, not a self-clash", async () => {
    const { acc } = await seedCompanyWithAccount(`self-${ts}`, { partnerKey: "Komplex B" });

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(200);
    expect((await res.json()).externalPartnerKey).toBe("Komplex B");
  });

  it("400s a name that isn't in the live list", async () => {
    const { acc } = await seedCompanyWithAccount(`unknown-${ts}`);

    const res = await call(acc.id, { externalPartnerKey: "Not A Real Partner" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_partner");
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("400s a near-miss — validation is an EXACT name match, the string the fan-outs send", async () => {
    const { acc } = await seedCompanyWithAccount(`case-${ts}`);

    const res = await call(acc.id, { externalPartnerKey: "komplex b" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_partner");
  });

  it("503s rather than persisting an unverified name when the live list can't be fetched", async () => {
    const { acc } = await seedCompanyWithAccount(`down-${ts}`);
    vi.mocked(fetchPartners).mockRejectedValue(new InvalidApiKeyError());

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("partner_api_unavailable");
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("503s when PARTNER_API_KEY is unset — fail closed, never assume the name is fine", async () => {
    const { acc } = await seedCompanyWithAccount(`nokey-${ts}`);
    delete process.env.PARTNER_API_KEY;

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(503);
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("404s an unknown account id", async () => {
    const res = await call("does-not-exist", { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(404);
  });

  // REPLACES the three PartnerAllowlist tests (409 partner_allowlist_mismatch / allowed for the
  // granting company / allowed when ungranted): the allowlist is dropped and the SUPER_ADMIN is
  // the sole authority, constrained only by the building claim below.
  it("409s a name whose BUILDING another lead is working, naming the lead as holder", async () => {
    const rival = await seedCompanyWithAccount(`lead-holder-${ts}`);
    const stage = await testPrisma.stage.create({
      data: { companyId: rival.c.id, teamId: rival.team.id, name: "New", order: 0 },
    });
    const lead = await testPrisma.lead.create({
      data: {
        companyId: rival.c.id, teamId: rival.team.id, buildingKey: buildingKey("Komplex B"),
        title: "t", contactName: "c", companyName: "Komplex B", stageId: stage.id, ownerId: rival.u.id,
      },
    });
    const { acc } = await seedCompanyWithAccount(`lead-taker-${ts}`);

    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("partner_name_held");
    expect(body.holder).toEqual({ kind: "lead", id: lead.id });
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
    expect(await testPrisma.partnerLinkAudit.count()).toBe(0);
  });

  it("allows a live complex nothing else claims — a SUPER_ADMIN remains the authority", async () => {
    const { acc } = await seedCompanyWithAccount(`grant-none-${ts}`);
    const res = await call(acc.id, { externalPartnerKey: "Komplex B" });
    expect(res.status).toBe(200);
  });

  // CHANGED ON PURPOSE: the trail is in PartnerLinkAudit now (durable, survives the account), not
  // AccountActivity rows with a "partner_link:*" outcome.
  it("writes a PartnerLinkAudit row on assign AND on clear, attributed to the acting super admin", async () => {
    const { c, acc } = await seedCompanyWithAccount(`audit-${ts}`);

    expect((await call(acc.id, { externalPartnerKey: "Komplex B" })).status).toBe(200);
    expect((await call(acc.id, { externalPartnerKey: null })).status).toBe(200);

    const audit = await testPrisma.partnerLinkAudit.findMany({
      where: { accountId: acc.id }, orderBy: { createdAt: "asc" },
    });
    expect(audit.map((a) => a.action)).toEqual(["assign", "clear"]);
    // BOTH rows name the complex. The clear row especially: the column is null afterwards, so for
    // a link with no prior assign row it is the only surviving record of what was unlinked.
    expect(audit.every((a) => a.partnerName === "Komplex B")).toBe(true);
    expect(audit.every((a) => a.actorId === SUPER.id)).toBe(true);
    // Filed under the ACCOUNT's company, not the (company-less) super admin's.
    expect(audit.every((a) => a.companyId === c.id)).toBe(true);
    // Nothing is written to the tenant-visible timeline any more.
    expect(await testPrisma.accountActivity.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("does not write a clear audit row when there was nothing linked", async () => {
    const { acc } = await seedCompanyWithAccount(`audit-noop-${ts}`);
    expect((await call(acc.id, { externalPartnerKey: null })).status).toBe(200);
    expect(await testPrisma.partnerLinkAudit.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("400s a body that omits externalPartnerKey — clearing must be stated explicitly", async () => {
    const { acc } = await seedCompanyWithAccount(`badbody-${ts}`, { partnerKey: "Komplex B" });

    const res = await call(acc.id, {});
    expect(res.status).toBe(400);
    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
  });
});
