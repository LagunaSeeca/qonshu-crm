import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";
import { DELETE } from "./[id]/route";

const SUPER: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };

function postReq(body: unknown) {
  return new NextRequest("http://localhost/api/platform/partner-allowlist", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function del(id: string) {
  return DELETE(
    new NextRequest(`http://localhost/api/platform/partner-allowlist/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
}

async function seedCompany(slug: string) {
  const c = await testPrisma.company.create({ data: { name: `Co ${slug}`, slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
  });
  return { c, u };
}

describe("/api/platform/partner-allowlist — SUPER_ADMIN-only grant management", () => {
  let ts = "";

  beforeEach(async () => {
    await resetDb();
    mockUser = SUPER;
    ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  });
  afterEach(() => {
    mockUser = null;
  });
  afterAll(() => testPrisma.$disconnect());

  it("grants a complex to a company and lists it back with the company name", async () => {
    const { c } = await seedCompany(`grant-${ts}`);

    const res = await POST(postReq({ partnerName: "Komplex B", companyId: c.id }));
    expect(res.status).toBe(201);
    expect((await res.json()).partnerName).toBe("Komplex B");

    const list = await (await GET()).json();
    expect(list).toHaveLength(1);
    expect(list[0].companyName).toBe(c.name);
  });

  it("409s a complex that is already granted, whatever the casing", async () => {
    const a = await seedCompany(`conf-a-${ts}`);
    const b = await seedCompany(`conf-b-${ts}`);
    expect((await POST(postReq({ partnerName: "Komplex B", companyId: a.c.id }))).status).toBe(201);

    const res = await POST(postReq({ partnerName: "  komplex b ", companyId: b.c.id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("partner_already_granted");
    expect(await testPrisma.partnerAllowlist.count()).toBe(1);
  });

  it("404s a company that does not exist", async () => {
    const res = await POST(postReq({ partnerName: "Komplex B", companyId: "nope" }));
    expect(res.status).toBe(404);
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);
  });

  it("revokes a grant, and 404s an unknown id", async () => {
    const { c } = await seedCompany(`rev-${ts}`);
    const created = await (await POST(postReq({ partnerName: "Komplex B", companyId: c.id }))).json();

    expect((await del(created.id)).status).toBe(200);
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);
    expect((await del(created.id)).status).toBe(404);
  });

  // The allowlist names complexes belonging to other companies, and a grant is what authorizes an
  // account to read a complex's debt, payments and unit-level owner names/phones. A tenant role
  // must learn nothing at all — not even that a malformed body would have been rejected.
  it("403s every verb for a COMPANY_ADMIN, asserting role BEFORE parsing the body", async () => {
    const { c, u } = await seedCompany(`forbid-${ts}`);
    const row = await testPrisma.partnerAllowlist.create({
      data: { companyId: c.id, partnerName: "Komplex B", normalizedName: "komplex b" },
    });
    mockUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };

    expect((await GET()).status).toBe(403);
    for (const body of [{}, { partnerName: 42 }, { partnerName: "Komplex B", companyId: c.id }]) {
      const res = await POST(postReq(body));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("forbidden");
    }
    expect((await del(row.id)).status).toBe(403);

    // Nothing was created, nothing was removed.
    expect(await testPrisma.partnerAllowlist.count()).toBe(1);
  });

  it("401s when there is no signed-in user", async () => {
    mockUser = null;
    expect((await GET()).status).toBe(401);
    expect((await POST(postReq({ partnerName: "X", companyId: "y" }))).status).toBe(401);
    expect((await del("whatever")).status).toBe(401);
  });

  it("400s a malformed body for a SUPER_ADMIN — they are the only caller who gets to see that", async () => {
    const res = await POST(postReq({ partnerName: "" }));
    expect(res.status).toBe(400);
  });
});
