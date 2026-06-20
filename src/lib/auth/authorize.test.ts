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
});
