import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { Team, User } from "@prisma/client";
import { testPrisma, resetDb } from "@/test/db";
import { buildingKey, makeTeam, makeTeamWithUsers, makeUser, su, uniq } from "@/test/fixtures";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import {
  createUser,
  getUser,
  listAssignableUsers,
  listUsers,
  setUserStatus,
  InvalidUserRoleError,
} from "./users";

// A building (Account) owned by `team`, which is what a PARTNER_VIEWER login is pinned to.
async function makeAccount(team: Team, manager: User) {
  const name = uniq("Bldg ");
  return testPrisma.account.create({
    data: {
      companyId: team.companyId,
      teamId: team.id,
      name,
      buildingKey: buildingKey(name),
      accountManagerId: manager.id,
    },
  });
}

function creds(role: "COMPANY_ADMIN" | "MEMBER" | "PARTNER_VIEWER") {
  return { name: "New Person", email: `${uniq("new-")}@test.local`, password: "pw123456", role } as const;
}

describe("createUser — who may create whom", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("a team admin creates a MEMBER in its OWN team, hashed and active", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    const created = await createUser(testPrisma, suAdmin, creds("MEMBER"));
    expect(created.teamId).toBe(team.id);
    expect(created.companyId).toBe(team.companyId);
    expect(created.status).toBe("ACTIVE");
    expect(created.accountId).toBeNull();
    expect(await verifyPassword("pw123456", created.passwordHash)).toBe(true);
  });

  it("a team admin passing its own teamId explicitly still succeeds", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    const created = await createUser(testPrisma, suAdmin, { ...creds("MEMBER"), teamId: team.id });
    expect(created.teamId).toBe(team.id);
  });

  // The cross-tenant guard: another team's id is REJECTED, not quietly replaced with their own.
  it("a team admin cannot create a user in ANOTHER team", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    const other = await makeTeam({ companyId: team.companyId });
    await expect(
      createUser(testPrisma, suAdmin, { ...creds("MEMBER"), teamId: other.id }),
    ).rejects.toThrow(InvalidUserRoleError);
    expect(await testPrisma.user.count({ where: { teamId: other.id } })).toBe(0);
  });

  it("only the super admin creates team admins", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    await expect(createUser(testPrisma, suAdmin, creds("COMPANY_ADMIN"))).rejects.toThrow(ForbiddenError);
  });

  it("the super admin creates a COMPANY_ADMIN for a named team", async () => {
    const team = await makeTeam();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const created = await createUser(testPrisma, sa, { ...creds("COMPANY_ADMIN"), teamId: team.id });
    expect(created.role).toBe("COMPANY_ADMIN");
    expect(created.teamId).toBe(team.id);
    expect(created.companyId).toBe(team.companyId);
  });

  it("the super admin must name a team (no silent default)", async () => {
    await makeTeam();
    const sa = su(await makeUser("SUPER_ADMIN"));
    await expect(createUser(testPrisma, sa, creds("MEMBER"))).rejects.toThrow(InvalidUserRoleError);
  });

  it("the super admin naming a nonexistent team is a 404-shaped failure", async () => {
    const sa = su(await makeUser("SUPER_ADMIN"));
    await expect(
      createUser(testPrisma, sa, { ...creds("MEMBER"), teamId: "does-not-exist" }),
    ).rejects.toThrow(NotFoundError);
  });

  it("a MEMBER cannot create users", async () => {
    const { suMember } = await makeTeamWithUsers();
    await expect(createUser(testPrisma, suMember, creds("MEMBER"))).rejects.toThrow(ForbiddenError);
  });

  it("a PARTNER_VIEWER cannot create users", async () => {
    const { team, admin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    const partner = su(await makeUser("PARTNER_VIEWER", team, { accountId: account.id }));
    await expect(createUser(testPrisma, partner, creds("MEMBER"))).rejects.toThrow(ForbiddenError);
  });

  it("a second SUPER_ADMIN cannot be minted through this path", async () => {
    const team = await makeTeam();
    const sa = su(await makeUser("SUPER_ADMIN"));
    await expect(
      createUser(testPrisma, sa, {
        name: "Second Owner",
        email: `${uniq("owner-")}@test.local`,
        password: "pw123456",
        role: "SUPER_ADMIN",
        teamId: team.id,
      }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("refuses to provision a login into a SUSPENDED company — for a team admin", async () => {
    const { team, suAdmin } = await makeTeamWithUsers();
    await testPrisma.company.update({ where: { id: team.companyId }, data: { status: "SUSPENDED" } });
    await expect(createUser(testPrisma, suAdmin, creds("MEMBER"))).rejects.toThrow(InvalidUserRoleError);
  });

  it("refuses to provision a login into a SUSPENDED company — for the super admin too", async () => {
    const team = await makeTeam();
    await testPrisma.company.update({ where: { id: team.companyId }, data: { status: "SUSPENDED" } });
    const sa = su(await makeUser("SUPER_ADMIN"));
    await expect(
      createUser(testPrisma, sa, { ...creds("MEMBER"), teamId: team.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("duplicate email is rejected", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    const first = creds("MEMBER");
    await createUser(testPrisma, suAdmin, first);
    await expect(createUser(testPrisma, suAdmin, first)).rejects.toThrow();
  });
});

describe("createUser — PARTNER_VIEWER building logins", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("a team admin creates a partner login for its OWN team's account, with no team", async () => {
    const { team, admin, suAdmin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    const created = await createUser(testPrisma, suAdmin, { ...creds("PARTNER_VIEWER"), accountId: account.id });
    expect(created.role).toBe("PARTNER_VIEWER");
    expect(created.accountId).toBe(account.id);
    expect(created.teamId).toBeNull();
    expect(created.companyId).toBe(team.companyId);
  });

  it("a team admin cannot create a partner login for ANOTHER team's account", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    const theirAccount = await makeAccount(theirs.team, theirs.admin);
    await expect(
      createUser(testPrisma, mine.suAdmin, { ...creds("PARTNER_VIEWER"), accountId: theirAccount.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("the super admin creates a partner login for any team's account", async () => {
    const { team, admin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    const sa = su(await makeUser("SUPER_ADMIN"));
    const created = await createUser(testPrisma, sa, { ...creds("PARTNER_VIEWER"), accountId: account.id });
    expect(created.accountId).toBe(account.id);
    expect(created.teamId).toBeNull();
    expect(created.companyId).toBe(team.companyId);
  });

  it("a partner login without an accountId is rejected", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    await expect(createUser(testPrisma, suAdmin, creds("PARTNER_VIEWER"))).rejects.toThrow(InvalidUserRoleError);
  });

  it("a partner login with a teamId is rejected (a partner has no team)", async () => {
    const { team, admin, suAdmin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    await expect(
      createUser(testPrisma, suAdmin, { ...creds("PARTNER_VIEWER"), accountId: account.id, teamId: team.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });

  it("a non-partner role with an accountId is rejected", async () => {
    const { team, admin, suAdmin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    await expect(
      createUser(testPrisma, suAdmin, { ...creds("MEMBER"), accountId: account.id }),
    ).rejects.toThrow(InvalidUserRoleError);
  });
});

describe("listUsers — team scope", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  async function twoTeams() {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    const myAccount = await makeAccount(mine.team, mine.admin);
    const theirAccount = await makeAccount(theirs.team, theirs.admin);
    const myPartner = await makeUser("PARTNER_VIEWER", mine.team, { accountId: myAccount.id });
    const theirPartner = await makeUser("PARTNER_VIEWER", theirs.team, { accountId: theirAccount.id });
    return { mine, theirs, myPartner, theirPartner };
  }

  it("a team admin sees its own team plus the partner logins of its own buildings", async () => {
    const { mine, myPartner, theirs, theirPartner } = await twoTeams();
    const emails = (await listUsers(testPrisma, mine.suAdmin)).map((u) => u.email).sort();
    expect(emails).toEqual([mine.admin.email, mine.member.email, myPartner.email].sort());
    expect(emails).not.toContain(theirs.admin.email);
    expect(emails).not.toContain(theirPartner.email);
  });

  it("a team admin cannot list another team by naming its id", async () => {
    const { mine, theirs } = await twoTeams();
    await expect(listUsers(testPrisma, mine.suAdmin, { teamId: theirs.team.id })).rejects.toThrow(ForbiddenError);
  });

  it("the super admin sees everyone, and may filter to one team", async () => {
    const { mine, theirs, myPartner, theirPartner } = await twoTeams();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const all = (await listUsers(testPrisma, sa)).map((u) => u.email);
    for (const e of [mine.admin.email, mine.member.email, myPartner.email, theirs.admin.email, theirPartner.email]) {
      expect(all).toContain(e);
    }
    const filtered = (await listUsers(testPrisma, sa, { teamId: theirs.team.id })).map((u) => u.email).sort();
    expect(filtered).toEqual([theirs.admin.email, theirs.member.email, theirPartner.email].sort());
  });

  it("a MEMBER and a PARTNER_VIEWER cannot list users at all", async () => {
    const { mine, myPartner } = await twoTeams();
    await expect(listUsers(testPrisma, mine.suMember)).rejects.toThrow(ForbiddenError);
    await expect(listUsers(testPrisma, su(myPartner))).rejects.toThrow(ForbiddenError);
  });

  it("a team admin with no team is refused rather than shown the company", async () => {
    const { team } = await makeTeamWithUsers();
    const teamless = await makeUser("COMPANY_ADMIN", team, { teamId: null });
    await expect(listUsers(testPrisma, su(teamless))).rejects.toThrow(ForbiddenError);
  });

  it("getUser cannot read a user outside the actor's team", async () => {
    const { mine, theirs } = await twoTeams();
    expect(await getUser(testPrisma, mine.suAdmin, theirs.member.id)).toBeNull();
    expect(await getUser(testPrisma, mine.suAdmin, mine.member.id)).not.toBeNull();
  });
});

describe("listAssignableUsers — owner/assignee pickers", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("offers a team admin only its own team's ACTIVE admins and members", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    const account = await makeAccount(mine.team, mine.admin);
    // The bug this kills: a building's representative, and a deactivated member, used to be
    // offered as the owner of a lead because the picker was fed by listUsers.
    const partner = await makeUser("PARTNER_VIEWER", mine.team, { accountId: account.id });
    const gone = await makeUser("MEMBER", mine.team);
    await testPrisma.user.update({ where: { id: gone.id }, data: { status: "INACTIVE" } });

    const emails = (await listAssignableUsers(testPrisma, mine.suAdmin)).map((u) => u.email).sort();
    expect(emails).toEqual([mine.admin.email, mine.member.email].sort());
    expect(emails).not.toContain(partner.email);
    expect(emails).not.toContain(gone.email);
    expect(emails).not.toContain(theirs.member.email);
  });

  it("offers a MEMBER only themselves", async () => {
    const { member, suMember } = await makeTeamWithUsers();
    const rows = await listAssignableUsers(testPrisma, suMember);
    expect(rows.map((u) => u.id)).toEqual([member.id]);
  });

  it("offers the super admin every active admin and member, never a partner", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    const account = await makeAccount(mine.team, mine.admin);
    const partner = await makeUser("PARTNER_VIEWER", mine.team, { accountId: account.id });
    const sa = su(await makeUser("SUPER_ADMIN"));
    const emails = (await listAssignableUsers(testPrisma, sa)).map((u) => u.email);
    expect(emails).toContain(mine.member.email);
    expect(emails).toContain(theirs.admin.email);
    expect(emails).not.toContain(partner.email);
  });

  it("refuses a PARTNER_VIEWER outright", async () => {
    const { team, admin } = await makeTeamWithUsers();
    const account = await makeAccount(team, admin);
    const partner = await makeUser("PARTNER_VIEWER", team, { accountId: account.id });
    await expect(listAssignableUsers(testPrisma, su(partner))).rejects.toThrow(ForbiddenError);
  });
});

describe("setUserStatus", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("a team admin deactivates its own team's member", async () => {
    const { member, suAdmin } = await makeTeamWithUsers();
    const updated = await setUserStatus(testPrisma, suAdmin, member.id, "INACTIVE");
    expect(updated.status).toBe("INACTIVE");
    const reactivated = await setUserStatus(testPrisma, suAdmin, member.id, "ACTIVE");
    expect(reactivated.status).toBe("ACTIVE");
  });

  it("a team admin cannot touch another team's member", async () => {
    const mine = await makeTeamWithUsers();
    const theirs = await makeTeamWithUsers({ companyId: mine.team.companyId });
    await expect(
      setUserStatus(testPrisma, mine.suAdmin, theirs.member.id, "INACTIVE"),
    ).rejects.toThrow(NotFoundError);
    const still = await testPrisma.user.findUniqueOrThrow({ where: { id: theirs.member.id } });
    expect(still.status).toBe("ACTIVE");
  });

  it("nobody can deactivate themselves — not a team admin", async () => {
    const { admin, suAdmin } = await makeTeamWithUsers();
    await expect(setUserStatus(testPrisma, suAdmin, admin.id, "INACTIVE")).rejects.toThrow(ForbiddenError);
  });

  it("nobody can deactivate themselves — not the super admin either", async () => {
    const sa = await makeUser("SUPER_ADMIN");
    await expect(setUserStatus(testPrisma, su(sa), sa.id, "INACTIVE")).rejects.toThrow(ForbiddenError);
  });

  it("nobody can deactivate the SUPER_ADMIN", async () => {
    const { suAdmin } = await makeTeamWithUsers();
    const sa = await makeUser("SUPER_ADMIN");
    const otherSa = su(await makeUser("SUPER_ADMIN"));
    await expect(setUserStatus(testPrisma, suAdmin, sa.id, "INACTIVE")).rejects.toThrow();
    await expect(setUserStatus(testPrisma, otherSa, sa.id, "INACTIVE")).rejects.toThrow(ForbiddenError);
    const still = await testPrisma.user.findUniqueOrThrow({ where: { id: sa.id } });
    expect(still.status).toBe("ACTIVE");
  });

  it("the super admin deactivates a team admin", async () => {
    const { admin } = await makeTeamWithUsers();
    const sa = su(await makeUser("SUPER_ADMIN"));
    const updated = await setUserStatus(testPrisma, sa, admin.id, "INACTIVE");
    expect(updated.status).toBe("INACTIVE");
  });

  it("a MEMBER cannot change anyone's status", async () => {
    const { member, suMember, admin } = await makeTeamWithUsers();
    expect(member.id).not.toBe(admin.id);
    await expect(setUserStatus(testPrisma, suMember, admin.id, "INACTIVE")).rejects.toThrow(ForbiddenError);
  });
});
