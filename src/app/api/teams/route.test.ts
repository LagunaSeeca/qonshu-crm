import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function body(name: string) {
  return { name, adminName: "Team Admin", adminEmail: `${uniq("ta-")}@test.local`, adminPassword: "pw123456" };
}

describe("POST /api/teams", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("the owner creates a team with its admin and template", async () => {
    await makeCompany();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await POST(postReq(body("Lankaran")));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.team.name).toBe("Lankaran");
    expect(json.admin.role).toBe("COMPANY_ADMIN");
    // The response must never leak the hash of the password the owner just typed.
    expect(JSON.stringify(json)).not.toContain("passwordHash");
    expect(await testPrisma.stage.count({ where: { teamId: json.team.id } })).toBeGreaterThan(0);
  });

  // `["SUPER_ADMIN"]` does not admit a COMPANY_ADMIN: assertRole's widening runs the other way.
  it("a team admin cannot create a team (403)", async () => {
    const { suAdmin, suMember } = await makeTeamWithUsers();
    mockUser = suAdmin;
    expect((await POST(postReq(body("Nope")))).status).toBe(403);
    mockUser = suMember;
    expect((await POST(postReq(body("Nope")))).status).toBe(403);
    expect(await testPrisma.team.count()).toBe(1);
  });

  it("a blank name is 400 and a duplicate name is 409", async () => {
    await makeCompany();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    expect((await POST(postReq(body("   ")))).status).toBe(400);
    expect((await POST(postReq(body("Baku")))).status).toBe(201);
    expect((await POST(postReq(body("Baku")))).status).toBe(409);
  });

  it("an anonymous request is 401", async () => {
    mockUser = null;
    expect((await POST(postReq(body("Anon")))).status).toBe(401);
  });
});

describe("GET /api/teams", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("lists the org's teams for the owner", async () => {
    await makeCompany();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    await POST(postReq(body("Alpha")));
    await POST(postReq(body("Beta")));
    const res = await GET();
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows.map((r: { name: string }) => r.name)).toEqual(["Alpha", "Beta"]);
    expect(rows[0].admin.email).toMatch(/@test\.local$/);
    expect(rows[0].admins).toBe(1);
  });

  it("is 403 for a team admin and 401 anonymously", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    expect((await GET()).status).toBe(403);
    mockUser = null;
    expect((await GET()).status).toBe(401);
  });
});
