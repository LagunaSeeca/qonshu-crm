import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";

vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));

import { fetchPartners } from "@/lib/partner-api/client";
import { listAllAccountsForPartnerAssignment, setAccountPartner } from "./account-partners";
import { findAllowlistEntryByName } from "./partner-allowlist";
import { listTakenPartnerKeys } from "@/lib/tenant/accounts";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };

async function seedAccount(slug: string, accountName: string, partnerKey: string | null) {
  const c = await testPrisma.company.create({ data: { name: `Co ${slug}`, slug } });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
  });
  const acc = await testPrisma.account.create({
    data: { companyId: c.id, name: accountName, accountManagerId: u.id, externalPartnerKey: partnerKey },
  });
  return { c, u, acc };
}

describe("listAllAccountsForPartnerAssignment", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("lists accounts across EVERY company for a SUPER_ADMIN (who has no companyId of their own)", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = await seedAccount(`zz-${ts}`, "Zulu Acct", "Komplex B");
    const b = await seedAccount(`aa-${ts}`, "Alpha Acct", null);

    const rows = await listAllAccountsForPartnerAssignment(testPrisma, su);
    expect(rows.map((r) => r.id).sort()).toEqual([a.acc.id, b.acc.id].sort());
    const withKey = rows.find((r) => r.id === a.acc.id)!;
    expect(withKey.externalPartnerKey).toBe("Komplex B");
    expect(withKey.companyName).toBe(`Co zz-${ts}`);
    expect(rows.find((r) => r.id === b.acc.id)!.externalPartnerKey).toBeNull();
  });

  it("is forbidden for a COMPANY_ADMIN — it is a cross-tenant read", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { c, u } = await seedAccount(`ca-${ts}`, "Acct", null);
    await expect(
      listAllAccountsForPartnerAssignment(testPrisma, { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" }),
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
    expect(taken).toEqual(new Set(["Komplex B", "Sabah.City"]));
  });

  it("is empty when nothing is linked", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await seedAccount(`e1-${ts}`, "One", null);
    expect(await listTakenPartnerKeys(testPrisma)).toEqual(new Set());
  });
});

// setAccountPartner writes THREE things that must agree: the link, the audit row that says who
// wrote it (../tenant/partner-link-audit.ts), and the allowlist grant that says who is entitled to
// it (./partner-allowlist.ts). Separately, each of the last two could fail with the link already
// persisted — leaving exactly the "link with no audit row" / "link with no grant" states the two
// modules exist to prevent.
describe("setAccountPartner — link, grant and audit are one unit", () => {
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

  it("records the matching grant when a SUPER_ADMIN assigns an UNGRANTED complex", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { c, acc } = await seedAccount(`grant-auto-${ts}`, "Acct", null);

    await setAccountPartner(testPrisma, su, acc.id, "Komplex B");

    // Every live link now has a grant behind it, so the allowlist card is a complete inventory
    // and grantPartnerToCompany can see this complex is spoken for.
    const entry = await findAllowlistEntryByName(testPrisma, "Komplex B");
    expect(entry?.companyId).toBe(c.id);
    expect(entry?.partnerName).toBe("Komplex B");
    expect(entry?.createdById).toBe(su.id);
  });

  it("does not duplicate a grant the account's own company already holds", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { c, acc } = await seedAccount(`grant-dup-${ts}`, "Acct", null);
    await testPrisma.partnerAllowlist.create({
      data: { companyId: c.id, partnerName: "Komplex B", normalizedName: "komplex b" },
    });

    await setAccountPartner(testPrisma, su, acc.id, "Komplex B");
    expect(await testPrisma.partnerAllowlist.count()).toBe(1);
  });

  it("names the complex in the CLEAR audit row — after the clear the column is the only other trace", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // A link that PREDATES the audit: there is no earlier assign row to look back at, so if the
    // clear row doesn't name it, nothing anywhere records what this account was reading.
    const { acc } = await seedAccount(`clear-name-${ts}`, "Acct", "Komplex B");

    await setAccountPartner(testPrisma, su, acc.id, null);

    const [audit] = await testPrisma.accountActivity.findMany({ where: { accountId: acc.id } });
    expect(audit.outcome).toBe("partner_link:clear");
    expect(audit.body).toContain("Komplex B");
  });

  // A failing audit insert used to leave the link already written and return 500.
  function auditFailsOn(db: typeof testPrisma): typeof testPrisma {
    return new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: PrismaClient) => Promise<unknown>) =>
          target.$transaction((tx) => fn(new Proxy(tx as PrismaClient, {
            get(txTarget, txProp, txReceiver) {
              if (txProp !== "accountActivity") return Reflect.get(txTarget, txProp, txReceiver);
              return new Proxy(txTarget.accountActivity, {
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

  it("rolls the ASSIGN back when the audit write fails — no link, and no grant either", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { acc } = await seedAccount(`atomic-assign-${ts}`, "Acct", null);

    await expect(setAccountPartner(auditFailsOn(testPrisma), su, acc.id, "Komplex B"))
      .rejects.toThrow("audit down");

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBeNull();
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);
  });

  it("rolls the CLEAR back when the audit write fails — the link is still there to clear again", async () => {
    const ts = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { acc } = await seedAccount(`atomic-clear-${ts}`, "Acct", "Komplex B");

    await expect(setAccountPartner(auditFailsOn(testPrisma), su, acc.id, null))
      .rejects.toThrow("audit down");

    const row = await testPrisma.account.findUnique({ where: { id: acc.id } });
    expect(row?.externalPartnerKey).toBe("Komplex B");
    expect(await testPrisma.accountActivity.count()).toBe(0);
  });
});
