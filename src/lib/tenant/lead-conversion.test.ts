import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey } from "@/test/fixtures";
import { seedTeamStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { convertLeadToAccount } from "./lead-conversion";
import { createAccountWithLogin } from "./accounts";
import { BuildingClaimedError } from "./building-claim";
import type { PartnerListResponse } from "@/lib/partner-api/schema";
import type { SessionUser } from "@/lib/auth/guards";

// Auto-link resolves against the LIVE upstream partner list (fetchPartners): an account links only
// when exactly one upstream complex normalizes to its building name. The PartnerAllowlist grant
// table is gone (teams refactor) — the building claim guard is what keeps teams apart now. The
// client is mocked so each test controls what "upstream" says.
vi.mock("@/lib/partner-api/client", () => ({ fetchPartners: vi.fn() }));
import { fetchPartners } from "@/lib/partner-api/client";

function partners(...names: string[]): PartnerListResponse {
  return { partners: names.map((name) => ({ name, type: "RESIDENTIAL" as const })) };
}

async function setup(slug: string) {
  const team = await makeTeam({ name: slug });
  await seedTeamStages(testPrisma, team.companyId, team.id);
  const stages = await listStages(testPrisma, { companyId: team.companyId, teamId: team.id });
  const u = await makeUser("MEMBER", team);
  const user: SessionUser = su(u);
  return {
    c: { id: team.companyId }, team, user,
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
    // wonAt is stamped once, at the transition into Won (replaces the updatedAt-based metric).
    expect(moved.lead.wonAt).not.toBeNull();
    const accounts = await testPrisma.account.findMany({ where: { sourceLeadId: lead.id } });
    expect(accounts.length).toBe(1);
    expect(accounts[0].name).toBe("BigCo");
    expect(accounts[0].primaryContactName).toBe("Jane");
    expect(accounts[0].primaryContactEmail).toBe("j@big.co");
    expect(accounts[0].companyId).toBe(user.companyId);
    // The building and team carry across: the account belongs to the team that won it.
    expect(accounts[0].teamId).toBe(lead.teamId);
    expect(accounts[0].buildingKey).toBe(lead.buildingKey);
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
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Lost Co", stageId: open.id });
    const moved = await moveLeadStage(testPrisma, user, lead.id, lost.id);
    expect(moved.lead.wonAt).toBeNull();
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

  // CHANGED ON PURPOSE (teams refactor): this used to force a failure by planting a "Squatter"
  // account in another tenant with sourceLeadId = this lead (Account.sourceLeadId is globally
  // unique). convertLeadToAccount now looks the existing account up by sourceLeadId alone, with no
  // company filter, so that setup is treated as "already converted" instead of failing. The
  // realistic way a conversion fails now is the building claim: a sibling team registered the same
  // building as an ACCOUNT after this lead was created. Same contract is asserted: the stage move
  // stands, autoConverted is false, the caller is told why, and the STAGE_CHANGE row is written.
  it("keeps the stage move even when account creation fails (building claimed by another team)", async () => {
    const { user, open, won, c } = await setup("lc-fail");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Broken Co", stageId: open.id });
    const rival = await makeTeam({ companyId: c.id, name: "rival" });
    const rivalUser = await makeUser("MEMBER", rival);
    await testPrisma.account.create({
      data: {
        companyId: c.id, teamId: rival.id, buildingKey: lead.buildingKey,
        name: "Broken Co", accountManagerId: rivalUser.id,
      },
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const moved = await moveLeadStage(testPrisma, user, lead.id, won.id);
    errSpy.mockRestore();

    // The stage move stands on its own — the lead is in Won, not stuck.
    expect(moved.lead.stageId).toBe(won.id);
    // ...but the caller is TOLD the conversion didn't happen, and why, instead of it being silent.
    expect(moved.autoConverted).toBe(false);
    expect(moved.reason).toBe("building_claimed");
    expect((await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).stageId).toBe(won.id);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
    // ...and the STAGE_CHANGE activity was still written.
    expect(await testPrisma.activity.count({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } })).toBe(1);
  });
});

describe("partner auto-link resolves against the live upstream list", () => {
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

  it("links when exactly one upstream complex matches — trimmed, case-insensitive, storing the exact upstream name", async () => {
    const acc = await convertLeadNamed("al-hit", "  sabah.CITY  ");
    expect(acc.externalPartnerKey).toBe("Sabah.City");
  });

  it("does NOT link a name that is not in the upstream list", async () => {
    const acc = await convertLeadNamed("al-none", "Total Nonsense Ltd");
    expect(acc.externalPartnerKey).toBeNull();
  });

  it("refuses to guess when TWO upstream names normalize to the same building — account created unlinked", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Sabah City", "SABAH  CITY"));
    const acc = await convertLeadNamed("al-ambiguous", "sabah city");
    expect(acc.externalPartnerKey).toBeNull();
  });

  it("a dead upstream never fails the sale — account is created unlinked", async () => {
    vi.mocked(fetchPartners).mockRejectedValue(new Error("boom"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const acc = await convertLeadNamed("al-down", "Komplex B");
    expect(acc.externalPartnerKey).toBeNull();
    warn.mockRestore();
  });

  it("with PARTNER_API_KEY unset it does not call upstream at all", async () => {
    delete process.env.PARTNER_API_KEY;
    const acc = await convertLeadNamed("al-nokey", "Komplex B");
    expect(acc.externalPartnerKey).toBeNull();
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("writes a durable PartnerLinkAudit row naming the complex when it auto-links", async () => {
    const { user, open, won } = await setup("al-audit");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    const audit = await testPrisma.partnerLinkAudit.findMany({ where: { accountId: acc.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "auto_link", partnerName: "Komplex B", accountName: "Komplex B",
      actorId: user.id, companyId: user.companyId,
    });
    // The trail no longer lives in AccountActivity.
    expect(await testPrisma.accountActivity.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("a complex already held by an account in the SAME company is a building claim, not a second link", async () => {
    const { user, team, open } = await setup("al-taken-same");
    await testPrisma.account.create({
      data: {
        companyId: user.companyId!, teamId: team.id, buildingKey: buildingKey("Old Komplex"),
        name: "Old Komplex", accountManagerId: user.id, externalPartnerKey: "Komplex B",
      },
    });
    // The link IS the claim (findPartnerKeyHolder): the building is refused at lead creation.
    await expect(
      createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id }),
    ).rejects.toThrow(BuildingClaimedError);
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("never claims a complex an account in ANOTHER company holds — the partner namespace is global", async () => {
    // One shared X-API-Key means ?partner=Komplex B is the same upstream complex for every
    // company, so @@unique([externalPartnerKey]) is global. The claim guard is per-company, so
    // this company's lead is fine; only the LINK is refused and the account is created unlinked.
    const other = await setup("al-taken-other");
    await testPrisma.account.create({
      data: {
        companyId: other.c.id, teamId: other.team.id, buildingKey: buildingKey("Their Komplex"),
        name: "Their Komplex", accountManagerId: other.user.id, externalPartnerKey: "Komplex B",
      },
    });

    const mine = await setup("al-taken-mine");
    const lead = await createLead(testPrisma, mine.user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: mine.open.id });
    const moved = await moveLeadStage(testPrisma, mine.user, lead.id, mine.won.id);
    expect(moved.autoConverted).toBe(true);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    expect(acc.externalPartnerKey).toBeNull();
    expect(await testPrisma.account.count({ where: { externalPartnerKey: "Komplex B" } })).toBe(1);
  });

  it("createAccountWithLogin links through the same upstream resolution — and has no explicit-key escape hatch", async () => {
    const { user } = await setup("al-direct");

    // Not upstream -> unlinked.
    const miss = await createAccountWithLogin(testPrisma, user, { name: "Not A Real Complex" });
    expect(miss.account.externalPartnerKey).toBeNull();

    // Upstream -> linked. This is the ONLY way a company-facing call can produce a link; the
    // `externalPartnerKey` parameter is absent from the type (see src/lib/tenant/accounts.ts).
    const hit = await createAccountWithLogin(testPrisma, user, { name: "Sabah.City" });
    expect(hit.account.externalPartnerKey).toBe("Sabah.City");
  });
});
