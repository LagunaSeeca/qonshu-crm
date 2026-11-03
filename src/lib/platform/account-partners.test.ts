import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { listAllAccountsForPartnerAssignment, setAccountPartner, PartnerNameHeldError } from "./account-partners";
import { listTakenPartnerKeys } from "@/lib/tenant/accounts";
import { makeTeam, makeUser, su as toSession, buildingKey } from "@/test/fixtures";

async function superAdmin(): Promise<SessionUser> {
  return toSession(await makeUser("SUPER_ADMIN"));
}

async function seedAccount(slug: string, accountName: string, partnerKey: string | null) {
  const team = await makeTeam({ name: `Team ${slug}` });
  const c = { id: team.companyId };
  const company = await testPrisma.company.update({ where: { id: c.id }, data: { name: `Co ${slug}` } });
  const u = await makeUser("COMPANY_ADMIN", team);
  const acc = await testPrisma.account.create({
    data: {
      companyId: c.id, teamId: team.id, buildingKey: buildingKey(accountName),
      name: accountName, accountManagerId: u.id,
      // A seeded key here means a CONFIRMED link. These tests are about the owner's
      // assignment surface; the PENDING state has its own suite
      // (src/lib/tenant/partner-link-approval.test.ts), and
      // listAllAccountsForPartnerAssignment deliberately reports a pending key as no key.
      ...(partnerKey ? { externalPartnerKey: partnerKey, partnerLinkConfirmedAt: new Date() } : {}),
    },
  });
  return { c: company, team, u, acc };
}

describe("listAllAccountsForPartnerAssignment", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("lists accounts across EVERY company for a SUPER_ADMIN (who has no companyId of their own)", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = await seedAccount(`zz-${ts}`, "Zulu Acct", "Komplex B");
    const b = await seedAccount(`aa-${ts}`, "Alpha Acct", null);

    const rows = await listAllAccountsForPartnerAssignment(testPrisma, await superAdmin());
    expect(rows.map((r) => r.id).sort()).toEqual([a.acc.id, b.acc.id].sort());
    const withKey = rows.find((r) => r.id === a.acc.id)!;
    expect(withKey.externalPartnerKey).toBe("Komplex B");
    expect(withKey.companyName).toBe(`Co zz-${ts}`);
    expect(rows.find((r) => r.id === b.acc.id)!.externalPartnerKey).toBeNull();
  });

  it("is forbidden for a COMPANY_ADMIN — it is a cross-tenant read", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { u } = await seedAccount(`ca-${ts}`, "Acct", null);
    await expect(
      listAllAccountsForPartnerAssignment(testPrisma, toSession(u)),
    ).rejects.toThrow(ForbiddenError);
  });
});

describe("listTakenPartnerKeys", () => {
  beforeEach(resetDb);

  it("collects claims from every company in one set, skipping unlinked accounts", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedAccount(`t1-${ts}`, "One", "Komplex B");
    await seedAccount(`t2-${ts}`, "Two", "Sabah.City");
    await seedAccount(`t3-${ts}`, "Three", null);

    const taken = await listTakenPartnerKeys(testPrisma);
    // NORMALIZED, not the stored spelling. The two link states do not store the same string — a
    // pending link holds the normalized building name while a confirmed one holds the upstream's
    // display spelling — so a raw-string set would call "Komplex B" unclaimed while an account
    // already had "komplex b" pending. Callers normalize the candidate before testing membership.
    expect(taken).toEqual(new Set(["komplex b", "sabah.city"]));
  });

  it("is empty when nothing is linked", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedAccount(`e1-${ts}`, "One", null);
    expect(await listTakenPartnerKeys(testPrisma)).toEqual(new Set());
  });
});

// setAccountPartner writes TWO things that must agree: the link and the audit row that says who
// wrote it (../tenant/partner-link-audit.ts). Separately, a failing audit insert would leave the
// link already persisted — exactly the "link with no audit row" state that module exists to
// prevent. (The third leg, a PartnerAllowlist grant, is gone with the allowlist itself.)
describe("setAccountPartner — link and audit are one unit", () => {
  let savedApiKey: string | undefined;
  let savedBaseUrl: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    savedBaseUrl = process.env.PARTNER_API_BASE_URL;
    process.env.PARTNER_API_KEY = "sk_live_global";
    process.env.PARTNER_API_BASE_URL = "https://partner.example.com";
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue({ partners: [{ name: "Komplex B", type: "RESIDENTIAL" }] });
  });
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY; else process.env.PARTNER_API_KEY = savedApiKey;
    if (savedBaseUrl === undefined) delete process.env.PARTNER_API_BASE_URL; else process.env.PARTNER_API_BASE_URL = savedBaseUrl;
  });
  afterAll(() => testPrisma.$disconnect());

  // CHANGED ON PURPOSE: this was "records the matching grant when a SUPER_ADMIN assigns an
  // UNGRANTED complex". There is no allowlist to grant into any more, so the contract is now
  // link + a durable audit row naming the actor, the account and the complex.
  it("links the complex and writes a PartnerLinkAudit row attributed to the acting super admin", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { c, acc } = await seedAccount(`assign-${ts}`, "Acct", null);
    const admin = await makeUser("SUPER_ADMIN");

    const out = await setAccountPartner(testPrisma, toSession(admin), acc.id, "Komplex B");

    expect(out.externalPartnerKey).toBe("Komplex B");
    const audit = await testPrisma.partnerLinkAudit.findMany({ where: { accountId: acc.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "assign", partnerName: "Komplex B", accountName: "Acct",
      companyId: c.id, actorId: admin.id, actorEmail: admin.email,
    });
  });

  it("refuses a name whose building another LEAD is already working (PartnerNameHeldError)", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { acc } = await seedAccount(`held-${ts}`, "Acct", null);
    const rival = await makeTeam({ name: `rival-${ts}` });
    const rivalUser = await makeUser("MEMBER", rival);
    const stage = await testPrisma.stage.create({ data: { companyId: rival.companyId, teamId: rival.id, name: "New", order: 0 } });
    await testPrisma.lead.create({
      data: {
        companyId: rival.companyId, teamId: rival.id, buildingKey: buildingKey("Komplex B"),
        title: "t", contactName: "c", companyName: "Komplex B", stageId: stage.id, ownerId: rivalUser.id,
      },
    });
    // Holder lives in a DIFFERENT company: findNameHolder is unscoped by design for the platform path.
    await expect(setAccountPartner(testPrisma, await superAdmin(), acc.id, "Komplex B"))
      .rejects.toThrow(PartnerNameHeldError);
    expect((await testPrisma.account.findUnique({ where: { id: acc.id } }))?.externalPartnerKey).toBeNull();
    expect(await testPrisma.partnerLinkAudit.count()).toBe(0);
  });

  it("names the complex in the CLEAR audit row — after the clear the column is the only other trace", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A link that PREDATES the audit: there is no earlier assign row to look back at, so if the
    // clear row doesn't name it, nothing anywhere records what this account was reading.
    const { acc } = await seedAccount(`clear-name-${ts}`, "Acct", "Komplex B");

    await setAccountPartner(testPrisma, await superAdmin(), acc.id, null);

    const [audit] = await testPrisma.partnerLinkAudit.findMany({ where: { accountId: acc.id } });
    expect(audit.action).toBe("clear");
    expect(audit.partnerName).toBe("Komplex B");
  });

  // A failing audit insert used to leave the link already written and return 500.
  function auditFailsOn(db: typeof testPrisma): typeof testPrisma {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: PrismaClient) => Promise<unknown>) =>
          target.$transaction((tx) => fn(new Proxy(tx as PrismaClient, {
            get(txTarget, txProp, txReceiver) {
              if (txProp !== "partnerLinkAudit") return Reflect.get(txTarget, txProp, txReceiver);
              return new Proxy(txTarget.partnerLinkAudit, {
                get(aTarget, aProp, aReceiver) {
                  if (aProp !== "create") return Reflect.get(aTarget, aProp, aReceiver);
                  return async () => { throw new Error("audit down"); };
                },
              });
            },
          }) as PrismaClient));
      },
    }) as typeof testPrisma;
  }

  it("rolls the ASSIGN back when the audit write fails — no link", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { acc } = await seedAccount(`atomic-assign-${ts}`, "Acct", null);

    await expect(setAccountPartner(auditFailsOn(testPrisma), await superAdmin(), acc.id, "Komplex B"))
      .rejects.toThrow("audit down");

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
  });

  it("rolls the CLEAR back when the audit write fails — the link is still there to clear again", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { acc } = await seedAccount(`atomic-clear-${ts}`, "Acct", "Komplex B");

    await expect(setAccountPartner(auditFailsOn(testPrisma), await superAdmin(), acc.id, null))
      .rejects.toThrow("audit down");

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
    expect(await testPrisma.partnerLinkAudit.count()).toBe(0);
  });
});
