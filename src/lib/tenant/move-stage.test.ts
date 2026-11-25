import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { NotFoundError } from "@/lib/auth/guards";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeamWithUsers, uniq } from "@/test/fixtures";
import { listStages, seedTeamStages } from "./stages";
import { createLead, moveLeadStage } from "./leads";
import { startTrialFromLead } from "./lead-conversion";

async function fixture(companyId?: string) {
  const t = await makeTeamWithUsers(companyId ? { companyId } : {});
  await seedTeamStages(testPrisma, t.companyId, t.team.id);
  const stages = await listStages(testPrisma, { companyId: t.companyId, teamId: t.team.id });
  return {
    ...t, stages,
    open: stages[0],
    won: stages.find((s) => s.type === "WON")!,
    lost: stages.find((s) => s.type === "LOST")!,
  };
}

describe("moveLeadStage", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("writes a STAGE_CHANGE activity and sets lostReason on LOST", async () => {
    const t = await fixture();
    const lead = await createLead(testPrisma, t.suMember, {
      title: "D", contactName: "C", stageId: t.open.id, companyName: uniq("Building "),
    });

    const moved = await moveLeadStage(testPrisma, t.suMember, lead.id, t.lost.id, "budget");

    expect(moved.lead.stageId).toBe(t.lost.id);
    expect(moved.lead.lostReason).toBe("budget");
    // A Lost move never converts, so the flag is false — it is not a failure signal here, and
    // there is no reason to report either.
    expect(moved.autoConverted).toBe(false);
    expect(moved.reason).toBeUndefined();
    const acts = await testPrisma.activity.findMany({ where: { leadId: lead.id, kind: "STAGE_CHANGE" } });
    expect(acts.length).toBe(1);
    expect(acts[0].body).toBe(`Moved from ${t.open.name} to ${t.lost.name}`);
  });

  it("rejects a target stage from another team", async () => {
    const a = await fixture();
    const b = await fixture(a.companyId);
    const lead = await createLead(testPrisma, a.suMember, {
      title: "D", contactName: "C", stageId: a.open.id, companyName: uniq("Building "),
    });
    // Stages belong to a team now, so a sibling team's stage id is not somewhere this lead can
    // go, even inside the same company.
    await expect(moveLeadStage(testPrisma, a.suMember, lead.id, b.won.id)).rejects.toThrow(NotFoundError);
  });

  describe("wonAt", () => {
    it("is stamped on entering WON and nulled on leaving it", async () => {
      const t = await fixture();
      const lead = await createLead(testPrisma, t.suMember, {
        title: "D", contactName: "C", stageId: t.open.id, companyName: uniq("Building "),
      });
      expect(lead.wonAt).toBeNull();

      const won = await moveLeadStage(testPrisma, t.suMember, lead.id, t.won.id);
      expect(won.lead.wonAt).toBeInstanceOf(Date);

      // Replaces the old updatedAt-based "won in period" metric, which re-counted an old win
      // into the current period every time anyone edited the lead.
      const back = await moveLeadStage(testPrisma, t.suMember, lead.id, t.open.id);
      expect(back.lead.wonAt).toBeNull();
    });

    it("keeps the original timestamp across a WON -> WON move", async () => {
      const t = await fixture();
      const secondWon = await testPrisma.stage.create({
        data: { companyId: t.companyId, teamId: t.team.id, name: "Won (Upsell)", type: "WON", order: 98 },
      });
      const lead = await createLead(testPrisma, t.suMember, {
        title: "D", contactName: "C", stageId: t.open.id, companyName: uniq("Building "),
      });

      const first = await moveLeadStage(testPrisma, t.suMember, lead.id, t.won.id);
      const again = await moveLeadStage(testPrisma, t.suMember, lead.id, secondWon.id);

      // A team with two won columns must not re-date the win just by sliding between them.
      expect(again.lead.wonAt).toEqual(first.lead.wonAt);
    });
  });

  describe("auto-convert on Won", () => {
    it("reports autoConverted on a clean Won move", async () => {
      const t = await fixture();
      const lead = await createLead(testPrisma, t.suMember, {
        title: "D", contactName: "C", stageId: t.open.id, companyName: "Clean Tower",
      });
      const moved = await moveLeadStage(testPrisma, t.suMember, lead.id, t.won.id);
      expect(moved.autoConverted).toBe(true);
      expect(moved.reason).toBeUndefined();
      expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
    });

    it("reports reason 'building_claimed' when an account already holds the building", async () => {
      const t = await fixture();
      const lead = await createLead(testPrisma, t.suMember, {
        title: "D", contactName: "C", stageId: t.open.id, companyName: "Shared Tower",
      });
      // Raw, because createAccount would itself be blocked by this lead's claim. A lead and an
      // account living in two tables with two separate unique indexes is exactly the state the
      // advisory lock exists to arbitrate.
      await testPrisma.account.create({
        data: {
          companyId: t.companyId, teamId: t.team.id, name: "Shared Tower",
          buildingKey: buildingKey("Shared Tower"), accountManagerId: t.admin.id,
        },
      });

      const moved = await moveLeadStage(testPrisma, t.suMember, lead.id, t.won.id);

      // The stage move stands on its own — that is the user's action.
      expect(moved.lead.stageId).toBe(t.won.id);
      expect(moved.lead.wonAt).toBeInstanceOf(Date);
      // ...but the client is told WHY no account appeared, so it can name the holder instead of
      // reporting an unqualified success or an unexplained failure.
      expect(moved.autoConverted).toBe(false);
      expect(moved.reason).toBe("building_claimed");
      expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(0);
    });
  });
});

// The stage move's own view of a trial: a building already on DEMO is ACTIVATED by the Won move
// rather than converted a second time. moveLeadStage reaches this through convertLeadToAccount —
// the same function the manual Convert button calls — so there is one promotion path, not two.
describe("moveLeadStage: a building already on trial", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("activates the DEMO account instead of creating a second one, and seeds the checklist once", async () => {
    const t = await fixture();
    const lead = await createLead(testPrisma, t.suMember, {
      title: "D", contactName: "C", stageId: t.open.id, companyName: uniq("Trial Tower "),
    });
    const { account } = await startTrialFromLead(testPrisma, t.suMember, lead.id, {
      trialEndsAt: new Date(Date.UTC(2030, 0, 1)),
    });
    expect(account.status).toBe("DEMO");
    // Nothing to onboard until a contract exists.
    expect(await testPrisma.onboardingStep.count({ where: { accountId: account.id } })).toBe(0);

    const moved = await moveLeadStage(testPrisma, t.suMember, lead.id, t.won.id);

    expect(moved.autoConverted).toBe(true);
    expect(moved.reason).toBeUndefined();
    expect(await testPrisma.account.count({ where: { sourceLeadId: lead.id } })).toBe(1);
    const promoted = await testPrisma.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(promoted.status).toBe("ACTIVE");
    expect(await testPrisma.onboardingStep.count({ where: { accountId: account.id } })).toBe(6);
  });

  it("leaves the DEMO account alone on a LOST move", async () => {
    const t = await fixture();
    const lead = await createLead(testPrisma, t.suMember, {
      title: "D", contactName: "C", stageId: t.open.id, companyName: uniq("Trial Tower "),
    });
    const { account } = await startTrialFromLead(testPrisma, t.suMember, lead.id, {
      trialEndsAt: new Date(Date.UTC(2030, 0, 1)),
    });

    const moved = await moveLeadStage(testPrisma, t.suMember, lead.id, t.lost.id, "budget");

    // A lost trial is written off by hand (CHURNED), never automatically: the building may still
    // be using the app while the commercial conversation continues.
    expect(moved.autoConverted).toBe(false);
    expect((await testPrisma.account.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("DEMO");
    expect(await testPrisma.onboardingStep.count({ where: { accountId: account.id } })).toBe(0);
  });
});
