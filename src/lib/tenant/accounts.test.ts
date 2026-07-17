import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { createAccount, listAccounts, getAccount, convertLeadToAccount, AlreadyConvertedError } from "./accounts";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  await seedDefaultStages(testPrisma, c.id);
  const stages = await listStages(testPrisma, { companyId: c.id });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "MEMBER" } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return { c, stages, user };
}

describe("accounts", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates and lists accounts; cross-tenant getAccount is null", async () => {
    const A = await setup("a-acs");
    const acc = await createAccount(testPrisma, A.user, { name: "Partner" });
    expect((await listAccounts(testPrisma, A.user)).length).toBe(1);
    const B = await setup("b-acs");
    expect(await getAccount(testPrisma, B.user, acc.id)).toBeNull();
  });

  it("converts a WON lead, carries fields, links sourceLeadId, keeps lead, blocks double-convert", async () => {
    const { stages, user } = await setup("a-conv");
    const won = stages.find((s) => s.type === "WON")!;
    const lead = await createLead(testPrisma, user, { title: "BigCo deal", contactName: "Jane", companyName: "BigCo", stageId: stages[0].id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await convertLeadToAccount(testPrisma, user, lead.id);
    expect(acc.name).toBe("BigCo");
    expect(acc.sourceLeadId).toBe(lead.id);
    expect(await testPrisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    await expect(convertLeadToAccount(testPrisma, user, lead.id)).rejects.toThrow(AlreadyConvertedError);
  });

  it("rejects converting a non-WON lead", async () => {
    const { stages, user } = await setup("a-notwon");
    const lead = await createLead(testPrisma, user, { title: "Open deal", contactName: "C", stageId: stages[0].id });
    await expect(convertLeadToAccount(testPrisma, user, lead.id)).rejects.toThrow();
  });
});
