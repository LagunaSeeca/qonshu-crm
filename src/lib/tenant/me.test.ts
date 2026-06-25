import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getCurrentUser } from "./me";

async function seed() {
  const ts = `me-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const company = await testPrisma.company.create({ data: { name: "Acme Corp", slug: `acme-${ts}` } });
  const user = await testPrisma.user.create({
    data: {
      companyId: company.id,
      email: `ali-${ts}@acme.com`,
      passwordHash: "x",
      name: "Ali Admin",
      role: "COMPANY_ADMIN",
    },
  });
  return { company, user };
}

describe("getCurrentUser", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns name, email, role, and companyName for tenant user", async () => {
    const { company, user } = await seed();
    const result = await getCurrentUser(testPrisma, { id: user.id, companyId: company.id, role: "COMPANY_ADMIN" });
    expect(result.name).toBe("Ali Admin");
    expect(result.email).toBe(user.email);
    expect(result.role).toBe("COMPANY_ADMIN");
    expect(result.companyName).toBe("Acme Corp");
  });

  it("returns companyName null when user has no companyId (super-admin)", async () => {
    const ts = `sa-${Date.now()}`;
    const sa = await testPrisma.user.create({
      data: { email: `sa-${ts}@qonshu.com`, passwordHash: "x", name: "Super", role: "SUPER_ADMIN" },
    });
    const result = await getCurrentUser(testPrisma, { id: sa.id, companyId: null, role: "SUPER_ADMIN" });
    expect(result.companyName).toBeNull();
  });
});
