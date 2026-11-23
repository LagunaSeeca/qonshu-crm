import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { makeTeam, makeTeamWithUsers, makeUser, su } from "@/test/fixtures";
import { getCurrentUser } from "./me";

describe("getCurrentUser", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns name, email, role, company and TEAM for a team member", async () => {
    const team = await makeTeam({ name: "Baku Centre" });
    const user = await makeUser("MEMBER", team, { name: "Ali Member" });
    const result = await getCurrentUser(testPrisma, su(user));
    expect(result.name).toBe("Ali Member");
    expect(result.email).toBe(user.email);
    expect(result.role).toBe("MEMBER");
    expect(result.companyName).toBe((await testPrisma.company.findUniqueOrThrow({ where: { id: team.companyId } })).name);
    // With one company the company name no longer says which book you are in; the team does.
    expect(result.teamName).toBe("Baku Centre");
  });

  it("returns the team name for a team admin too", async () => {
    const { admin, team } = await makeTeamWithUsers({ name: "Sumqayit" });
    const result = await getCurrentUser(testPrisma, su(admin));
    expect(result.role).toBe("COMPANY_ADMIN");
    expect(result.teamName).toBe(team.name);
  });

  it("returns null company and null team for the super admin", async () => {
    const sa = await makeUser("SUPER_ADMIN");
    const result = await getCurrentUser(testPrisma, su(sa));
    expect(result.companyName).toBeNull();
    expect(result.teamName).toBeNull();
  });

  it("returns a null team for a partner login, which belongs to an account not a team", async () => {
    const { team, admin } = await makeTeamWithUsers();
    const account = await testPrisma.account.create({
      data: {
        companyId: team.companyId,
        teamId: team.id,
        name: "Bldg One",
        buildingKey: "bldg one",
        accountManagerId: admin.id,
      },
    });
    const partner = await makeUser("PARTNER_VIEWER", team, { accountId: account.id });
    const result = await getCurrentUser(testPrisma, su(partner));
    expect(result.role).toBe("PARTNER_VIEWER");
    expect(result.teamName).toBeNull();
    expect(result.companyName).not.toBeNull();
  });
});
