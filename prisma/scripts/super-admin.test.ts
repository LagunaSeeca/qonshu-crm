import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeamWithUsers, makeUser, uniq } from "@/test/fixtures";
import { verifyPassword } from "@/lib/auth/password";
import { createSuperAdmin, promoteSuperAdmin, resetPassword } from "./super-admin";

describe("promoteSuperAdmin", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  // The production case: the only user is a COMPANY_ADMIN, i.e. a TEAM admin, so nobody can
  // create teams or other team admins until this runs.
  it("turns the existing team admin into the owner, clearing its team", async () => {
    const { admin, team } = await makeTeamWithUsers();
    const r = await promoteSuperAdmin(testPrisma, admin.email);
    expect(r.changed).toBe(true);
    expect(r.companyId).toBe(team.companyId);
    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.role).toBe("SUPER_ADMIN");
    expect(row.teamId).toBeNull();
    expect(row.accountId).toBeNull();
    expect(row.companyId).toBe(team.companyId);
    expect(row.status).toBe("ACTIVE");
  });

  it("is idempotent", async () => {
    const { admin } = await makeTeamWithUsers();
    await promoteSuperAdmin(testPrisma, admin.email);
    const second = await promoteSuperAdmin(testPrisma, admin.email);
    expect(second.changed).toBe(false);
    expect(await testPrisma.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
  });

  it("attaches an owner that has no company to THE company", async () => {
    const co = await makeCompany();
    const orphan = await makeUser("SUPER_ADMIN");
    expect(orphan.companyId).toBeNull();
    const r = await promoteSuperAdmin(testPrisma, orphan.email);
    expect(r.companyId).toBe(co.id);
    expect(r.changed).toBe(true);
  });

  it("refuses to guess when several companies exist, and takes a slug instead", async () => {
    await makeCompany();
    const b = await makeCompany({ slug: `pick-${uniq("")}` });
    const orphan = await makeUser("SUPER_ADMIN");
    await expect(promoteSuperAdmin(testPrisma, orphan.email)).rejects.toThrow(/more than one company/);
    const r = await promoteSuperAdmin(testPrisma, orphan.email, { companySlug: b.slug });
    expect(r.companyId).toBe(b.id);
  });

  it("refuses an unknown email", async () => {
    await makeCompany();
    await expect(promoteSuperAdmin(testPrisma, "nobody@test.local")).rejects.toThrow(/no user with email/);
  });

  it("also reactivates a deactivated owner account", async () => {
    const { admin } = await makeTeamWithUsers();
    await testPrisma.user.update({ where: { id: admin.id }, data: { status: "INACTIVE" } });
    await promoteSuperAdmin(testPrisma, admin.email);
    const row = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(row.status).toBe("ACTIVE");
  });
});

describe("createSuperAdmin", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates the owner from env-supplied credentials, with no team", async () => {
    const co = await makeCompany();
    const email = `${uniq("owner-")}@test.local`;
    const r = await createSuperAdmin(testPrisma, { email, password: "pw12345678", name: "Owner" });
    expect(r.created).toBe(true);
    expect(r.companyId).toBe(co.id);
    const row = await testPrisma.user.findUniqueOrThrow({ where: { email } });
    expect(row.role).toBe("SUPER_ADMIN");
    expect(row.teamId).toBeNull();
    expect(row.companyId).toBe(co.id);
    expect(await verifyPassword("pw12345678", row.passwordHash)).toBe(true);
  });

  it("refuses to run once a DIFFERENT super admin exists", async () => {
    await makeCompany();
    const existing = await makeUser("SUPER_ADMIN");
    await expect(
      createSuperAdmin(testPrisma, { email: `${uniq("second-")}@test.local`, password: "pw12345678" }),
    ).rejects.toThrow(/already exists/);
    expect(await testPrisma.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
    expect(await testPrisma.user.findUniqueOrThrow({ where: { email: existing.email } })).toBeTruthy();
  });

  it("re-running with the same email is a no-op, not an error", async () => {
    await makeCompany();
    const email = `${uniq("owner-")}@test.local`;
    await createSuperAdmin(testPrisma, { email, password: "pw12345678" });
    const again = await createSuperAdmin(testPrisma, { email, password: "pw12345678" });
    expect(again.created).toBe(false);
    expect(await testPrisma.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(1);
  });

  it("points an existing non-owner login at --promote instead of duplicating it", async () => {
    const { admin } = await makeTeamWithUsers();
    await expect(
      createSuperAdmin(testPrisma, { email: admin.email, password: "pw12345678" }),
    ).rejects.toThrow(/--promote/);
  });

  it("requires an email and a password of at least 8 characters", async () => {
    await makeCompany();
    await expect(createSuperAdmin(testPrisma, { email: "", password: "pw12345678" })).rejects.toThrow(
      /SUPER_ADMIN_EMAIL/,
    );
    await expect(
      createSuperAdmin(testPrisma, { email: `${uniq("o-")}@test.local`, password: "short" }),
    ).rejects.toThrow(/SUPER_ADMIN_PASSWORD/);
    expect(await testPrisma.user.count({ where: { role: "SUPER_ADMIN" } })).toBe(0);
  });

  it("refuses when no company exists yet", async () => {
    await expect(
      createSuperAdmin(testPrisma, { email: `${uniq("o-")}@test.local`, password: "pw12345678" }),
    ).rejects.toThrow(/no company exists/);
  });
});

describe("resetPassword", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("replaces the hash so the new password verifies and the old one stops working", async () => {
    const { admin } = await makeTeamWithUsers();
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });

    const r = await resetPassword(testPrisma, { email: admin.email, password: "brand-new-pw-1" });
    expect(r.email).toBe(admin.email);

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword("brand-new-pw-1", after.passwordHash)).toBe(true);
    expect(await verifyPassword("password123", after.passwordHash)).toBe(false);
    expect(after.passwordHash).not.toBe(before.passwordHash);
  });

  // The whole point of the narrow scope: an operator recovering a login must not be able to
  // silently widen it. Everything except the hash must be byte-identical afterwards.
  it("changes ONLY the password — never role, status, team or company", async () => {
    const { member } = await makeTeamWithUsers();
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: member.id } });

    await resetPassword(testPrisma, { email: member.email, password: "another-pw-12" });

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: member.id } });
    expect({ ...after, passwordHash: "" }).toEqual({ ...before, passwordHash: "" });
    expect(after.role).toBe("MEMBER");
  });

  it("rejects a short password before touching the row, and an unknown email", async () => {
    const { admin } = await makeTeamWithUsers();
    const before = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });

    await expect(resetPassword(testPrisma, { email: admin.email, password: "short" })).rejects.toThrow(/at least 8/);
    await expect(resetPassword(testPrisma, { email: "", password: "valid-pw-1234" })).rejects.toThrow(/required/);
    await expect(
      resetPassword(testPrisma, { email: "nobody@test.local", password: "valid-pw-1234" }),
    ).rejects.toThrow(/no user with email/);

    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(after.passwordHash).toBe(before.passwordHash);
  });

  it("finds the login case-insensitively, as the operator will type it", async () => {
    const { admin } = await makeTeamWithUsers();
    await resetPassword(testPrisma, { email: admin.email.toUpperCase(), password: "cased-pw-1234" });
    const after = await testPrisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(await verifyPassword("cased-pw-1234", after.passwordHash)).toBe(true);
  });
});
