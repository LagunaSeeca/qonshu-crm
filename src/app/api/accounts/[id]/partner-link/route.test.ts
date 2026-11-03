import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeamWithUsers, makeUser, su, confirmedPartnerLink } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// POST /api/accounts/[id]/partner-link — the decision on a pending partner link.
//
// The rules themselves are pinned in src/lib/tenant/partner-link-approval.test.ts; what this file
// checks is the WIRE CONTRACT, because the status code is what the UI branches on and a wrong one
// here is a security story of its own: a cross-team confirm answering 403 instead of 404 confirms
// that the account id exists.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({ getSessionUser: async () => mockUser }));

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { createAccount } from "@/lib/tenant/accounts";
import { POST } from "./route";

function list(...names: string[]): PartnerListResponse {
  return { partners: names.map((name) => ({ name, type: "RESIDENTIAL" as const })) };
}

function req(id: string, action: unknown) {
  return new NextRequest(`http://localhost/api/accounts/${id}/partner-link`, {
    method: "POST",
    body: JSON.stringify({ action }),
    headers: { "Content-Type": "application/json" },
  });
}

const call = (id: string, action: unknown) => POST(req(id, action), { params: Promise.resolve({ id }) });

let savedApiKey: string | undefined;

describe("POST /api/accounts/[id]/partner-link", () => {
  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = "sk_live_decide";
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue(list("Komplex B"));
    mockUser = null;
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("a team admin confirms their own team's pending link: 200 and the upstream spelling", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = t.suAdmin;

    const res = await call(acc.id, "confirm");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.externalPartnerKey).toBe("Komplex B");
    expect(body.partnerLinkConfirmedAt).not.toBeNull();
  });

  // 404, NOT 403: a 403 would tell the caller the id names a real account in another team.
  it("another team's pending link is 404 not_found", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.companyId });
    const acc = await createAccount(testPrisma, theirs.suMember, { name: "Komplex B" });
    mockUser = mine.suAdmin;

    const res = await call(acc.id, "confirm");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    // ...and nothing was granted.
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkConfirmedAt)
      .toBeNull();
  });

  it("a MEMBER is 403 forbidden, even on their own proposal", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = t.suMember;

    expect((await call(acc.id, "confirm")).status).toBe(403);
    expect((await call(acc.id, "reject")).status).toBe(403);
  });

  it("the proposer is 403 self_approval, with its own code so the UI can explain", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suAdmin, {
      name: "Komplex B", accountManagerId: t.admin.id,
    });
    mockUser = t.suAdmin;

    const res = await call(acc.id, "confirm");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("self_approval");
    // The upstream was never consulted, so the refusal says nothing about the complex.
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is 401", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = null;

    expect((await call(acc.id, "confirm")).status).toBe(401);
  });

  it("a PARTNER_VIEWER pinned to the account is 403", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = su(await makeUser("PARTNER_VIEWER", t.team, { accountId: acc.id }));

    expect((await call(acc.id, "confirm")).status).toBe(403);
  });

  // No default verb: a malformed body must never be read as either decision, least of all the
  // granting one.
  it("rejects a missing or bogus action with 400 and changes nothing", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = t.suAdmin;

    expect((await call(acc.id, undefined)).status).toBe(400);
    expect((await call(acc.id, "approve")).status).toBe(400);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkConfirmedAt)
      .toBeNull();
  });

  it("an account with nothing pending is 409 no_pending_link", async () => {
    const t = await makeTeamWithUsers();
    const acc = await testPrisma.account.create({ data: {
      companyId: t.companyId, teamId: t.team.id, name: "Live", buildingKey: "live",
      accountManagerId: t.member.id, ...confirmedPartnerLink("Komplex B"),
    } });
    mockUser = t.suAdmin;

    const res = await call(acc.id, "reject");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_pending_link");
  });

  it("a name that no longer matches one live complex is 400 unknown_partner", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    vi.mocked(fetchPartners).mockResolvedValue(list("Something Else"));
    mockUser = t.suAdmin;

    const res = await call(acc.id, "confirm");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("unknown_partner");
  });

  it("an unreachable partner API is 503 and grants nothing", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    vi.mocked(fetchPartners).mockRejectedValue(new Error("ECONNREFUSED"));
    mockUser = t.suAdmin;

    const res = await call(acc.id, "confirm");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("partner_api_unavailable");
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: acc.id } })).partnerLinkConfirmedAt)
      .toBeNull();
  });

  it("reject answers 200 with the link cleared", async () => {
    const t = await makeTeamWithUsers();
    const acc = await createAccount(testPrisma, t.suMember, { name: "Komplex B" });
    mockUser = t.suAdmin;

    const res = await call(acc.id, "reject");
    expect(res.status).toBe(200);
    expect((await res.json()).externalPartnerKey).toBeNull();
  });
});
