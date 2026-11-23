import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeam } from "@/test/fixtures";
import { DEFAULT_STAGES } from "./stages";
import { cloneTemplateToTeam, seedOrgTemplate, TEMPLATE_FIELD_DEFS } from "./team-template";

const templateStages = (companyId: string) =>
  testPrisma.stage.findMany({ where: { companyId, teamId: null }, orderBy: { order: "asc" } });
const teamStages = (teamId: string) =>
  testPrisma.stage.findMany({ where: { teamId }, orderBy: { order: "asc" } });
const templateDefs = (companyId: string) =>
  testPrisma.accountFieldDef.findMany({ where: { companyId, teamId: null }, orderBy: { order: "asc" } });
const teamDefs = (teamId: string) =>
  testPrisma.accountFieldDef.findMany({ where: { teamId }, orderBy: { order: "asc" } });

describe("seedOrgTemplate", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("builds the org template as teamId-null rows", async () => {
    const co = await makeCompany();
    const counts = await seedOrgTemplate(testPrisma, co.id);
    expect(counts).toEqual({ stages: DEFAULT_STAGES.length, fieldDefs: TEMPLATE_FIELD_DEFS.length });
    expect((await templateStages(co.id)).map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    expect((await templateDefs(co.id)).map((d) => d.label)).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.label));
  });

  it("is idempotent", async () => {
    const co = await makeCompany();
    await seedOrgTemplate(testPrisma, co.id);
    expect(await seedOrgTemplate(testPrisma, co.id)).toEqual({ stages: 0, fieldDefs: 0 });
    expect(await testPrisma.stage.count({ where: { companyId: co.id } })).toBe(DEFAULT_STAGES.length);
    expect(await testPrisma.accountFieldDef.count({ where: { companyId: co.id } })).toBe(
      TEMPLATE_FIELD_DEFS.length,
    );
  });

  it("leaves a hand-edited template stage set alone", async () => {
    const co = await makeCompany();
    await testPrisma.stage.create({
      data: { companyId: co.id, teamId: null, name: "Only Stage", type: "OPEN", probability: 5, order: 0 },
    });
    const counts = await seedOrgTemplate(testPrisma, co.id);
    expect(counts.stages).toBe(0);
    expect((await templateStages(co.id)).map((s) => s.name)).toEqual(["Only Stage"]);
  });

  // (teamId, label) is unique in the DB, but Postgres treats NULLs as DISTINCT, so the constraint
  // does NOT cover template rows — duplicate template labels must be prevented in code, scoped by
  // (companyId, label).
  it("never re-adds a template label the company already holds", async () => {
    const co = await makeCompany();
    await testPrisma.accountFieldDef.create({
      data: { companyId: co.id, teamId: null, label: TEMPLATE_FIELD_DEFS[0].label, type: "TEXT", order: 0 },
    });
    const counts = await seedOrgTemplate(testPrisma, co.id);
    expect(counts.fieldDefs).toBe(TEMPLATE_FIELD_DEFS.length - 1);
    const labels = (await templateDefs(co.id)).map((d) => d.label);
    expect(labels).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.label));
    expect(new Set(labels).size).toBe(labels.length);
    // The pre-existing row keeps its own type: seeding completes a template, it does not correct
    // one.
    expect((await templateDefs(co.id))[0].type).toBe("TEXT");
  });

  it("scopes the template per company", async () => {
    const a = await makeCompany();
    const b = await makeCompany();
    await seedOrgTemplate(testPrisma, a.id);
    expect(await templateStages(b.id)).toHaveLength(0);
  });
});

describe("cloneTemplateToTeam", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("copies the template's stages and field definitions into the team, in order", async () => {
    const team = await makeTeam();
    await seedOrgTemplate(testPrisma, team.companyId);
    const counts = await cloneTemplateToTeam(testPrisma, team.companyId, team.id);
    expect(counts).toEqual({ stages: DEFAULT_STAGES.length, fieldDefs: TEMPLATE_FIELD_DEFS.length });

    const stages = await teamStages(team.id);
    expect(stages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    expect(stages.map((s) => s.order)).toEqual(DEFAULT_STAGES.map((_, i) => i));
    expect(stages.map((s) => s.type)).toEqual(DEFAULT_STAGES.map((s) => s.type));
    expect(stages.map((s) => s.probability)).toEqual(DEFAULT_STAGES.map((s) => s.probability));
    expect(stages.every((s) => s.companyId === team.companyId)).toBe(true);

    const defs = await teamDefs(team.id);
    expect(defs.map((d) => d.label)).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.label));
    expect(defs.map((d) => d.type)).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.type));

    // The template itself is untouched by a clone.
    expect(await templateStages(team.companyId)).toHaveLength(DEFAULT_STAGES.length);
  });

  it("leaves a team that already has a pipeline alone", async () => {
    const team = await makeTeam();
    await seedOrgTemplate(testPrisma, team.companyId);
    await testPrisma.stage.create({
      data: { companyId: team.companyId, teamId: team.id, name: "Mine", type: "OPEN", probability: 1, order: 0 },
    });
    const counts = await cloneTemplateToTeam(testPrisma, team.companyId, team.id);
    expect(counts.stages).toBe(0);
    expect((await teamStages(team.id)).map((s) => s.name)).toEqual(["Mine"]);
    // Field definitions are tracked separately, so the team still gets those.
    expect(counts.fieldDefs).toBe(TEMPLATE_FIELD_DEFS.length);
  });

  it("re-running is a no-op rather than a unique-constraint failure", async () => {
    const team = await makeTeam();
    await seedOrgTemplate(testPrisma, team.companyId);
    await cloneTemplateToTeam(testPrisma, team.companyId, team.id);
    expect(await cloneTemplateToTeam(testPrisma, team.companyId, team.id)).toEqual({ stages: 0, fieldDefs: 0 });
  });

  // A duplicate template label is possible at the DB level; the team's own unique index is real,
  // so copying both rows would fail the insert.
  it("dedupes duplicate template labels on the way in", async () => {
    const team = await makeTeam();
    await testPrisma.accountFieldDef.createMany({
      data: [
        { companyId: team.companyId, teamId: null, label: "Total area", type: "NUMBER", order: 0 },
        { companyId: team.companyId, teamId: null, label: "Total area", type: "TEXT", order: 1 },
      ],
    });
    const counts = await cloneTemplateToTeam(testPrisma, team.companyId, team.id);
    expect(counts.fieldDefs).toBe(1);
    expect((await teamDefs(team.id)).map((d) => d.label)).toEqual(["Total area"]);
  });

  it("clones nothing when the company has no template", async () => {
    const team = await makeTeam();
    expect(await cloneTemplateToTeam(testPrisma, team.companyId, team.id)).toEqual({ stages: 0, fieldDefs: 0 });
  });
});
