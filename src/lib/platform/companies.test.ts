import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { createCompany } from "./companies";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "a", companyId: "c", role: "COMPANY_ADMIN" };

describe("createCompany", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("super admin creates company + admin invite", async () => {
    const ts = `plat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const { company, invitation } = await createCompany(testPrisma, su, { name: "Acme", slug: `acme-${ts}`, adminEmail: "boss@acme.com" });
    expect(company.slug).toBe(`acme-${ts}`);
    expect(invitation.role).toBe("COMPANY_ADMIN");
    expect(invitation.companyId).toBe(company.id);
  });

  it("non-super-admin is forbidden", async () => {
    const ts = `plat-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    await expect(createCompany(testPrisma, admin, { name: "X", slug: `x-${ts}`, adminEmail: "e@x.com" })).rejects.toThrow(ForbiddenError);
  });
});
