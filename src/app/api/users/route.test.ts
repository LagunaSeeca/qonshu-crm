import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";

// Route handlers use `@/db/client`'s `prisma` singleton and `@/lib/auth/session`'s
// getSessionUser (backed by next-auth, which needs a real request-scoped context we don't have
// here). Mock both so the handler runs against testPrisma with a session we control. Mirrors the
// pattern in src/app/api/accounts/route.test.ts.
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

async function seedTwoCompanies() {
  const ts = `users-route-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const a = await testPrisma.company.create({ data: { name: "A", slug: `a-${ts}` } });
  const b = await testPrisma.company.create({ data: { name: "B", slug: `b-${ts}` } });
  const ua = await testPrisma.user.create({ data: { companyId: a.id, email: `ua-${ts}@a.com`, passwordHash: "x", name: "UA", role: "COMPANY_ADMIN" } });
  return { a, b, ua };
}

describe("POST /api/users", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("SUPER_ADMIN creates a MEMBER in a named company", async () => {
    const { a } = await seedTwoCompanies();
    mockUser = { id: "super-1", companyId: null, role: "SUPER_ADMIN" };
    const res = await POST(postReq({
      name: "New Manager", email: `sam-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER", companyId: a.id,
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.role).toBe("MEMBER");
    const stored = await testPrisma.user.findUnique({ where: { id: body.id } });
    expect(stored?.companyId).toBe(a.id);
  });

  it("SUPER_ADMIN without companyId gets 400", async () => {
    mockUser = { id: "super-2", companyId: null, role: "SUPER_ADMIN" };
    const res = await POST(postReq({
      name: "X", email: `sam2-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER",
    }));
    expect(res.status).toBe(400);
  });

  it("SUPER_ADMIN with a nonexistent companyId gets 404 or 400", async () => {
    mockUser = { id: "super-3", companyId: null, role: "SUPER_ADMIN" };
    const res = await POST(postReq({
      name: "X", email: `sam3-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER", companyId: "does-not-exist",
    }));
    expect([400, 404]).toContain(res.status);
  });

  it("COMPANY_ADMIN still creates a user in their own company", async () => {
    const { a, ua } = await seedTwoCompanies();
    mockUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const res = await POST(postReq({
      name: "Own Member", email: `own-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER",
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    const stored = await testPrisma.user.findUnique({ where: { id: body.id } });
    expect(stored?.companyId).toBe(a.id);
  });

  it("COMPANY_ADMIN passing another company's id gets 400 (no misleading success)", async () => {
    const { a, b, ua } = await seedTwoCompanies();
    mockUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const res = await POST(postReq({
      name: "Sneaky", email: `sneaky-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER", companyId: b.id,
    }));
    expect(res.status).toBe(400);
  });

  it("MEMBER is forbidden from creating users", async () => {
    const { a } = await seedTwoCompanies();
    const member = await testPrisma.user.create({ data: { companyId: a.id, email: `mem-${Date.now()}@a.com`, passwordHash: "x", name: "Mem", role: "MEMBER" } });
    mockUser = { id: member.id, companyId: a.id, role: "MEMBER" };
    const res = await POST(postReq({
      name: "X", email: `blocked-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER",
    }));
    expect(res.status).toBe(403);
  });

  it("PARTNER_VIEWER is forbidden from creating users", async () => {
    const { a, ua } = await seedTwoCompanies();
    const account = await testPrisma.account.create({ data: { companyId: a.id, name: "Acc", accountManagerId: ua.id } });
    const partner = await testPrisma.user.create({ data: { companyId: a.id, email: `pv-${Date.now()}@a.com`, passwordHash: "x", name: "PV", role: "PARTNER_VIEWER", accountId: account.id } });
    mockUser = { id: partner.id, companyId: a.id, role: "PARTNER_VIEWER", accountId: account.id };
    const res = await POST(postReq({
      name: "X", email: `blocked2-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER",
    }));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/users", () => {
  beforeEach(resetDb);
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("COMPANY_ADMIN lists only their own company's users", async () => {
    const { a, ua } = await seedTwoCompanies();
    mockUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((u: { email: string }) => u.email)).toEqual([ua.email]);
  });

  it("COMPANY_ADMIN passing another company's id gets 400 (cannot list across tenants)", async () => {
    const { a, b, ua } = await seedTwoCompanies();
    mockUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const res = await GET(getReq({ companyId: b.id }));
    expect(res.status).toBe(400);
  });

  it("COMPANY_ADMIN passing their OWN companyId still succeeds", async () => {
    const { a, ua } = await seedTwoCompanies();
    mockUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const res = await GET(getReq({ companyId: a.id }));
    expect(res.status).toBe(200);
  });

  it("SUPER_ADMIN lists a named company's users", async () => {
    const { a, ua } = await seedTwoCompanies();
    mockUser = { id: "super-1", companyId: null, role: "SUPER_ADMIN" };
    const res = await GET(getReq({ companyId: a.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((u: { email: string }) => u.email)).toEqual([ua.email]);
  });

  it("SUPER_ADMIN without companyId gets 400", async () => {
    mockUser = { id: "super-2", companyId: null, role: "SUPER_ADMIN" };
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it("MEMBER is forbidden from listing users", async () => {
    const { a } = await seedTwoCompanies();
    const member = await testPrisma.user.create({ data: { companyId: a.id, email: `mem-get-${Date.now()}@a.com`, passwordHash: "x", name: "Mem", role: "MEMBER" } });
    mockUser = { id: member.id, companyId: a.id, role: "MEMBER" };
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });
});
