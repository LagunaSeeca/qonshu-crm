import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates company with scoped user", async () => {
    const c = await testPrisma.company.create({ data: { name: "Acme", slug: "acme" } });
    const u = await testPrisma.user.create({
      data: { companyId: c.id, email: "a@acme.com", passwordHash: "x", name: "A", role: "COMPANY_ADMIN" },
    });
    expect(u.companyId).toBe(c.id);
  });

  it("enforces unique email", async () => {
    const c = await testPrisma.company.create({ data: { name: "Acme", slug: "acme2" } });
    await testPrisma.user.create({ data: { companyId: c.id, email: "dup@x.com", passwordHash: "x", name: "A", role: "MEMBER" } });
    await expect(
      testPrisma.user.create({ data: { companyId: c.id, email: "dup@x.com", passwordHash: "y", name: "B", role: "MEMBER" } })
    ).rejects.toThrow();
  });
});
