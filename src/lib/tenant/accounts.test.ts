import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { createAccount, createAccountWithLogin, listAccounts, getAccount, convertLeadToAccount, AlreadyConvertedError } from "./accounts";
import { verifyPassword } from "@/lib/auth/password";
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

describe("createAccountWithLogin", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("without partnerLogin creates just the account", async () => {
    const { user } = await setup("a-cwl-none");
    const { account, partnerUser } = await createAccountWithLogin(testPrisma, user, { name: "Solo Partner" });
    expect(account.name).toBe("Solo Partner");
    expect(partnerUser).toBeNull();
    expect(await testPrisma.user.count({ where: { accountId: account.id } })).toBe(0);
  });

  it("with a partnerLogin creates both the account and a scoped PARTNER_VIEWER user", async () => {
    const { user } = await setup("a-cwl-both");
    const email = `partner-${Date.now()}@a.com`;
    const { account, partnerUser } = await createAccountWithLogin(testPrisma, user, {
      name: "Duo Partner",
      partnerLogin: { name: "Partner Contact", email, password: "pw123456" },
    });
    expect(account.name).toBe("Duo Partner");
    expect(partnerUser).not.toBeNull();
    expect(partnerUser!.role).toBe("PARTNER_VIEWER");
    expect(partnerUser!.accountId).toBe(account.id);
    expect(partnerUser!.companyId).toBe(user.companyId);
    expect(partnerUser!.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", partnerUser!.passwordHash)).toBe(true);
  });

  it("rejects a duplicate partner login email", async () => {
    const { user } = await setup("a-cwl-dup");
    const email = `dup-partner-${Date.now()}@a.com`;
    await createAccountWithLogin(testPrisma, user, {
      name: "First Partner",
      partnerLogin: { name: "P1", email, password: "pw123456" },
    });
    await expect(
      createAccountWithLogin(testPrisma, user, {
        name: "Second Partner",
        partnerLogin: { name: "P2", email, password: "pw123456" },
      }),
    ).rejects.toThrow();
    // the transaction must roll back the second account too — not left as an orphan
    expect(await testPrisma.account.count({ where: { name: "Second Partner" } })).toBe(0);
  });
});
