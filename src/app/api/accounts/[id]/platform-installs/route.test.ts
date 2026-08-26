import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/accounts/x/platform-installs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

async function setup(slug: string, role: SessionUser["role"] = "COMPANY_ADMIN") {
  const c = await testPrisma.company.create({ data: { name: "Co", slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role },
  });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role };
  return { c, u, acc, user };
}

describe("platform-installs route", () => {
  beforeEach(async () => {
    await resetDb();
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("POST creates a snapshot, and a same-day POST overwrites it (upsert, not append)", async () => {
    const { acc, user } = await setup("pi-route-upsert");
    mockUser = user;

    const first = await POST(
      postReq({ capturedOn: "2026-07-01", iosInstalls: 5, androidInstalls: 3 }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    expect(firstBody.iosInstalls).toBe(5);

    const second = await POST(
      postReq({ capturedOn: "2026-07-01", iosInstalls: 9, androidInstalls: 4 }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(second.status).toBe(201);

    const listRes = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: acc.id }) });
    const list = await listRes.json();
    expect(list).toHaveLength(1);
    expect(list[0].iosInstalls).toBe(9);
    expect(list[0].androidInstalls).toBe(4);
  });

  it("GET lists snapshots ordered by capturedOn ascending", async () => {
    const { acc, user } = await setup("pi-route-order");
    mockUser = user;
    await POST(postReq({ capturedOn: "2026-07-15", iosInstalls: 1, androidInstalls: 0 }), { params: Promise.resolve({ id: acc.id }) });
    await POST(postReq({ capturedOn: "2026-07-01", iosInstalls: 2, androidInstalls: 0 }), { params: Promise.resolve({ id: acc.id }) });

    const res = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: acc.id }) });
    const list = await res.json();
    expect(list.map((s: { capturedOn: string }) => s.capturedOn.slice(0, 10))).toEqual(["2026-07-01", "2026-07-15"]);
  });

  it("rejects an invalid calendar date (e.g. Feb 30) with 400 instead of silently normalizing it", async () => {
    const { acc, user } = await setup("pi-route-invaliddate");
    mockUser = user;
    const res = await POST(
      postReq({ capturedOn: "2026-02-30", iosInstalls: 1, androidInstalls: 1 }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("invalid_date");
  });

  it("POST requires COMPANY_ADMIN — a MEMBER is forbidden", async () => {
    const { acc, user } = await setup("pi-route-role", "MEMBER");
    mockUser = user;
    const res = await POST(
      postReq({ capturedOn: "2026-07-01", iosInstalls: 1, androidInstalls: 1 }),
      { params: Promise.resolve({ id: acc.id }) },
    );
    expect(res.status).toBe(403);
  });

  it("blocks cross-tenant access: a foreign account's snapshots are never returned or created", async () => {
    const { acc: foreignAcc, user: ownerUser } = await setup("pi-route-x1");
    mockUser = ownerUser;
    await POST(
      postReq({ capturedOn: "2026-07-01", iosInstalls: 7, androidInstalls: 7 }),
      { params: Promise.resolve({ id: foreignAcc.id }) },
    );
    const { user: intruder } = await setup("pi-route-x2");
    mockUser = intruder;

    const getRes = await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: foreignAcc.id }) });
    expect(getRes.status).toBe(404);

    const postRes = await POST(
      postReq({ capturedOn: "2026-07-02", iosInstalls: 1, androidInstalls: 1 }),
      { params: Promise.resolve({ id: foreignAcc.id }) },
    );
    expect(postRes.status).toBe(404);
  });
});
