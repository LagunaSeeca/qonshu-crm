import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getTenantContext } from "./context";
import { listUsers, getUser, setUserStatus } from "./users";
import type { SessionUser } from "@/lib/auth/guards";

async function seedTwoCompanies() {
  const ts = `users-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const a = await testPrisma.company.create({ data: { name: "A", slug: `a-${ts}` } });
  const b = await testPrisma.company.create({ data: { name: "B", slug: `b-${ts}` } });
  const ua = await testPrisma.user.create({ data: { companyId: a.id, email: `ua-${ts}@a.com`, passwordHash: "x", name: "UA", role: "COMPANY_ADMIN" } });
  const ub = await testPrisma.user.create({ data: { companyId: b.id, email: `ub-${ts}@b.com`, passwordHash: "x", name: "UB", role: "MEMBER" } });
  return { a, b, ua, ub };
}

describe("tenant user scoping", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("listUsers returns only own company", async () => {
    const { a, ua } = await seedTwoCompanies();
    const ctx = getTenantContext({ id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" });
    const users = await listUsers(testPrisma, ctx);
    expect(users.map((u) => u.email)).toEqual([ua.email]);
  });

  it("getUser cannot read another tenant's user", async () => {
    const { a, ua, ub } = await seedTwoCompanies();
    const ctx = getTenantContext({ id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" });
    expect(await getUser(testPrisma, ctx, ub.id)).toBeNull();
  });

  it("getTenantContext throws when companyId null", () => {
    const su: SessionUser = { id: "1", companyId: null, role: "SUPER_ADMIN" };
    expect(() => getTenantContext(su)).toThrow();
  });
});
