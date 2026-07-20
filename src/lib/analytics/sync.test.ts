import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { MockPartnerAnalyticsSource, type PartnerAnalyticsSource, type SourceContext } from "./source";
import { syncAccountAnalytics } from "./sync";

async function acct(externalPartnerKey?: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug: "a-sy" } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "P", accountManagerId: u.id, externalPartnerKey: externalPartnerKey ?? null } });
  return { c, acc };
}

// Records the context the sync layer hands the source — proves each account is fetched with
// ITS OWN mapping key, which is what keeps one partner's data off another partner's account.
class SpySource implements PartnerAnalyticsSource {
  seen: SourceContext[] = [];
  async fetchUsers(ctx: SourceContext) { this.seen.push(ctx); return []; }
  async fetchPayments(ctx: SourceContext) { this.seen.push(ctx); return []; }
}
describe("syncAccountAnalytics", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());
  it("populates users + payments idempotently", async () => {
    const { c, acc } = await acct();
    const src = new MockPartnerAnalyticsSource();
    const r1 = await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    expect(r1.users).toBeGreaterThan(0);
    expect(r1.payments).toBeGreaterThan(0);
    const usersAfter1 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    await syncAccountAnalytics(testPrisma, acc.id, c.id, src);
    const usersAfter2 = await testPrisma.partnerAppUser.count({ where: { accountId: acc.id } });
    expect(usersAfter2).toBe(usersAfter1); // no duplicate externalIds
  });

  it("feeds the source THIS account's own externalPartnerKey (per-partner isolation)", async () => {
    const { c, acc } = await acct("acme-corp"); // the manually-entered partner name
    const spy = new SpySource();
    await syncAccountAnalytics(testPrisma, acc.id, c.id, spy);
    expect(spy.seen.length).toBeGreaterThan(0);
    for (const ctx of spy.seen) {
      expect(ctx.accountId).toBe(acc.id);
      expect(ctx.externalKey).toBe("acme-corp"); // never another partner's key
    }
  });

  it("passes null externalKey when the account isn't linked yet (fail closed, not cross-partner)", async () => {
    const { c, acc } = await acct(); // no key set
    const spy = new SpySource();
    await syncAccountAnalytics(testPrisma, acc.id, c.id, spy);
    expect(spy.seen.every((ctx) => ctx.externalKey === null)).toBe(true);
  });
});
