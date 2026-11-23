import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeTeamWithUsers, makeUser, su } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { PATCH } from "./route";

function renameReq(id: string, name: string) {
  const req = new NextRequest(`http://localhost/api/teams/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return PATCH(req, { params: Promise.resolve({ id }) });
}

describe("PATCH /api/teams/[id]", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("the owner renames a team", async () => {
    const team = await makeTeam({ name: "Old" });
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await renameReq(team.id, "New Name");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: team.id, name: "New Name" });
  });

  it("a team admin cannot rename their own team (403)", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    expect((await renameReq(team.id, "Mine")).status).toBe(403);
    const still = await testPrisma.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(still.name).toBe(team.name);
  });

  it("an unknown team is 404, a blank name 400, a taken name 409", async () => {
    const team = await makeTeam({ name: "Keep" });
    await makeTeam({ companyId: team.companyId, name: "Taken" });
    mockUser = su(await makeUser("SUPER_ADMIN"));
    expect((await renameReq("does-not-exist", "Whatever")).status).toBe(404);
    expect((await renameReq(team.id, "   ")).status).toBe(400);
    expect((await renameReq(team.id, "Taken")).status).toBe(409);
  });

  it("an anonymous request is 401", async () => {
    const team = await makeTeam();
    mockUser = null;
    expect((await renameReq(team.id, "Anon")).status).toBe(401);
  });
});
