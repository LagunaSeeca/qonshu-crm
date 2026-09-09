import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import {
  normalizePartnerName,
  resolveAllowlistedPartner,
  findAllowlistEntryByName,
  listPartnerAllowlist,
  grantPartnerToCompany,
  revokePartnerAllowlistEntry,
  PartnerAllowlistConflictError,
  PartnerAllowlistLinkConflictError,
} from "./partner-allowlist";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";

const su: SessionUser = { id: "su", companyId: null, role: "SUPER_ADMIN" };

async function company(slug: string) {
  return testPrisma.company.create({ data: { name: `Co ${slug}`, slug } });
}

describe("normalizePartnerName", () => {
  it("trims and lowercases — one definition of 'the same complex' for the whole app", () => {
    expect(normalizePartnerName("  Sabah.CITY  ")).toBe("sabah.city");
    expect(normalizePartnerName("Komplex B")).toBe("komplex b");
    expect(normalizePartnerName("   ")).toBe("");
  });
});

describe("resolveAllowlistedPartner — the auto-link authorization decision", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns the EXACT granted name for the granted company, matched case-insensitively", async () => {
    const c = await company(`al-hit-${Date.now()}`);
    await grantPartnerToCompany(testPrisma, su, "Sabah.City", c.id);
    // The exact stored casing comes back, because that string is what gets sent upstream as
    // `?partner=` and persisted to Account.externalPartnerKey.
    expect(await resolveAllowlistedPartner(testPrisma, c.id, "  sabah.CITY ")).toBe("Sabah.City");
  });

  it("returns null for a company that was NOT granted the complex — identical to an unknown name", async () => {
    const owner = await company(`al-own-${Date.now()}`);
    const other = await company(`al-other-${Date.now()}`);
    await grantPartnerToCompany(testPrisma, su, "Komplex B", owner.id);

    const wrongCompany = await resolveAllowlistedPartner(testPrisma, other.id, "Komplex B");
    const unknownName = await resolveAllowlistedPartner(testPrisma, other.id, "Never Heard Of It");
    expect(wrongCompany).toBeNull();
    // Same value, so no caller can tell "exists, but not yours" from "does not exist" — this is
    // the property that kills the enumeration oracle.
    expect(wrongCompany).toBe(unknownName);
  });

  it("returns null for an empty or whitespace-only name rather than matching anything", async () => {
    const c = await company(`al-empty-${Date.now()}`);
    expect(await resolveAllowlistedPartner(testPrisma, c.id, "   ")).toBeNull();
  });
});

describe("partner allowlist management", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("refuses every entry point to a non-SUPER_ADMIN", async () => {
    const c = await company(`al-role-${Date.now()}`);
    const admin: SessionUser = { id: "u1", companyId: c.id, role: "COMPANY_ADMIN" };
    await expect(listPartnerAllowlist(testPrisma, admin)).rejects.toThrow(ForbiddenError);
    await expect(grantPartnerToCompany(testPrisma, admin, "Komplex B", c.id)).rejects.toThrow(ForbiddenError);
    await expect(revokePartnerAllowlistEntry(testPrisma, admin, "whatever")).rejects.toThrow(ForbiddenError);
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);
  });

  it("grants, lists with the owning company, and records who granted it", async () => {
    const c = await company(`al-grant-${Date.now()}`);
    const row = await grantPartnerToCompany(testPrisma, su, "  Komplex B  ", c.id);
    expect(row.partnerName).toBe("Komplex B"); // trimmed on the way in
    expect(row.companyId).toBe(c.id);

    const stored = await testPrisma.partnerAllowlist.findUniqueOrThrow({ where: { id: row.id } });
    expect(stored.normalizedName).toBe("komplex b");
    expect(stored.createdById).toBe(su.id);

    const list = await listPartnerAllowlist(testPrisma, su);
    expect(list).toHaveLength(1);
    expect(list[0].companyName).toBe(c.name);
  });

  it("refuses to grant a complex that is already granted, however it is cased", async () => {
    const a = await company(`al-conf-a-${Date.now()}`);
    const b = await company(`al-conf-b-${Date.now()}`);
    await grantPartnerToCompany(testPrisma, su, "Komplex B", a.id);
    await expect(grantPartnerToCompany(testPrisma, su, "komplex b", b.id))
      .rejects.toThrow(PartnerAllowlistConflictError);
    // The original grant still stands — a second grant must never silently re-point a complex.
    const entry = await findAllowlistEntryByName(testPrisma, "KOMPLEX B");
    expect(entry?.companyId).toBe(a.id);
    expect(await testPrisma.partnerAllowlist.count()).toBe(1);
  });

  // A live link is a stronger fact than a grant — that account is already reading the complex —
  // so a grant elsewhere would leave the two permanently contradicting each other. setAccountPartner
  // now records a grant for every link it writes, so this fires for links that predate that.
  it("refuses to grant a complex an account in ANOTHER company is already linked to", async () => {
    const holder = await company(`al-link-a-${Date.now()}`);
    const outsider = await company(`al-link-b-${Date.now()}`);
    const u = await testPrisma.user.create({
      data: { companyId: holder.id, email: `link-${Date.now()}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" },
    });
    await testPrisma.account.create({
      data: { companyId: holder.id, name: "Holder", accountManagerId: u.id, externalPartnerKey: "Komplex B" },
    });

    // Case-insensitive: "the same complex" is normalizePartnerName's definition everywhere else.
    await expect(grantPartnerToCompany(testPrisma, su, "komplex b", outsider.id))
      .rejects.toThrow(PartnerAllowlistLinkConflictError);
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);

    // ...but granting it to the company that actually HOLDS the link is exactly right.
    const row = await grantPartnerToCompany(testPrisma, su, "Komplex B", holder.id);
    expect(row.companyId).toBe(holder.id);
  });

  it("refuses to grant to a company that does not exist", async () => {
    await expect(grantPartnerToCompany(testPrisma, su, "Komplex B", "no-such-company"))
      .rejects.toThrow(NotFoundError);
    expect(await testPrisma.partnerAllowlist.count()).toBe(0);
  });

  it("revokes a grant, and 404s an unknown id", async () => {
    const c = await company(`al-rev-${Date.now()}`);
    const row = await grantPartnerToCompany(testPrisma, su, "Komplex B", c.id);
    await revokePartnerAllowlistEntry(testPrisma, su, row.id);
    expect(await resolveAllowlistedPartner(testPrisma, c.id, "Komplex B")).toBeNull();
    await expect(revokePartnerAllowlistEntry(testPrisma, su, row.id)).rejects.toThrow(NotFoundError);
  });
});
