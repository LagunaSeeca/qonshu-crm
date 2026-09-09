import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { authorizeCredentials } from "./authorize";
import { hashPassword } from "./password";

async function seedUser(status: "ACTIVE" | "INACTIVE") {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a" } });
  await testPrisma.user.create({
    data: {
      companyId: c.id,
      email: "u@a.com",
      passwordHash: await hashPassword("pw123456"),
      name: "U",
      role: "MEMBER",
      status,
    },
  });
}

describe("authorizeCredentials", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns session user for valid active creds", async () => {
    await seedUser("ACTIVE");
    const u = await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" });
    expect(u?.role).toBe("MEMBER");
  });

  it("rejects wrong password", async () => {
    await seedUser("ACTIVE");
    expect(
      await authorizeCredentials(testPrisma, { email: "u@a.com", password: "nope" }),
    ).toBeNull();
  });

  it("rejects inactive user", async () => {
    await seedUser("INACTIVE");
    expect(
      await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" }),
    ).toBeNull();
  });

  // A suspended company must block login outright, not just new user provisioning — otherwise
  // an existing COMPANY_ADMIN in a suspended company could still log in and keep operating.
  it("rejects login when the user's company is SUSPENDED", async () => {
    await seedUser("ACTIVE");
    await testPrisma.company.update({ where: { slug: "a" }, data: { status: "SUSPENDED" } });
    expect(
      await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" }),
    ).toBeNull();
  });

  it("allows login when the user's company is ACTIVE (unaffected by the suspension check)", async () => {
    await seedUser("ACTIVE");
    const u = await authorizeCredentials(testPrisma, { email: "u@a.com", password: "pw123456" });
    expect(u?.companyId).not.toBeNull();
  });

  it("allows a SUPER_ADMIN (no company) to log in regardless of any company's status", async () => {
    await testPrisma.company.create({ data: { name: "B", slug: "b", status: "SUSPENDED" } });
    await testPrisma.user.create({
      data: {
        companyId: null,
        email: "root@platform.com",
        passwordHash: await hashPassword("pw123456"),
        name: "Root",
        role: "SUPER_ADMIN",
        status: "ACTIVE",
      },
    });
    const u = await authorizeCredentials(testPrisma, { email: "root@platform.com", password: "pw123456" });
    expect(u?.role).toBe("SUPER_ADMIN");
    expect(u?.companyId).toBeNull();
  });
});
