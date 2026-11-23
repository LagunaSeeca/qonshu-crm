import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeCompany, makeTeam, makeTeamWithUsers, makeUser, su } from "@/test/fixtures";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import {
  DEFAULT_STAGES, LastStageError, StageHasLeadsError, createStage, deleteStage, listStages,
  reorderStages, resolveStageScope, seedDefaultStages, seedTeamStages, updateStage,
} from "./stages";

const NAMES = DEFAULT_STAGES.map((s) => s.name);

describe("stage seeding", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("seedDefaultStages seeds the ORG TEMPLATE (teamId null), idempotently", async () => {
    const c = await makeCompany();
    await seedDefaultStages(testPrisma, c.id);
    await seedDefaultStages(testPrisma, c.id);
    const template = await listStages(testPrisma, { companyId: c.id, teamId: null });
    expect(template.map((s) => s.name)).toEqual(NAMES);
    expect(template[0].order).toBe(0);
    expect(template.every((s) => s.teamId === null)).toBe(true);
    expect(template.find((s) => s.name === "Won")!.type).toBe("WON");
  });

  it("seedTeamStages copies the template into the team and leaves the template alone", async () => {
    const c = await makeCompany();
    await seedDefaultStages(testPrisma, c.id);
    // An org that has customised its template: every team created afterwards inherits that.
    const tpl = await listStages(testPrisma, { companyId: c.id, teamId: null });
    await updateStage(testPrisma, { companyId: c.id, teamId: null }, tpl[0].id, { name: "Inbox" });

    const team = await makeTeam({ companyId: c.id });
    await seedTeamStages(testPrisma, c.id, team.id);
    await seedTeamStages(testPrisma, c.id, team.id);

    const own = await listStages(testPrisma, { companyId: c.id, teamId: team.id });
    expect(own.map((s) => s.name)).toEqual(["Inbox", ...NAMES.slice(1)]);
    expect(own.every((s) => s.teamId === team.id)).toBe(true);
    // The template is a separate set of rows, not shared with the team.
    expect((await listStages(testPrisma, { companyId: c.id, teamId: null })).length).toBe(NAMES.length);
  });

  it("seedTeamStages falls back to DEFAULT_STAGES when the company has no template", async () => {
    const team = await makeTeam();
    await seedTeamStages(testPrisma, team.companyId, team.id);
    expect((await listStages(testPrisma, { companyId: team.companyId, teamId: team.id })).map((s) => s.name)).toEqual(NAMES);
  });

  it("keeps each team's pipeline separate", async () => {
    const c = await makeCompany();
    const a = await makeTeam({ companyId: c.id });
    const b = await makeTeam({ companyId: c.id });
    await seedTeamStages(testPrisma, c.id, a.id);
    await seedTeamStages(testPrisma, c.id, b.id);
    const scopeA = { companyId: c.id, teamId: a.id };

    await createStage(testPrisma, scopeA, { name: "Site Visit" });

    expect((await listStages(testPrisma, scopeA)).map((s) => s.name)).toContain("Site Visit");
    expect((await listStages(testPrisma, { companyId: c.id, teamId: b.id })).map((s) => s.name)).not.toContain("Site Visit");
  });
});

describe("stage editing", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  async function teamScope(companyId?: string) {
    const t = await makeTeamWithUsers(companyId ? { companyId } : {});
    await seedTeamStages(testPrisma, t.companyId, t.team.id);
    const scope = { companyId: t.companyId, teamId: t.team.id };
    return { ...t, scope, stages: await listStages(testPrisma, scope) };
  }

  it("reorders within the team and blocks deleting a stage that holds leads", async () => {
    const t = await teamScope();
    const [s0, s1] = t.stages;
    await reorderStages(testPrisma, t.scope, [s1.id, s0.id]);
    expect((await listStages(testPrisma, t.scope))[0].id).toBe(s1.id);

    await testPrisma.lead.create({
      data: {
        companyId: t.companyId, teamId: t.team.id, ownerId: t.member.id,
        buildingKey: buildingKey("Delete Blocker"), companyName: "Delete Blocker",
        title: "D", contactName: "C", stageId: s1.id,
      },
    });
    await expect(deleteStage(testPrisma, t.scope, s1.id)).rejects.toThrow(StageHasLeadsError);
  });

  it("deleteStage blocks removing this TEAM'S last WON stage even when a sibling team has one", async () => {
    const a = await teamScope();
    const b = await teamScope(a.companyId);
    expect((await listStages(testPrisma, b.scope)).filter((s) => s.type === "WON").length).toBe(1);

    // THE REGRESSION THIS PINS: the guard used to count company-wide, so team A could delete its
    // only Won column as long as team B still had one — leaving A with a pipeline that can never
    // be won and moveLeadStage with nowhere to land.
    const won = a.stages.find((s) => s.type === "WON")!;
    await expect(deleteStage(testPrisma, a.scope, won.id)).rejects.toThrow(LastStageError);
  });

  it("deleteStage succeeds on a non-last OPEN stage of the same team", async () => {
    const t = await teamScope();
    const open = t.stages.filter((s) => s.type === "OPEN");
    expect(open.length).toBeGreaterThanOrEqual(2);
    await expect(deleteStage(testPrisma, t.scope, open[0].id)).resolves.toBeUndefined();
  });

  it("refuses to edit, delete or reorder another team's stage", async () => {
    const a = await teamScope();
    const b = await teamScope(a.companyId);
    const bStage = b.stages[0];

    await expect(updateStage(testPrisma, a.scope, bStage.id, { name: "Hijacked" })).rejects.toThrow(NotFoundError);
    await expect(deleteStage(testPrisma, a.scope, bStage.id)).rejects.toThrow(NotFoundError);
    // reorderStages is updateMany-based, so a foreign id matches nothing rather than throwing —
    // what matters is that it did not move.
    await reorderStages(testPrisma, a.scope, [bStage.id]);
    expect((await testPrisma.stage.findUniqueOrThrow({ where: { id: bStage.id } })).order).toBe(bStage.order);
  });
});

describe("resolveStageScope", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("gives a team admin and a member their own team, whether or not they name it", async () => {
    const t = await makeTeamWithUsers();
    const expected = { companyId: t.companyId, teamId: t.team.id };
    expect(await resolveStageScope(testPrisma, t.suAdmin)).toEqual(expected);
    expect(await resolveStageScope(testPrisma, t.suMember)).toEqual(expected);
    expect(await resolveStageScope(testPrisma, t.suAdmin, { teamId: t.team.id })).toEqual(expected);
  });

  it("refuses a team admin another team, and refuses everyone but a super admin the template", async () => {
    const t = await makeTeamWithUsers();
    const other = await makeTeam({ companyId: t.companyId });
    await expect(resolveStageScope(testPrisma, t.suAdmin, { teamId: other.id })).rejects.toThrow(ForbiddenError);
    // The template is what every future team is seeded from, so one team's admin must not be
    // able to reshape every team created after them.
    await expect(resolveStageScope(testPrisma, t.suAdmin, { teamId: null })).rejects.toThrow(ForbiddenError);
    await expect(resolveStageScope(testPrisma, t.suMember, { teamId: null })).rejects.toThrow(ForbiddenError);
  });

  it("refuses a team admin or member who is not on a team", async () => {
    const team = await makeTeam();
    const stray = await makeUser("COMPANY_ADMIN", team, { teamId: null });
    await expect(resolveStageScope(testPrisma, su(stray))).rejects.toThrow(ForbiddenError);
  });

  it("lets a SUPER_ADMIN name any team, or the template with an explicit company", async () => {
    const t = await makeTeamWithUsers();
    const sa = su(await makeUser("SUPER_ADMIN"));
    expect(await resolveStageScope(testPrisma, sa, { teamId: t.team.id })).toEqual({ companyId: t.companyId, teamId: t.team.id });
    expect(await resolveStageScope(testPrisma, sa, { teamId: null, companyId: t.companyId })).toEqual({ companyId: t.companyId, teamId: null });
  });

  it("refuses a SUPER_ADMIN that names nothing, or an unknown team", async () => {
    const sa = su(await makeUser("SUPER_ADMIN"));
    // No team and no company of its own: a silent default would edit whichever team came first.
    await expect(resolveStageScope(testPrisma, sa)).rejects.toThrow(ForbiddenError);
    await expect(resolveStageScope(testPrisma, sa, { teamId: null })).rejects.toThrow(ForbiddenError);
    await expect(resolveStageScope(testPrisma, sa, { teamId: "nope" })).rejects.toThrow(NotFoundError);
  });

  it("refuses a PARTNER_VIEWER outright", async () => {
    const t = await makeTeamWithUsers();
    const partner = su(await makeUser("PARTNER_VIEWER", t.team));
    await expect(resolveStageScope(testPrisma, partner, { teamId: t.team.id })).rejects.toThrow(ForbiddenError);
  });
});
