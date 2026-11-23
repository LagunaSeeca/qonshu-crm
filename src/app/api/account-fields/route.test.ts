import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su } from "@/test/fixtures";
import type { SessionUser } from "@/lib/auth/guards";

vi.mock("@/db/client", () => ({ prisma: testPrisma }));

let mockUser: SessionUser | null = null;
vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => mockUser,
}));

import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[defId]/route";
import { POST as REORDER } from "./reorder/route";

const url = (qs = "") => `http://localhost/api/account-fields${qs}`;
const json = (method: string, body: unknown, qs = "") =>
  new NextRequest(url(qs), { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

async function seed() {
  const a = await makeTeam({ name: "A" });
  const b = await makeTeam({ name: "B", companyId: a.companyId });
  const adminA = su(await makeUser("COMPANY_ADMIN", a));
  const adminB = su(await makeUser("COMPANY_ADMIN", b));
  const memberA = su(await makeUser("MEMBER", a));
  const owner = su(await makeUser("SUPER_ADMIN"));
  // The owner has no company of its own; the template needs one named.
  const tplQs = `?teamId=&companyId=${a.companyId}`;
  return { a, b, adminA, adminB, memberA, owner, tplQs };
}

async function defOf(label: string, teamId: string | null, companyId: string) {
  return testPrisma.accountFieldDef.create({ data: { companyId, teamId, label, type: "TEXT", order: 0 } });
}

describe("/api/account-fields team scoping", () => {
  beforeEach(async () => { await resetDb(); });
  afterEach(() => { mockUser = null; });
  afterAll(() => testPrisma.$disconnect());

  it("SA with ?teamId=<team> reads and writes THAT team's definitions", async () => {
    const { a, b, owner } = await seed();
    await defOf("A-only", a.id, a.companyId);
    await defOf("B-only", b.id, b.companyId);
    mockUser = owner;

    const list = await (await GET(new NextRequest(url(`?teamId=${b.id}`)))).json();
    expect(list.map((d: { label: string }) => d.label)).toEqual(["B-only"]);

    const res = await POST(json("POST", { label: "New", type: "NUMBER" }, `?teamId=${b.id}`));
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.teamId).toBe(b.id);
    expect(created.companyId).toBe(b.companyId);

    // PATCH / reorder / DELETE only reach the named team's rows.
    const ctx = { params: Promise.resolve({ defId: created.id }) };
    expect((await PATCH(json("PATCH", { label: "Renamed" }, `?teamId=${b.id}`), ctx)).status).toBe(200);
    expect((await PATCH(json("PATCH", { label: "x" }, `?teamId=${a.id}`), ctx)).status).toBe(404);
    expect((await REORDER(json("POST", { orderedIds: [created.id] }, `?teamId=${b.id}`))).status).toBe(200);
    expect((await DELETE(json("DELETE", {}, `?teamId=${a.id}`), ctx)).status).toBe(404);
    expect((await DELETE(json("DELETE", {}, `?teamId=${b.id}`), ctx)).status).toBe(200);
  });

  it("SA with an empty ?teamId= reaches the TEMPLATE only, and its label stays unique", async () => {
    const { a, owner, tplQs } = await seed();
    await defOf("Team field", a.id, a.companyId);
    mockUser = owner;

    expect((await POST(json("POST", { label: "Tpl", type: "TEXT" }, tplQs))).status).toBe(201);
    const list = await (await GET(new NextRequest(url(tplQs)))).json();
    expect(list.map((d: { label: string }) => d.label)).toEqual(["Tpl"]);
    expect(list[0].teamId).toBeNull();
    // Postgres treats NULL teamIds as distinct, so this is the app-level check.
    expect((await POST(json("POST", { label: "Tpl", type: "TEXT" }, tplQs))).status).toBe(403);
  });

  it("SA with no ?teamId is refused (nothing to default to)", async () => {
    const { owner } = await seed();
    mockUser = owner;
    expect((await GET(new NextRequest(url()))).status).toBe(403);
    expect((await POST(json("POST", { label: "x", type: "TEXT" }))).status).toBe(403);
  });

  it("a team admin naming another team, or the template, is refused", async () => {
    const { a, b, adminA } = await seed();
    await defOf("B-only", b.id, b.companyId);
    mockUser = adminA;
    expect((await GET(new NextRequest(url(`?teamId=${b.id}`)))).status).toBe(403);
    expect((await POST(json("POST", { label: "x", type: "TEXT" }, `?teamId=${b.id}`))).status).toBe(403);
    expect((await GET(new NextRequest(url("?teamId=")))).status).toBe(403);
    // Naming their own team, or nothing, is fine and only sees their own set.
    expect((await GET(new NextRequest(url(`?teamId=${a.id}`)))).status).toBe(200);
    expect(await (await GET(new NextRequest(url()))).json()).toEqual([]);
  });

  it("a team admin cannot PATCH or DELETE another team's definition by id", async () => {
    const { b, adminA } = await seed();
    const d = await defOf("B-only", b.id, b.companyId);
    mockUser = adminA;
    const ctx = { params: Promise.resolve({ defId: d.id }) };
    expect((await PATCH(json("PATCH", { label: "x" }), ctx)).status).toBe(404);
    expect((await DELETE(json("DELETE", {}), ctx)).status).toBe(404);
  });

  it("a member can read their team's definitions but cannot write", async () => {
    const { a, memberA } = await seed();
    const d = await defOf("A-only", a.id, a.companyId);
    mockUser = memberA;
    expect((await GET(new NextRequest(url()))).status).toBe(200);
    expect((await POST(json("POST", { label: "x", type: "TEXT" }))).status).toBe(403);
    const ctx = { params: Promise.resolve({ defId: d.id }) };
    expect((await PATCH(json("PATCH", { label: "x" }), ctx)).status).toBe(403);
    expect((await DELETE(json("DELETE", {}), ctx)).status).toBe(403);
    expect((await REORDER(json("POST", { orderedIds: [d.id] }))).status).toBe(403);
  });

  it("a partner is refused", async () => {
    const { a } = await seed();
    mockUser = su(await makeUser("PARTNER_VIEWER", a));
    expect((await GET(new NextRequest(url()))).status).toBe(403);
  });
});
