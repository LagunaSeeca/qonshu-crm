import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeam, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";

// Route handlers use `@/db/client`'s `prisma` singleton and `@/lib/auth/session`'s getSessionUser
// (backed by next-auth, which needs a real request-scoped context we don't have here). Mock both
// so the handler runs against testPrisma with a session we control.
vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq(query?: Record<string, string>) {
  const qs = query ? `?${new URLSearchParams(query).toString()}` : "";
  return new NextRequest(`http://localhost/api/users${qs}`, { method: "GET" });
}

function creds(role: "COMPANY_ADMIN" | "MEMBER" | "PARTNER_VIEWER") {
  return { name: "New Person", email: `${uniq("rt-")}@test.local`, password: "pw123456", role };
}

describe("POST /api/users", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("SUPER_ADMIN creates a MEMBER in a named team", async () => {
    const team = await makeTeam();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq({ ...creds("MEMBER"), teamId: team.id }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.role).toBe("MEMBER");
    expect(body.teamId).toBe(team.id);
    const stored = await testPrisma.user.findUniqueOrThrow({ where: { id: body.id } });
    expect(stored.companyId).toBe(team.companyId);
  });

  it("SUPER_ADMIN creates a team admin for a named team", async () => {
    const team = await makeTeam();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq({ ...creds("COMPANY_ADMIN"), teamId: team.id }));
    expect(res.status).toBe(201);
    expect((await res.json()).role).toBe("COMPANY_ADMIN");
  });

  it("SUPER_ADMIN without a teamId gets 400", async () => {
    await makeTeam();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq(creds("MEMBER")));
    expect(res.status).toBe(400);
  });

  it("SUPER_ADMIN naming a nonexistent team gets 404", async () => {
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq({ ...creds("MEMBER"), teamId: "does-not-exist" }));
    expect(res.status).toBe(404);
  });

  it("a team admin creates a MEMBER in their own team without naming it", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    const res = await POST(postReq(creds("MEMBER")));
    expect(res.status).toBe(201);
    const stored = await testPrisma.user.findUniqueOrThrow({ where: { id: (await res.json()).id } });
    expect(stored.teamId).toBe(team.id);
  });

  it("a team admin naming ANOTHER team gets 400 and creates nothing", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    const other = await makeTeam({ companyId: team.companyId });
    mockUser = suAdmin;
    const res = await POST(postReq({ ...creds("MEMBER"), teamId: other.id }));
    expect(res.status).toBe(400);
    expect(await testPrisma.user.count({ where: { teamId: other.id } })).toBe(0);
  });

  it("a team admin cannot create another team admin (403)", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    const res = await POST(postReq(creds("COMPANY_ADMIN")));
    expect(res.status).toBe(403);
  });

  it("SUPER_ADMIN is not an accepted role in the body (400)", async () => {
    const team = await makeTeam();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq({ ...creds("MEMBER"), role: "SUPER_ADMIN", teamId: team.id }));
    expect(res.status).toBe(400);
  });

  it("a MEMBER is forbidden from creating users", async () => {
    const { suMember } = await makeTeamWithUsers();
    mockUser = suMember;
    const res = await POST(postReq(creds("MEMBER")));
    expect(res.status).toBe(403);
  });

  it("a PARTNER_VIEWER is forbidden from creating users", async () => {
    const { team, admin } = await makeTeamWithUsers();
    const name = uniq("Bldg ");
    const account = await testPrisma.account.create({
      data: {
        companyId: team.companyId,
        teamId: team.id,
        name,
        buildingKey: buildingKey(name),
        accountManagerId: admin.id,
      },
    });
    const partner = await makeUser("PARTNER_VIEWER", team, { accountId: account.id });
    mockUser = su(partner);
    const res = await POST(postReq(creds("MEMBER")));
    expect(res.status).toBe(403);
  });

  it("a suspended company gets no new logins (400)", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    await testPrisma.company.update({ where: { id: team.companyId }, data: { status: "SUSPENDED" } });
    mockUser = suAdmin;
    const res = await POST(postReq(creds("MEMBER")));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/users", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("a team admin lists only their own team", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    mockUser = mine.suAdmin;
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const emails = (await res.json()).map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual([mine.admin.email, mine.member.email].sort());
    expect(emails).not.toContain(theirs.member.email);
  });

  it("a team admin naming another team gets 403, not that team's users", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    mockUser = mine.suAdmin;
    const res = await GET(getReq({ teamId: theirs.team.id }));
    expect(res.status).toBe(403);
  });

  it("a team admin naming their OWN team still succeeds", async () => {
    const mine = await makeTeamWithUsers();
    mockUser = mine.suAdmin;
    const res = await GET(getReq({ teamId: mine.team.id }));
    expect(res.status).toBe(200);
  });

  it("SUPER_ADMIN lists everyone, and may filter by team", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const all = await (await GET(getReq())).json();
    expect(all.map((u: { email: string }) => u.email)).toContain(theirs.admin.email);
    const filtered = await (await GET(getReq({ teamId: mine.team.id }))).json();
    expect(filtered.map((u: { email: string }) => u.email).sort()).toEqual(
      [mine.admin.email, mine.member.email].sort(),
    );
  });

  it("a MEMBER is forbidden from listing users", async () => {
    const { suMember } = await makeTeamWithUsers();
    mockUser = suMember;
    expect((await GET(getReq())).status).toBe(403);
  });

  it("an unauthenticated request is 401", async () => {
    mockUser = null;
    expect((await GET(getReq())).status).toBe(401);
    expect((await POST(postReq(creds("MEMBER")))).status).toBe(401);
  });
});
