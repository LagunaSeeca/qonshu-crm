import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { changeOwnPassword, InvalidCurrentPasswordError } from "./password";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/guards";

async function seedUser() {
  const ts = `pwd-${Date.now()}-${Math.random().toString(36).substring(7)}`;
  const c = await testPrisma.company.create({ data: { name: "PwdCo", slug: ts } });
  const passwordHash = await hashPassword("oldpass123");
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${ts}@a.com`, passwordHash, name: "U", role: "MEMBER" },
  });
  return { c, u };
}

describe("changeOwnPassword", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("rejects an incorrect current password and leaves the hash untouched", async () => {
    const { c, u } = await seedUser();
    const actor: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
    await expect(
      changeOwnPassword(testPrisma, actor, { currentPassword: "wrongpass", newPassword: "newpass123" }),
    ).rejects.toThrow(InvalidCurrentPasswordError);
    const stillOld = await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("oldpass123", stillOld.passwordHash)).toBe(true);
  });

  it("rotates the password when the current password is correct", async () => {
    const { c, u } = await seedUser();
    const actor: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
    await changeOwnPassword(testPrisma, actor, { currentPassword: "oldpass123", newPassword: "newpass123" });
    const updated = await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("newpass123", updated.passwordHash)).toBe(true);
    expect(await verifyPassword("oldpass123", updated.passwordHash)).toBe(false);
  });

  it("works for a PARTNER_VIEWER changing their own password (their only allowed write)", async () => {
    const { c, u } = await seedUser();
    await testPrisma.user.update({ where: { id: u.id }, data: { role: "PARTNER_VIEWER" } });
    const actor: SessionUser = { id: u.id, companyId: c.id, role: "PARTNER_VIEWER", accountId: null };
    await changeOwnPassword(testPrisma, actor, { currentPassword: "oldpass123", newPassword: "partnernew123" });
    const updated = await testPrisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await verifyPassword("partnernew123", updated.passwordHash)).toBe(true);
  });
});
