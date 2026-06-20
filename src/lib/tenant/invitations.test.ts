import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getTenantContext } from "./context";
import { createInvitation, acceptInvitation } from "./invitations";
import { verifyPassword } from "@/lib/auth/password";

async function seed() {
  const ts = `invites-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const c = await testPrisma.company.create({ data: { name: "CompanyInv", slug: `${ts}` } });
  const admin = await testPrisma.user.create({ data: { companyId: c.id, email: `admin-${ts}@inv.com`, passwordHash: "x", name: "Ad", role: "COMPANY_ADMIN" } });
  return { c, admin };
}

describe("invitations", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates scoped invite and accepts it into the right company/role", async () => {
    const { c, admin } = await seed();
    const ctx = getTenantContext({ id: admin.id, companyId: c.id, role: "COMPANY_ADMIN" });
    const inv = await createInvitation(testPrisma, ctx, { email: "new@a.com", role: "MEMBER", invitedById: admin.id });
    expect(inv.companyId).toBe(c.id);
    expect(inv.status).toBe("PENDING");

    const user = await acceptInvitation(testPrisma, { token: inv.token, name: "New", password: "pw123456" });
    expect(user.companyId).toBe(c.id);
    expect(user.role).toBe("MEMBER");
    expect(user.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", user.passwordHash)).toBe(true);

    const reused = acceptInvitation(testPrisma, { token: inv.token, name: "X", password: "y2345678" });
    await expect(reused).rejects.toThrow();
  });

  it("rejects expired invite", async () => {
    const { c, admin } = await seed();
    const inv = await testPrisma.invitation.create({
      data: { companyId: c.id, email: "e@a.com", role: "MEMBER", token: "tok-exp", invitedById: admin.id, expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(acceptInvitation(testPrisma, { token: inv.token, name: "E", password: "pw345678" })).rejects.toThrow();
  });

  it("scopes created invite to the context company only", async () => {
    const a = await testPrisma.company.create({ data: { name: "A", slug: "a-iso" } });
    const b = await testPrisma.company.create({ data: { name: "B", slug: "b-iso" } });
    const admin = await testPrisma.user.create({ data: { companyId: a.id, email: "adm@a-iso.com", passwordHash: "x", name: "Ad", role: "COMPANY_ADMIN" } });
    const ctx = getTenantContext({ id: admin.id, companyId: a.id, role: "COMPANY_ADMIN" });
    const inv = await createInvitation(testPrisma, ctx, { email: "x@a-iso.com", role: "MEMBER", invitedById: admin.id });
    expect(inv.companyId).toBe(a.id);
    expect(inv.companyId).not.toBe(b.id);
  });
});
