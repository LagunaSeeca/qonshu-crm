import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";

describe("account schema", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates an account with workspace items and cascades on delete", async () => {
    const c = await testPrisma.company.create({ data: { name: "A", slug: "a-acct" } });
    const u = await testPrisma.user.create({ data: { companyId: c.id, email: "u@a.com", passwordHash: "x", name: "U", role: "MEMBER" } });
    const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner Co", accountManagerId: u.id, value: "5000" } });
    await testPrisma.accountActivity.create({ data: { companyId: c.id, accountId: acc.id, authorId: u.id, kind: "MEETING", body: "kickoff" } });
    await testPrisma.accountTask.create({ data: { companyId: c.id, accountId: acc.id, title: "send deck" } });
    await testPrisma.accountAsk.create({ data: { companyId: c.id, accountId: acc.id, title: "need API key", authorId: u.id } });
    expect(acc.status).toBe("ACTIVE");
    expect(Number(acc.value)).toBe(5000);
    await testPrisma.account.delete({ where: { id: acc.id } });
    expect(await testPrisma.accountActivity.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.accountTask.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await testPrisma.accountAsk.count({ where: { accountId: acc.id } })).toBe(0);
  });
});
