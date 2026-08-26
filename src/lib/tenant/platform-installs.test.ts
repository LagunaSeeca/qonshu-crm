import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getAccountInstallSnapshots, upsertInstallSnapshot } from "./platform-installs";
import { NotFoundError } from "@/lib/auth/guards";
import type { SessionUser } from "@/lib/auth/guards";

// Manual, LOCAL-only install-count entries (no partner-API call) — one row per account per
// day, editing the same day overwrites via the [accountId, capturedOn] unique key.

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "Co", slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
  });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, u, acc, user };
}

describe("platform install snapshots", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("upsertInstallSnapshot creates a new snapshot for a given day", async () => {
    const { acc, user } = await setup("pi-create");
    const capturedOn = new Date("2026-07-01");
    const snap = await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn, iosInstalls: 5, androidInstalls: 3 });

    expect(snap.accountId).toBe(acc.id);
    expect(snap.iosInstalls).toBe(5);
    expect(snap.androidInstalls).toBe(3);
    expect(snap.createdById).toBe(user.id);
  });

  it("upsertInstallSnapshot overwrites (not duplicates) the same [accountId, capturedOn] day", async () => {
    const { acc, user } = await setup("pi-upsert");
    const capturedOn = new Date("2026-07-01");
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn, iosInstalls: 5, androidInstalls: 3 });
    const second = await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn, iosInstalls: 9, androidInstalls: 4 });

    const all = await getAccountInstallSnapshots(testPrisma, user, acc.id);
    expect(all).toHaveLength(1); // overwritten, not appended
    expect(all[0].id).toBe(second.id);
    expect(all[0].iosInstalls).toBe(9);
    expect(all[0].androidInstalls).toBe(4);
  });

  it("upsertInstallSnapshot creates a distinct row for a different day on the same account", async () => {
    const { acc, user } = await setup("pi-distinct-days");
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-01"), iosInstalls: 1, androidInstalls: 1 });
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-02"), iosInstalls: 2, androidInstalls: 2 });

    const all = await getAccountInstallSnapshots(testPrisma, user, acc.id);
    expect(all).toHaveLength(2);
  });

  it("getAccountInstallSnapshots lists snapshots ordered by capturedOn ascending", async () => {
    const { acc, user } = await setup("pi-order");
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-15"), iosInstalls: 1, androidInstalls: 0 });
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-01"), iosInstalls: 2, androidInstalls: 0 });
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-10"), iosInstalls: 3, androidInstalls: 0 });

    const all = await getAccountInstallSnapshots(testPrisma, user, acc.id);
    expect(all.map((s) => s.capturedOn.toISOString().slice(0, 10))).toEqual([
      "2026-07-01", "2026-07-10", "2026-07-15",
    ]);
  });

  it("upsertInstallSnapshot throws NotFoundError for a foreign (cross-tenant) account", async () => {
    const { acc } = await setup("pi-x1");
    const other = await setup("pi-x2");
    await expect(
      upsertInstallSnapshot(testPrisma, other.user, acc.id, { capturedOn: new Date("2026-07-01"), iosInstalls: 1, androidInstalls: 1 }),
    ).rejects.toThrow(NotFoundError);
  });

  it("getAccountInstallSnapshots throws NotFoundError for a foreign (cross-tenant) account", async () => {
    const { acc, user } = await setup("pi-x3");
    await upsertInstallSnapshot(testPrisma, user, acc.id, { capturedOn: new Date("2026-07-01"), iosInstalls: 1, androidInstalls: 1 });
    const other = await setup("pi-x4");
    await expect(getAccountInstallSnapshots(testPrisma, other.user, acc.id)).rejects.toThrow(NotFoundError);
  });

  it("isolates snapshots across tenants even with matching capturedOn dates", async () => {
    const { acc: accA, user: userA } = await setup("pi-tenA");
    const { acc: accB, user: userB } = await setup("pi-tenB");
    const day = new Date("2026-07-01");
    await upsertInstallSnapshot(testPrisma, userA, accA.id, { capturedOn: day, iosInstalls: 10, androidInstalls: 10 });
    await upsertInstallSnapshot(testPrisma, userB, accB.id, { capturedOn: day, iosInstalls: 99, androidInstalls: 99 });

    const listA = await getAccountInstallSnapshots(testPrisma, userA, accA.id);
    expect(listA).toHaveLength(1);
    expect(listA[0].iosInstalls).toBe(10);
  });
});
