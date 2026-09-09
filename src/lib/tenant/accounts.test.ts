import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { createAccount, createAccountWithLogin, listAccounts, getAccount, isPartnerKeyConflict } from "./accounts";
import { convertLeadToAccount } from "./lead-conversion";
import { verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/guards";

// Account creation attempts an allowlist auto-link. Nothing here grants a complex to anything, so
// every account below stays unlinked — and the lookup is a local table, so no network is involved
// either way. The client stays mocked to catch a regression that reintroduces the HTTP call.
// (The auto-link behaviour itself is covered in lead-conversion.test.ts.)
vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn(async () => ({ partners: [] })) }));

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

  it("converts a WON lead, carries fields, links sourceLeadId, keeps lead, never double-converts", async () => {
    const { stages, user } = await setup("a-conv");
    const won = stages.find((s) => s.type === "WON")!;
    const lead = await createLead(testPrisma, user, { title: "BigCo deal", contactName: "Jane", companyName: "BigCo", stageId: stages[0].id });
    // The move to Won already converts; the explicit call is the manual button on top of it.
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const { account: acc, created } = await convertLeadToAccount(testPrisma, user, lead.id);
    expect(acc.name).toBe("BigCo");
    expect(acc.sourceLeadId).toBe(lead.id);
    expect(created).toBe(false); // reused the auto-created account, not a second one
    expect(await testPrisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
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

// The DB backstop. Both claim paths (auto-link, the SUPER_ADMIN assign) read-then-write, so on
// their own they are racy: two concurrent creates for one complex can both pass their check and
// both insert. `@@unique([externalPartnerKey])` is what actually makes that impossible.
describe("Account.externalPartnerKey is unique platform-wide", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  async function grant(companyId: string, partnerName: string) {
    return testPrisma.partnerAllowlist.create({
      data: { companyId, partnerName, normalizedName: partnerName.trim().toLowerCase() },
    });
  }

  it("rejects a second account claiming one complex, even from a DIFFERENT company", async () => {
    const A = await setup("uniq-a");
    const B = await setup("uniq-b");
    await testPrisma.account.create({
      data: { companyId: A.c.id, name: "Holder", accountManagerId: A.user.id, externalPartnerKey: "Komplex B" },
    });

    // The whole point of the constraint: cross-tenant, not just within one company, because one
    // shared X-API-Key means both accounts would read the SAME complex's debt, payments and
    // unit-level owner names/phones.
    const second = testPrisma.account.create({
      data: { companyId: B.c.id, name: "Thief", accountManagerId: B.user.id, externalPartnerKey: "Komplex B" },
    });
    await expect(second).rejects.toMatchObject({ code: "P2002" });
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("still allows any number of UNLINKED accounts — Postgres ignores NULLs in a unique index", async () => {
    const { user } = await setup("uniq-nulls");
    await createAccount(testPrisma, user, { name: "One" });
    await createAccount(testPrisma, user, { name: "Two" });
    await createAccount(testPrisma, user, { name: "Three" });
    expect(await testPrisma.account.count({ where: { externalPartnerKey: null } })).toBe(3);
  });

  it("two concurrent creates for one granted complex produce exactly ONE link, and both accounts", async () => {
    const { user } = await setup("race-concurrent");
    await grant(user.companyId!, "Komplex B");

    // Whichever guard fires — the app-level isPartnerKeyTaken pre-check or the DB constraint
    // behind it — the observable invariant is the same and is what actually matters: one complex,
    // one link, and neither account creation failed. The next test pins the constraint branch
    // specifically, since this one usually resolves on the pre-check.
    const [a, b] = await Promise.all([
      createAccount(testPrisma, user, { name: "Komplex B" }),
      createAccount(testPrisma, user, { name: "Komplex B" }),
    ]);

    expect(await testPrisma.account.count({ where: { companyId: user.companyId! } })).toBe(2);
    const linked = [a, b].filter((x) => x.externalPartnerKey === "Komplex B");
    const unlinked = [a, b].filter((x) => x.externalPartnerKey === null);
    expect(linked).toHaveLength(1);
    expect(unlinked).toHaveLength(1);
    // ...and exactly one audit row, for the account that actually got the link.
    const audit = await testPrisma.accountActivity.findMany({ where: { outcome: "partner_link:auto_link" } });
    expect(audit).toHaveLength(1);
    expect(audit[0].accountId).toBe(linked[0].id);
  });

  it("absorbs a claim that lands INSIDE the check-then-act window: created, unlinked, no audit row", async () => {
    const { user } = await setup("race-p2002");
    await grant(user.companyId!, "Komplex B");

    // Deterministic stand-in for the interleaving no application-level check can prevent: the
    // rival claim commits AFTER resolveUnclaimedPartnerKey() reported the complex free and BEFORE
    // our own insert runs. Only @@unique([externalPartnerKey]) can catch this.
    let rivalClaimed = false;
    const racingDb = new Proxy(testPrisma, {
      get(target, prop, receiver) {
        if (prop !== "account") return Reflect.get(target, prop, receiver);
        return new Proxy(target.account, {
          get(accTarget, accProp, accReceiver) {
            if (accProp !== "create") return Reflect.get(accTarget, accProp, accReceiver);
            return async (args: Parameters<typeof testPrisma.account.create>[0]) => {
              if (!rivalClaimed) {
                rivalClaimed = true;
                await testPrisma.account.create({
                  data: {
                    companyId: user.companyId!, name: "Rival", accountManagerId: user.id,
                    externalPartnerKey: "Komplex B",
                  },
                });
              }
              return testPrisma.account.create(args);
            };
          },
        });
      },
    }) as typeof testPrisma;

    const acc = await createAccount(racingDb, user, { name: "Komplex B" });

    // The account exists — a lost auto-link race must never fail a creation.
    expect(acc.name).toBe("Komplex B");
    expect(acc.externalPartnerKey).toBeNull();
    // ...the rival keeps the sole claim...
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
    // ...and no audit row was written for a link that never happened.
    expect(await testPrisma.accountActivity.count({ where: { outcome: "partner_link:auto_link" } })).toBe(0);
  });

  // The SAME lost race, but through createAccountWithLogin — which ALWAYS opens a
  // db.$transaction, partnerLogin or not. That changes what recovery is even possible: on
  // Postgres a failed statement aborts the WHOLE transaction and Prisma issues no savepoints, so
  // retrying just the insert inside it dies with "current transaction is aborted" (a
  // DriverAdapterError with no .code, which falls through errorResponse to a 500) and rolls the
  // account back entirely. The recovery therefore has to restart the TRANSACTION, not the
  // statement. Two admins of a granted company posting the same account name at the same moment
  // is exactly this interleaving.
  it("absorbs the same claim through createAccountWithLogin's transaction: account + login, unlinked", async () => {
    const { user } = await setup("race-tx");
    await grant(user.companyId!, "Komplex B");

    // Same deterministic rival as above, except the account.create it has to sit in front of is
    // the one on the TRANSACTION handle Prisma builds internally — so the hook goes on
    // $transaction and wraps the tx it hands the callback. The rival commits on its own
    // connection, so our still-open transaction really does lose the race.
    let rivalClaimed = false;
    const withRival = (tx: PrismaClient): PrismaClient => new Proxy(tx, {
      get(txTarget, txProp, txReceiver) {
        if (txProp !== "account") return Reflect.get(txTarget, txProp, txReceiver);
        return new Proxy(txTarget.account, {
          get(accTarget, accProp, accReceiver) {
            if (accProp !== "create") return Reflect.get(accTarget, accProp, accReceiver);
            return async (args: Parameters<typeof testPrisma.account.create>[0]) => {
              if (!rivalClaimed) {
                rivalClaimed = true;
                await testPrisma.account.create({
                  data: {
                    companyId: user.companyId!, name: "Rival", accountManagerId: user.id,
                    externalPartnerKey: "Komplex B",
                  },
                });
              }
              return txTarget.account.create(args);
            };
          },
        });
      },
    }) as PrismaClient;

    const racingDb = new Proxy(testPrisma, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: PrismaClient) => Promise<unknown>) =>
          target.$transaction((tx) => fn(withRival(tx as PrismaClient)));
      },
    }) as typeof testPrisma;

    const email = `race-tx-${Date.now()}@a.com`;
    const { account, partnerUser } = await createAccountWithLogin(racingDb, user, {
      name: "Komplex B",
      partnerLogin: { name: "P", email, password: "pw123456" },
    });

    // Degraded to created-but-unlinked — never to a 500 and never to a missing account...
    expect(account.externalPartnerKey).toBeNull();
    // ...and the rest of the transaction still happened exactly once.
    expect(partnerUser).not.toBeNull();
    expect(await testPrisma.user.count({ where: { accountId: account.id } })).toBe(1);
    expect(await testPrisma.account.count({ where: { name: "Komplex B" } })).toBe(1);
    // The rival keeps the sole claim, and no audit row exists for a link that never happened.
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
    expect(await testPrisma.accountActivity.count({ where: { outcome: "partner_link:auto_link" } })).toBe(0);
  });

  it("a P2002 on externalPartnerKey is distinguishable from one on sourceLeadId, in BOTH Prisma error shapes", async () => {
    const known = (meta: Record<string, unknown>) =>
      new Prisma.PrismaClientKnownRequestError("dup", { code: "P2002", clientVersion: "test", meta });

    // Classic engine shape.
    expect(isPartnerKeyConflict(known({ target: ["externalPartnerKey"] }))).toBe(true);
    expect(isPartnerKeyConflict(known({ target: ["sourceLeadId"] }))).toBe(false);

    // The shape this app ACTUALLY gets, from the pg driver adapter — note the embedded quotes and
    // the field buried under driverAdapterError, which is why this check reads the whole meta.
    const adapterShape = (field: string) => ({
      modelName: "Account",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint: { fields: [`"${field}"`] },
        },
      },
    });
    expect(isPartnerKeyConflict(known(adapterShape("externalPartnerKey")))).toBe(true);
    expect(isPartnerKeyConflict(known(adapterShape("sourceLeadId")))).toBe(false);

    expect(isPartnerKeyConflict(new Error("nope"))).toBe(false);
  });
});
