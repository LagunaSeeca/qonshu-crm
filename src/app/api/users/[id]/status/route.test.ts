import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeamWithUsers, makeUser, su } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { PATCH } from "./route";

function patchReq(id: string, status: "ACTIVE" | "INACTIVE") {
  const req = new NextRequest(`http://localhost/api/users/${id}/status`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
  return PATCH(req, { params: Promise.resolve({ id }) });
}

describe("PATCH /api/users/[id]/status", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("a team admin deactivates their own team's member", async () => {
    const { member, suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    const res = await patchReq(member.id, "INACTIVE");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: member.id, status: "INACTIVE" });
  });

  // The old handler called getTenantContext(user), which threw for the owner's null companyId —
  // a 500 that locked the owner out of this route entirely.
  it("the SUPER_ADMIN may deactivate a team admin", async () => {
    const { admin } = await makeTeamWithUsers();
    mockUser = su(await makeUser("SUPER_ADMIN"));
    const res = await patchReq(admin.id, "INACTIVE");
    expect(res.status).toBe(200);
  });

  it("another team's member is 404, and stays active", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    mockUser = mine.suAdmin;
    const res = await patchReq(theirs.member.id, "INACTIVE");
    expect(res.status).toBe(404);
    const still = await testPrisma.user.findUniqueOrThrow({ where: { id: theirs.member.id } });
    expect(still.status).toBe("ACTIVE");
  });

  it("deactivating yourself is 403", async () => {
    const { admin, suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    expect((await patchReq(admin.id, "INACTIVE")).status).toBe(403);
  });

  // Two different refusals for the same target, which is the point: a team admin cannot even see
  // the owner (404 — the row is outside its team), while another owner, who CAN see it, is still
  // refused the write (403). Either way the account survives.
  it("the SUPER_ADMIN cannot be deactivated — 404 for a team admin, 403 for another owner", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    const owner = await makeUser("SUPER_ADMIN");
    mockUser = suAdmin;
    expect((await patchReq(owner.id, "INACTIVE")).status).toBe(404);
    mockUser = su(await makeUser("SUPER_ADMIN"));
    expect((await patchReq(owner.id, "INACTIVE")).status).toBe(403);
    const still = await testPrisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(still.status).toBe("ACTIVE");
  });

  it("a MEMBER is forbidden, and an anonymous request is 401", async () => {
    const { member, suMember } = await makeTeamWithUsers();
    mockUser = suMember;
    expect((await patchReq(member.id, "INACTIVE")).status).toBe(403);
    mockUser = null;
    expect((await patchReq(member.id, "INACTIVE")).status).toBe(401);
  });

  it("an unknown status value is 400", async () => {
    const { member, suAdmin } = await makeTeamWithUsers();
    mockUser = suAdmin;
    const req = new NextRequest(`http://localhost/api/users/${member.id}/status`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "BANNED" }),
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: member.id }) });
    expect(res.status).toBe(400);
  });
});
