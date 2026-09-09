import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { seedDefaultStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { convertLeadToAccount } from "./lead-conversion";
import { createAccountWithLogin } from "./accounts";
import type { PartnerListResponse } from "@/lib/partner-api/schema";
import type { SessionUser } from "@/lib/auth/guards";

// Auto-link no longer consults the external Partner API at all — authorization comes from the
// SUPER_ADMIN-managed allowlist, which is a local table. The client stays mocked so a regression
// that reintroduces the network call is caught rather than silently reaching out, and so the
// "never calls the Partner API" assertions below have something to observe.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));
import { fetchPartners } from "@/lib/partner-api/client";

function partners(...names: string[]): PartnerListResponse {
  return { partners: names.map((name) => ({ name, type: "RESIDENTIAL" as const })) };
}

// Grants a complex to a company — the ONLY thing that makes auto-link possible. Mirrors what
// grantPartnerToCompany() writes (exact name + trimmed/lowercased lookup column).
async function grant(companyId: string, partnerName: string) {
  return testPrisma.partnerAllowlist.create({
    data: { companyId, partnerName, normalizedName: partnerName.trim().toLowerCase() },
  });
}

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  await seedDefaultStages(testPrisma, c.id);
  const stages = await listStages(testPrisma, { companyId: c.id });
  const u = await testPrisma.user.create({
    data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "MEMBER" },
  });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "MEMBER" };
  return {
    c, user,
    open: stages.find((s) => s.type === "OPEN")!,
    won: stages.find((s) => s.type === "WON")!,
    lost: stages.find((s) => s.type === "LOST")!,
  };
}

describe("auto-convert on WON", () => {
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = "sk_test_shared";
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue(partners());
  });
  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
    await testPrisma.$disconnect();
  });

  it("creates exactly one account when a lead moves into Won, and leaves the lead in Won", async () => {
    const { user, open, won } = await setup("lc-won");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "Jane", companyName: "BigCo",
      email: "j@big.co", phone: "555", stageId: open.id,
    });

    const moved = await moveLeadStage(testPrisma, user, lead.id, won.id);

    expect(moved.lead.stageId).toBe(won.id);
    expect(moved.autoConverted).toBe(true);
    const accounts = await testPrisma.account.findMany({ where: { sourceLeadId: lead.id } });
    expect(accounts.length).toBe(1);
    expect(accounts[0].name).toBe("BigCo");
    expect(accounts[0].primaryContactName).toBe("Jane");
    expect(accounts[0].primaryContactEmail).toBe("j@big.co");
    expect(accounts[0].companyId).toBe(user.companyId);
    // The lead is NOT archived or deleted — it stays on the board in Won.
    expect(await testPrisma.lead.findUnique({ where: { id: lead.id } })).not.toBeNull();
  });

  it("does NOT create a second account when the lead moves out of Won and back in", async () => {
    const { user, open, won } = await setup("lc-back");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "RoundTrip", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const first = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    await moveLeadStage(testPrisma, user, lead.id, open.id);
    await moveLeadStage(testPrisma, user, lead.id, won.id);

    const accounts = await testPrisma.account.findMany({ where: { sourceLeadId: lead.id } });
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).toBe(first.id);
  });

  it("does not convert on a move to a non-WON stage", async () => {
    const { user, open, lost } = await setup("lc-lost");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, lost.id);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
  });

  it("manual convert after auto-convert is idempotent — same account, created=false", async () => {
    const { user, open, won } = await setup("lc-manual");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Manual Co", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const auto = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    const a = await convertLeadToAccount(testPrisma, user, lead.id);
    const b = await convertLeadToAccount(testPrisma, user, lead.id);

    expect(a.created).toBe(false);
    expect(a.account.id).toBe(auto.id);
    expect(b.account.id).toBe(auto.id);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
  });

  it("keeps the stage move even when account creation fails", async () => {
    const { user, open, won } = await setup("lc-fail");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Broken Co", stageId: open.id });
    // Account.sourceLeadId is globally @unique, so an account in ANOTHER tenant already claiming
    // this lead id makes the insert fail with P2002 while the in-tenant lookup still finds
    // nothing — i.e. the conversion genuinely throws mid-move.
    const other = await setup("lc-fail-other");
    await testPrisma.account.create({
      data: { companyId: other.c.id, name: "Squatter", accountManagerId: other.user.id, sourceLeadId: lead.id },
    });

    const moved = await moveLeadStage(testPrisma, user, lead.id, won.id);

    // The stage move stands on its own — the lead is in Won, not stuck.
    expect(moved.lead.stageId).toBe(won.id);
    // ...but the caller is TOLD the conversion didn't happen, instead of the failure being silent.
    expect(moved.autoConverted).toBe(false);
    expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stageId).toBe(won.id);
    expect(await testPrisma.account.count({ where: { companyId: user.companyId!, sourceLeadId: lead.id } })).toBe(0);
    // ...and the STAGE_CHANGE activity was still written.
    expect(await testPrisma.activity.count({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } })).toBe(1);
  });
});

describe("partner auto-link is an allowlist LOOKUP, not a claim on a name", () => {
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = "sk_test_shared";
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue(partners("Sabah.City", "Komplex B"));
  });
  afterAll(async () => {
    if (savedApiKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedApiKey;
    await testPrisma.$disconnect();
  });

  // Drives the lead -> account conversion path and hands back the account it produced.
  async function convertLeadNamed(slug: string, companyName: string) {
    const { user, open, won } = await setup(slug);
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName, stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    return testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });
  }

  it("links when the complex is allowlisted to THIS company — trimmed, case-insensitive, storing the exact granted name", async () => {
    const { user, open, won } = await setup("al-hit");
    await grant(user.companyId!, "Sabah.City");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "  sabah.CITY  ", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });
    expect(acc.externalPartnerKey).toBe("Sabah.City");
  });

  it("does NOT link a name that is not allowlisted at all", async () => {
    const acc = await convertLeadNamed("al-none", "Sabah.City");
    expect(acc.externalPartnerKey).toBeNull();
  });

  // THE BLOCKER THIS REPLACES: the account name is free text a tenant supplies, so resolving the
  // partner FROM it let any MEMBER claim another tenant's complex just by naming an account after
  // it — and the created account confirmed the hit, making creation an enumeration oracle.
  it("does NOT link when the allowlist grants the complex to ANOTHER company, and reveals nothing", async () => {
    const other = await setup("al-wrongco-other");
    await grant(other.c.id, "Komplex B");

    const mine = await setup("al-wrongco-mine");
    const lead = await createLead(testPrisma, mine.user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: mine.open.id });
    await moveLeadStage(testPrisma, mine.user, lead.id, mine.won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    // Byte-for-byte the same outcome as a name nobody has ever heard of (the test above): no key,
    // no error, no audit row, nothing on the account that distinguishes "granted elsewhere" from
    // "does not exist". That indistinguishability is what kills the oracle.
    const unknown = await convertLeadNamed("al-wrongco-control", "Total Nonsense Ltd");
    expect(acc.externalPartnerKey).toBeNull();
    expect(acc.externalPartnerKey).toBe(unknown.externalPartnerKey);
    expect(await testPrisma.accountActivity.count({ where: { accountId: acc.id } })).toBe(0);
    // ...and the other company's grant is untouched, still pointing at them.
    const row = await testPrisma.partnerAllowlist.findUniqueOrThrow({ where: { normalizedName: "komplex b" } });
    expect(row.companyId).toBe(other.c.id);
  });

  it("never calls the Partner API — authorization is a local lookup, so a dead upstream is irrelevant", async () => {
    const { user, open, won } = await setup("al-nonet");
    await grant(user.companyId!, "Komplex B");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });
    expect(acc.externalPartnerKey).toBe("Komplex B");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("writes an audit row naming the complex when it auto-links", async () => {
    const { user, open, won } = await setup("al-audit");
    await grant(user.companyId!, "Komplex B");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    const audit = await testPrisma.accountActivity.findMany({ where: { accountId: acc.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].outcome).toBe("partner_link:auto_link");
    expect(audit[0].body).toContain("Komplex B");
    expect(audit[0].authorId).toBe(user.id);
    expect(audit[0].companyId).toBe(user.companyId);
  });

  it("never claims a complex another account in the SAME company already holds", async () => {
    const { user, open, won } = await setup("al-taken-same");
    await grant(user.companyId!, "Komplex B");
    await testPrisma.account.create({
      data: { companyId: user.companyId!, name: "Old Komplex", accountManagerId: user.id, externalPartnerKey: "Komplex B" },
    });

    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    // Created, but left UNLINKED — a second claim on one complex double-counts every analytics
    // total, so auto-link backs off and the manual picker stays the fallback.
    expect(acc.name).toBe("Komplex B");
    expect(acc.externalPartnerKey).toBeNull();
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("never claims a complex an account in ANOTHER company holds — the namespace is global", async () => {
    // One shared X-API-Key means ?partner=Komplex B is the same upstream complex for every
    // tenant, so the taken-check is deliberately NOT scoped by companyId.
    const other = await setup("al-taken-other");
    await testPrisma.account.create({
      data: { companyId: other.c.id, name: "Their Komplex", accountManagerId: other.user.id, externalPartnerKey: "Komplex B" },
    });

    const mine = await setup("al-taken-mine");
    await grant(mine.user.companyId!, "Komplex B");
    const lead = await createLead(testPrisma, mine.user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: mine.open.id });
    await moveLeadStage(testPrisma, mine.user, lead.id, mine.won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    expect(acc.externalPartnerKey).toBeNull();
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("createAccountWithLogin obeys the same allowlist — and has no explicit-key escape hatch", async () => {
    const { user } = await setup("al-direct");

    // Not granted -> unlinked, however exactly the name matches a real upstream complex.
    const miss = await createAccountWithLogin(testPrisma, user, { name: "Komplex B" });
    expect(miss.account.externalPartnerKey).toBeNull();

    // Granted -> linked. This is the ONLY way a company-facing call can produce a link; the
    // `externalPartnerKey` parameter is gone from the type, so passing one is a compile error
    // rather than a silent cross-tenant claim (see src/lib/tenant/accounts.ts).
    await grant(user.companyId!, "Sabah.City");
    const hit = await createAccountWithLogin(testPrisma, user, { name: "Sabah.City" });
    expect(hit.account.externalPartnerKey).toBe("Sabah.City");
  });

  it("a revoked grant stops future auto-linking", async () => {
    const { user } = await setup("al-revoked");
    const g = await grant(user.companyId!, "Komplex B");
    await testPrisma.partnerAllowlist.delete({ where: { id: g.id } });

    const { account } = await createAccountWithLogin(testPrisma, user, { name: "Komplex B" });
    expect(account.externalPartnerKey).toBeNull();
  });
});
