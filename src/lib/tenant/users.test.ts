import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getTenantContext } from "./context";
import { listUsers, getUser, setUserStatus, createUser, InvalidUserRoleError } from "./users";
import { verifyPassword } from "@/lib/auth/password";
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

  it("setUserStatus returns the updated record with new status", async () => {
    const { a, ua } = await seedTwoCompanies();
    const ctx = getTenantContext({ id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" });
    const updated = await setUserStatus(testPrisma, ctx, ua.id, "INACTIVE");
    expect(updated.status).toBe("INACTIVE");
  });
});

describe("createUser (direct creation, replaces invites)", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates a MEMBER directly with a hashed password, scoped to the actor's company", async () => {
    const { a, ua } = await seedTwoCompanies();
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const created = await createUser(testPrisma, actor, { name: "New Member", email: `nm-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER" });
    expect(created.companyId).toBe(a.id);
    expect(created.role).toBe("MEMBER");
    expect(created.accountId).toBeNull();
    expect(created.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", created.passwordHash)).toBe(true);
  });

  it("PARTNER_VIEWER without accountId is rejected", async () => {
    const { a, ua } = await seedTwoCompanies();
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    await expect(
      createUser(testPrisma, actor, { name: "P", email: `p1-${Date.now()}@a.com`, password: "pw123456", role: "PARTNER_VIEWER" }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("PARTNER_VIEWER with an accountId from another company is rejected", async () => {
    const { a, b, ua } = await seedTwoCompanies();
    const otherAccount = await testPrisma.account.create({ data: { companyId: b.id, name: "Other Co Account", accountManagerId: ua.id } });
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    await expect(
      createUser(testPrisma, actor, { name: "P", email: `p2-${Date.now()}@a.com`, password: "pw123456", role: "PARTNER_VIEWER", accountId: otherAccount.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("a non-PARTNER_VIEWER role with an accountId is rejected", async () => {
    const { a, ua } = await seedTwoCompanies();
    const account = await testPrisma.account.create({ data: { companyId: a.id, name: "Acc", accountManagerId: ua.id } });
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    await expect(
      createUser(testPrisma, actor, { name: "P", email: `p3-${Date.now()}@a.com`, password: "pw123456", role: "MEMBER", accountId: account.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("PARTNER_VIEWER with a valid accountId in the same company succeeds", async () => {
    const { a, ua } = await seedTwoCompanies();
    const account = await testPrisma.account.create({ data: { companyId: a.id, name: "Acc2", accountManagerId: ua.id } });
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const created = await createUser(testPrisma, actor, { name: "GoodPartner", email: `gp-${Date.now()}@a.com`, password: "pw123456", role: "PARTNER_VIEWER", accountId: account.id });
    expect(created.role).toBe("PARTNER_VIEWER");
    expect(created.accountId).toBe(account.id);
  });

  it("duplicate email is rejected (unique constraint)", async () => {
    const { a, ua } = await seedTwoCompanies();
    const actor: SessionUser = { id: ua.id, companyId: a.id, role: "COMPANY_ADMIN" };
    const email = `dup-${Date.now()}@a.com`;
    await createUser(testPrisma, actor, { name: "First", email, password: "pw123456", role: "MEMBER" });
    await expect(
      createUser(testPrisma, actor, { name: "Second", email, password: "pw123456", role: "MEMBER" }),
    ).rejects.toThrow();
  });
});
