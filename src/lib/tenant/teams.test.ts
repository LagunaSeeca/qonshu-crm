import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeCompany, makeTeam, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import { DEFAULT_STAGES } from "./stages";
import { seedOrgTemplate, TEMPLATE_FIELD_DEFS } from "./team-template";
import { createTeamWithAdmin, listTeams, renameTeam, InvalidTeamError } from "./teams";

function adminArgs(name = uniq("Team ")) {
  return {
    name,
    adminName: "Team Admin",
    adminEmail: `${uniq("ta-")}@test.local`,
    adminPassword: "pw123456",
  };
}

describe("createTeamWithAdmin", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates the team, its one admin, and the team's copy of the template", async () => {
    const co = await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team, admin } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Lankaran"));

    expect(team.companyId).toBe(co.id);
    expect(team.name).toBe("Lankaran");
    expect(admin.role).toBe("COMPANY_ADMIN");
    expect(admin.teamId).toBe(team.id);
    expect(admin.companyId).toBe(co.id);
    expect(admin.status).toBe("ACTIVE");
    expect(await verifyPassword("pw123456", admin.passwordHash)).toBe(true);

    const stages = await testPrisma.stage.findMany({ where: { teamId: team.id }, orderBy: { order: "asc" } });
    expect(stages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    const defs = await testPrisma.accountFieldDef.findMany({ where: { teamId: team.id }, orderBy: { order: "asc" } });
    expect(defs.map((d) => d.label)).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.label));
    // The first team of a fresh org also leaves the org template behind for the next one.
    expect(await testPrisma.stage.count({ where: { companyId: co.id, teamId: null } })).toBe(
      DEFAULT_STAGES.length,
    );
  });

  it("normalizes the team name and rejects a blank one", async () => {
    await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team } = await createTeamWithAdmin(testPrisma, sa, adminArgs("  Baku   Centre  "));
    expect(team.name).toBe("Baku Centre");
    await expect(createTeamWithAdmin(testPrisma, sa, adminArgs("   "))).rejects.toThrow(InvalidTeamError);
  });

  it("accepts an explicitly named company when more than one exists", async () => {
    const a = await makeCompany();
    await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    // Ambiguous without a companyId, resolved with one.
    await expect(createTeamWithAdmin(testPrisma, sa, adminArgs())).rejects.toThrow(InvalidTeamError);
    const { team } = await createTeamWithAdmin(testPrisma, sa, { ...adminArgs(), companyId: a.id });
    expect(team.companyId).toBe(a.id);
  });

  it("is SUPER_ADMIN-only", async () => {
    const { suAdmin, suMember } = await makeTeamWithUsers();
    await expect(createTeamWithAdmin(testPrisma, suAdmin, adminArgs())).rejects.toThrow(ForbiddenError);
    await expect(createTeamWithAdmin(testPrisma, suMember, adminArgs())).rejects.toThrow(ForbiddenError);
    expect(await testPrisma.team.count()).toBe(1);
  });

  it("refuses a suspended company", async () => {
    const co = await makeCompany();
    await testPrisma.company.update({ where: { id: co.id }, data: { status: "SUSPENDED" } });
    const sa = su(await makeUser("SUPER_ADMIN"));
    await expect(createTeamWithAdmin(testPrisma, sa, adminArgs())).rejects.toThrow(InvalidTeamError);
    expect(await testPrisma.team.count()).toBe(0);
  });

  it("rejects a duplicate team name in the same company", async () => {
    await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    await createTeamWithAdmin(testPrisma, sa, adminArgs("Sumqayit"));
    await expect(createTeamWithAdmin(testPrisma, sa, adminArgs("Sumqayit"))).rejects.toThrow();
    expect(await testPrisma.team.count()).toBe(1);
  });

  // The whole point of doing this in ONE transaction: a team with no admin cannot be
  // administered, and a team with no stages cannot hold a lead, so a half-built team must not
  // survive a failure.
  it("rolls the team and its template back when the admin email is taken", async () => {
    const co = await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const taken = await makeUser("MEMBER", await makeTeam({ companyId: co.id }));
    const before = await testPrisma.team.count();
    await expect(
      createTeamWithAdmin(testPrisma, sa, { ...adminArgs("Ganja"), adminEmail: taken.email }),
    ).rejects.toThrow();
    expect(await testPrisma.team.count()).toBe(before);
    expect(await testPrisma.team.findFirst({ where: { name: "Ganja" } })).toBeNull();
    expect(await testPrisma.stage.count({ where: { teamId: { not: null } } })).toBe(0);
  });
});

describe("the org template is read ONCE, at team-creation time", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("a later template edit does not reach back into an existing team", async () => {
    const co = await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team: first } = await createTeamWithAdmin(testPrisma, sa, adminArgs("First"));

    // Edit the org template AFTER the team exists: rename a stage, drop one, add a field.
    await testPrisma.stage.updateMany({
      where: { companyId: co.id, teamId: null, name: "Qualified" },
      data: { name: "Site Visit" },
    });
    await testPrisma.stage.deleteMany({ where: { companyId: co.id, teamId: null, name: "Proposal" } });
    await testPrisma.accountFieldDef.create({
      data: { companyId: co.id, teamId: null, label: "Floors", type: "NUMBER", order: 99 },
    });

    const firstStages = await testPrisma.stage.findMany({ where: { teamId: first.id }, orderBy: { order: "asc" } });
    expect(firstStages.map((s) => s.name)).toEqual(DEFAULT_STAGES.map((s) => s.name));
    const firstDefs = await testPrisma.accountFieldDef.findMany({ where: { teamId: first.id } });
    expect(firstDefs.map((d) => d.label).sort()).toEqual(TEMPLATE_FIELD_DEFS.map((d) => d.label).sort());

    // ...but the NEXT team is created from the edited template.
    const { team: second } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Second"));
    const secondStages = await testPrisma.stage.findMany({ where: { teamId: second.id }, orderBy: { order: "asc" } });
    expect(secondStages.map((s) => s.name)).toContain("Site Visit");
    expect(secondStages.map((s) => s.name)).not.toContain("Proposal");
    const secondDefs = await testPrisma.accountFieldDef.findMany({ where: { teamId: second.id } });
    expect(secondDefs.map((d) => d.label)).toContain("Floors");
  });

  it("a team's own edits never leak into the template or into a sibling team", async () => {
    const co = await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team: mine } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Mine"));
    const { team: theirs } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Theirs"));

    await testPrisma.stage.updateMany({ where: { teamId: mine.id, name: "New" }, data: { name: "Walk-in" } });

    const template = await testPrisma.stage.findMany({ where: { companyId: co.id, teamId: null } });
    expect(template.map((s) => s.name)).toContain("New");
    expect(template.map((s) => s.name)).not.toContain("Walk-in");
    const sibling = await testPrisma.stage.findMany({ where: { teamId: theirs.id } });
    expect(sibling.map((s) => s.name)).not.toContain("Walk-in");
  });
});

describe("listTeams / renameTeam", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("lists every team with its admin and active seat counts", async () => {
    const co = await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team, admin } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Alpha"));
    const member = await makeUser("MEMBER", team);
    const gone = await makeUser("MEMBER", team);
    await testPrisma.user.update({ where: { id: gone.id }, data: { status: "INACTIVE" } });
    await createTeamWithAdmin(testPrisma, sa, adminArgs("Beta"));

    const rows = await listTeams(testPrisma, sa, { companyId: co.id });
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Beta"]);
    const alpha = rows[0];
    expect(alpha.admin).toEqual({ id: admin.id, name: admin.name, email: admin.email });
    expect(alpha.admins).toBe(1);
    // The deactivated member is not a seat the owner has to think about.
    expect(alpha.members).toBe(1);
    expect(member.teamId).toBe(team.id);
  });

  it("is SUPER_ADMIN-only", async () => {
    const { suAdmin, suMember } = await makeTeamWithUsers();
    await expect(listTeams(testPrisma, suAdmin)).rejects.toThrow(ForbiddenError);
    await expect(renameTeam(testPrisma, suMember, "x", "y")).rejects.toThrow(ForbiddenError);
  });

  it("renames a team, trimming the new name", async () => {
    await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Old"));
    const renamed = await renameTeam(testPrisma, sa, team.id, "  New   Name ");
    expect(renamed.name).toBe("New Name");
  });

  it("refuses an unknown team, a blank name and a name already taken", async () => {
    await makeCompany();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const { team } = await createTeamWithAdmin(testPrisma, sa, adminArgs("Keep"));
    await createTeamWithAdmin(testPrisma, sa, adminArgs("Taken"));
    await expect(renameTeam(testPrisma, sa, "does-not-exist", "Whatever")).rejects.toThrow(NotFoundError);
    await expect(renameTeam(testPrisma, sa, team.id, "  ")).rejects.toThrow(InvalidTeamError);
    await expect(renameTeam(testPrisma, sa, team.id, "Taken")).rejects.toThrow();
    const still = await testPrisma.team.findUniqueOrThrow({ where: { id: team.id } });
    expect(still.name).toBe("Keep");
  });

  it("a team in another company is not renameable through the owner's own company context", async () => {
    const mine = await makeCompany();
    const other = await makeCompany();
    const otherTeam = await makeTeam({ companyId: other.id, name: "Theirs" });
    // An owner pinned to one company (the production shape after --promote).
    const sa = su(await makeUser("SUPER_ADMIN", undefined, {}));
    await testPrisma.user.update({ where: { id: sa.id }, data: { companyId: mine.id } });
    const pinned = { ...sa, companyId: mine.id };
    await expect(renameTeam(testPrisma, pinned, otherTeam.id, "Mine now")).rejects.toThrow(NotFoundError);
    await seedOrgTemplate(testPrisma, mine.id);
    expect(await listTeams(testPrisma, pinned)).toEqual([]);
  });
});
