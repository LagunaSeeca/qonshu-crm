import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { createCompany } from "./companies";
import { verifyPassword } from "@/lib/auth/password";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "a", companyId: "c", role: "COMPANY_ADMIN" };

describe("createCompany", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("super admin creates company + admin user directly (no invite)", async () => {
    const ts = `plat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const { company, admin: created } = await createCompany(testPrisma, su, {
      name: "Acme", slug: `acme-${ts}`, adminName: "Boss", adminEmail: `boss-${ts}@acme.com`, adminPassword: "pw123456",
    });
    expect(company.slug).toBe(`acme-${ts}`);
    expect(created.role).toBe("COMPANY_ADMIN");
    expect(created.companyId).toBe(company.id);
    expect(created.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", created.passwordHash)).toBe(true);
  });

  it("non-super-admin is forbidden", async () => {
    const ts = `plat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    await expect(
      createCompany(testPrisma, admin, { name: "X", slug: `x-${ts}`, adminName: "Y", adminEmail: `e-${ts}@x.com`, adminPassword: "pw123456" }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("duplicate admin email is rejected", async () => {
    const ts = `plat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const email = `dup-${ts}@acme.com`;
    await createCompany(testPrisma, su, { name: "A1", slug: `a1-${ts}`, adminName: "Boss", adminEmail: email, adminPassword: "pw123456" });
    await expect(
      createCompany(testPrisma, su, { name: "A2", slug: `a2-${ts}`, adminName: "Boss2", adminEmail: email, adminPassword: "pw123456" }),
    ).rejects.toThrow();
  });
});
