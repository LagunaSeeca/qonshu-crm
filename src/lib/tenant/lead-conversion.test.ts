import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeUser, su, buildingKey, confirmedPartnerLink } from "@/test/fixtures";
import { seedTeamStages, listStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { convertLeadToAccount, startTrialFromLead } from "./lead-conversion";
import { createAccountWithLogin, InvalidTrialError } from "./accounts";
import { ONBOARDING_TEMPLATE } from "./onboarding-template";
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

describe("the PENDING partner link a conversion stakes", () => {
  let savedApiKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedApiKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = "sk_test_shared";
    vi.mocked(fetchPartners).mockReset();
    // Deliberately a FULL list: every test below must pass with the upstream reachable and
    // answering, because the conversion path no longer asks it anything. A call would be a bug.
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

  // WON NO LONGER GRANTS ANYTHING (security review finding F1). Winning a lead used to resolve
  // its name against the live upstream list and link on a hit, which meant closing a deal on a
  // guessed building name handed the salesperson that complex's debt, payments and unit-level
  // owner names/phones. The conversion now stakes the normalized name as a PENDING link and the
  // owner decides. Note the trimming/case-folding is still exercised — the IDENTITY is the same,
  // only the entitlement changed.
  it("stakes the normalized building name, unconfirmed, whatever the upstream says", async () => {
    const acc = await convertLeadNamed("al-hit", "  sabah.CITY  ");
    expect(acc.externalPartnerKey).toBe("sabah.city");
    expect(acc.partnerLinkConfirmedAt).toBeNull();
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  // A name upstream has never heard of is treated identically. That is the point: the two cases
  // must be indistinguishable to the person creating the record, or the create path is an oracle.
  it("stakes a name that is not in the upstream list just the same", async () => {
    const acc = await convertLeadNamed("al-none", "Total Nonsense Ltd");
    expect(acc.externalPartnerKey).toBe("total nonsense ltd");
    expect(acc.partnerLinkConfirmedAt).toBeNull();
  });

  // Two upstream spellings of one building is now the OWNER's problem, refused at confirm time
  // (see src/lib/tenant/partner-link-approval.test.ts), not a reason to lose the claim.
  it("stakes the claim even when two upstream names would normalize to the same building", async () => {
    vi.mocked(fetchPartners).mockResolvedValue(partners("Sabah City", "SABAH  CITY"));
    const acc = await convertLeadNamed("al-ambiguous", "sabah city");
    expect(acc.externalPartnerKey).toBe("sabah city");
    expect(acc.partnerLinkConfirmedAt).toBeNull();
  });

  // tryAutoLink existed only to recover a link lost to an outage at this exact moment. With no
  // upstream call on this path there is nothing to lose and nothing to recover.
  it("a dead upstream is invisible to the sale", async () => {
    vi.mocked(fetchPartners).mockRejectedValue(new Error("boom"));
    const acc = await convertLeadNamed("al-down", "Komplex B");
    expect(acc.externalPartnerKey).toBe("komplex b");
  });

  it("with PARTNER_API_KEY unset it behaves exactly the same", async () => {
    delete process.env.PARTNER_API_KEY;
    const acc = await convertLeadNamed("al-nokey", "Komplex B");
    expect(acc.externalPartnerKey).toBe("komplex b");
    expect(fetchPartners).not.toHaveBeenCalled();
  });

  it("writes a durable PartnerLinkAudit row naming the proposed complex", async () => {
    const { user, open, won } = await setup("al-audit");
    const lead = await createLead(testPrisma, user, { title: "Deal", contactName: "C", companyName: "Komplex B", stageId: open.id });
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });

    const audit = await testPrisma.partnerLinkAudit.findMany({ where: { accountId: acc.id } });
    expect(audit).toHaveLength(1);
    // "pending", not "auto_link": the row records a PROPOSAL by the salesperson, and the owner's
    // later "confirm" row is what records the grant.
    expect(audit[0]).toMatchObject({
      action: "pending", partnerName: "komplex b", accountName: "Komplex B",
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
        name: "Old Komplex", accountManagerId: user.id, ...confirmedPartnerLink("Komplex B"),
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
    // company, so the partner claim is global while the building claim is per company. This
    // company's lead is therefore fine; only the LINK is refused and the account is created with
    // no link at all. The rival holds the upstream's DISPLAY spelling, which the exact-string
    // unique index cannot match against our normalized "komplex b" — the normalized pre-check in
    // pendingPartnerKey is what refuses it.
    const other = await setup("al-taken-other");
    await testPrisma.account.create({
      data: {
        companyId: other.c.id, teamId: other.team.id, buildingKey: buildingKey("Their Komplex"),
        name: "Their Komplex", accountManagerId: other.user.id, ...confirmedPartnerLink("Komplex B"),
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

  it("createAccountWithLogin stakes the same pending link — and has no explicit-key escape hatch", async () => {
    const { user } = await setup("al-direct");

    // Upstream membership is irrelevant on this path now: both of these stake their own name.
    const miss = await createAccountWithLogin(testPrisma, user, { name: "Not A Real Complex" });
    expect(miss.account.externalPartnerKey).toBe("not a real complex");
    expect(miss.account.partnerLinkConfirmedAt).toBeNull();

    // The `externalPartnerKey` parameter is absent from the type (see src/lib/tenant/accounts.ts),
    // so no company-facing call can name a complex directly at all.
    const hit = await createAccountWithLogin(testPrisma, user, { name: "Sabah.City" });
    expect(hit.account.externalPartnerKey).toBe("sabah.city");
    expect(hit.account.partnerLinkConfirmedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// TRIALS FROM LEADS. Some buildings get a 2-3 month trial before any contract exists. The
// building becomes an Account in `DEMO` so sales can see its live statistics, while the LEAD
// stays in the pipeline as not-yet-Won. Signing the contract is DEMO -> ACTIVE, which seeds the
// onboarding checklist — and that promotion is reached from BOTH ways of saying "we won this":
// the manual Convert button and moveLeadStage's auto-convert, since both call
// convertLeadToAccount.
// ---------------------------------------------------------------------------------------------
describe("trials from leads", () => {
  let savedKey: string | undefined;

  beforeEach(async () => {
    await resetDb();
    savedKey = process.env.PARTNER_API_KEY;
    process.env.PARTNER_API_KEY = "sk_test_shared";
    vi.mocked(fetchPartners).mockReset();
    vi.mocked(fetchPartners).mockResolvedValue(partners());
  });
  afterAll(async () => {
    if (savedKey === undefined) delete process.env.PARTNER_API_KEY;
    else process.env.PARTNER_API_KEY = savedKey;
    await testPrisma.$disconnect();
  });

  const endsAt = new Date(Date.UTC(2030, 0, 1));
  const steps = (accountId: string) =>
    testPrisma.onboardingStep.findMany({ where: { accountId }, orderBy: { position: "asc" } });

  it("a Won conversion seeds exactly 6 steps, in template order, positions 1..6", async () => {
    const { user, open, won } = await setup("lc-seed");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Seeded Tower", stageId: open.id,
    });

    await moveLeadStage(testPrisma, user, lead.id, won.id);

    const acc = await testPrisma.account.findFirstOrThrow({ where: { sourceLeadId: lead.id } });
    const rows = await steps(acc.id);
    expect(rows.length).toBe(6);
    expect(rows.map((r) => r.templateKey)).toEqual(ONBOARDING_TEMPLATE.map((s) => s.key));
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("startTrialFromLead creates a DEMO account and leaves the lead where it is", async () => {
    const { user, team, open } = await setup("lc-trial");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "Jane", companyName: "Trial Tower", email: "j@t.co", stageId: open.id,
    });

    const { account, created } = await startTrialFromLead(testPrisma, user, lead.id, {
      trialStartsAt: new Date(Date.UTC(2026, 2, 1)), trialEndsAt: new Date(Date.UTC(2026, 4, 30)),
    });

    expect(created).toBe(true);
    expect(account.status).toBe("DEMO");
    expect(account.sourceLeadId).toBe(lead.id);
    expect(account.trialStartsAt?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(account.trialEndsAt?.toISOString()).toBe("2026-05-30T00:00:00.000Z");
    // Created through createAccount, so the lead's identity carries over exactly as on the Won
    // path: the building claim, the team that is selling it, and the salesperson as manager.
    expect(account.buildingKey).toBe(lead.buildingKey);
    expect(account.teamId).toBe(team.id);
    expect(account.accountManagerId).toBe(lead.ownerId);
    expect(account.primaryContactName).toBe("Jane");
    // No contract yet: no onboarding checklist.
    expect(await steps(account.id)).toEqual([]);
    // The LEAD is untouched — starting a trial is not winning a deal.
    const after = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stageId).toBe(open.id);
    expect(after.wonAt).toBeNull();
  });

  it("startTrialFromLead twice returns the same account and creates no duplicate", async () => {
    const { user, open } = await setup("lc-trial-twice");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Once Tower", stageId: open.id,
    });

    const first = await startTrialFromLead(testPrisma, user, lead.id, { trialEndsAt: endsAt });
    const second = await startTrialFromLead(testPrisma, user, lead.id, {
      // A different window, deliberately: the second call must not re-date the live trial.
      trialEndsAt: new Date(Date.UTC(2031, 0, 1)),
    });

    expect(second.created).toBe(false);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.trialEndsAt?.toISOString()).toBe(first.account.trialEndsAt?.toISOString());
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
  });

  it("startTrialFromLead is refused on a WON or LOST lead, and creates nothing", async () => {
    const { user, open, won, lost } = await setup("lc-trial-won");
    const wonLead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Won Tower", stageId: open.id,
    });
    await moveLeadStage(testPrisma, user, wonLead.id, won.id);
    const lostLead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Lost Tower", stageId: open.id,
    });
    await moveLeadStage(testPrisma, user, lostLead.id, lost.id);

    // The won lead already HAS an account (auto-convert), so idempotency answers first: it comes
    // back unchanged and ACTIVE rather than being re-opened as a trial.
    const existing = await startTrialFromLead(testPrisma, user, wonLead.id, { trialEndsAt: endsAt });
    expect(existing.created).toBe(false);
    expect(existing.account.status).toBe("ACTIVE");

    // With no account to find, the stage itself is the refusal.
    await expect(startTrialFromLead(testPrisma, user, lostLead.id, { trialEndsAt: endsAt }))
      .rejects.toThrow(InvalidTrialError);
    expect(await testPrisma.account.count({ where: { sourceLeadId: lostLead.id } })).toBe(0);
  });

  it("promotes a DEMO account to ACTIVE when its lead moves to Won, and seeds EXACTLY once", async () => {
    const { user, open, won } = await setup("lc-promote");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Promoted Tower", stageId: open.id,
    });
    const { account } = await startTrialFromLead(testPrisma, user, lead.id, { trialEndsAt: endsAt });

    const moved = await moveLeadStage(testPrisma, user, lead.id, won.id);

    expect(moved.autoConverted).toBe(true);
    // No second account: the trial account IS the customer.
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
    const promoted = await testPrisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(promoted.status).toBe("ACTIVE");
    // The trial window is kept as history.
    expect(promoted.trialEndsAt?.toISOString()).toBe(endsAt.toISOString());
    // 6, NOT 12. The conditional `where: { status: "DEMO" }` makes the second promotion a no-op,
    // and seedOnboardingChecklist's claim makes the second seed one.
    expect((await steps(account.id)).length).toBe(6);

    // Out of Won and back in, plus the manual button: still 6.
    await moveLeadStage(testPrisma, user, lead.id, open.id);
    await moveLeadStage(testPrisma, user, lead.id, won.id);
    const again = await convertLeadToAccount(testPrisma, user, lead.id);
    expect(again.created).toBe(false);
    expect(again.account.id).toBe(account.id);
    expect((await steps(account.id)).length).toBe(6);
  });

  it("the manual convert promotes a DEMO account WITHOUT moving its lead to Won", async () => {
    const { user, open } = await setup("lc-manual-promote");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Signed Tower", stageId: open.id,
    });
    const { account } = await startTrialFromLead(testPrisma, user, lead.id, { trialEndsAt: endsAt });

    // The contract was signed while the lead is still mid-pipeline. The owner's rule: activating a
    // trial does NOT auto-win its lead — sales does that separately, in either order.
    const { account: promoted, created } = await convertLeadToAccount(testPrisma, user, lead.id);

    expect(created).toBe(false);
    expect(promoted.id).toBe(account.id);
    expect(promoted.status).toBe("ACTIVE");
    expect(promoted.onboardingSeededAt).not.toBeNull();
    expect((await steps(account.id)).length).toBe(6);
    const after = await testPrisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.stageId).toBe(open.id);
    expect(after.wonAt).toBeNull();
  });

  it("a trial whose lead is marked LOST stays in DEMO, and a convert on it changes nothing", async () => {
    const { user, open, lost } = await setup("lc-trial-lost");
    const lead = await createLead(testPrisma, user, {
      title: "Deal", contactName: "C", companyName: "Lost Trial Tower", stageId: open.id,
    });
    const { account } = await startTrialFromLead(testPrisma, user, lead.id, { trialEndsAt: endsAt });

    const moved = await moveLeadStage(testPrisma, user, lead.id, lost.id, "budget");

    // Losing the deal during a trial leaves the account in DEMO: somebody sets CHURNED by hand.
    expect(moved.autoConverted).toBe(false);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("DEMO");
    // And the manual button cannot activate a building that was just lost.
    const { account: unchanged } = await convertLeadToAccount(testPrisma, user, lead.id);
    expect(unchanged.status).toBe("DEMO");
    expect(await steps(account.id)).toEqual([]);
  });
});
