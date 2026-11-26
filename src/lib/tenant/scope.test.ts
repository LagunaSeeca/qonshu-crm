import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere, accountScopeWhere, resolveAssignableOwner, resolveLeadOwner } from "./scope";

// PURE UNIT, no database. leadScopeWhere/accountScopeWhere take no db at all, and
// resolveAssignableOwner gets a hand-made user reader — so every rule, including the
// fail-closed ones that are awkward to seed (a member with no team, an INACTIVE owner, a
// PARTNER_VIEWER named as an owner), is covered here rather than left to integration tests.
//
// The rewrite of visibility.test.ts: that file tested `shareAllLeads` true/false, a toggle that
// no longer exists. Member isolation is now absolute.

const CO = "co1";
const T1 = "team1";
const T2 = "team2";

function session(role: Role, over: Partial<SessionUser> = {}): SessionUser {
  const scoped = role === "COMPANY_ADMIN" || role === "MEMBER";
  return {
    id: `u-${role}`,
    companyId: role === "SUPER_ADMIN" ? null : CO,
    teamId: scoped ? T1 : null,
    role,
    accountId: null,
    ...over,
  };
}

type Row = { id: string; role: Role; status: "ACTIVE" | "INACTIVE"; companyId: string | null; teamId: string | null };
type Reader = Parameters<typeof resolveAssignableOwner>[0];

function reader(...rows: Row[]): Reader {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    },
  } as unknown as Reader;
}

// Proves a path never touches the database, rather than just asserting its return value.
const noReader = () =>
  ({
    user: {
      findUnique: () => {
        throw new Error("resolveAssignableOwner must not query the database on this path");
      },
    },
  }) as unknown as Reader;

const member = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, role: "MEMBER", status: "ACTIVE", companyId: CO, teamId: T1, ...over });

describe("leadScopeWhere", () => {
  it("MEMBER sees only their own leads, inside their own team", () => {
    const u = session("MEMBER", { id: "m1" });
    // toEqual, not toMatchObject: a dropped key here is not a narrower filter, it is the whole
    // company. The exact shape is the contract.
    expect(leadScopeWhere(u)).toEqual({ companyId: CO, teamId: T1, ownerId: "m1" });
  });

  it("MEMBER isolation cannot be widened by anything (no toggle exists any more)", () => {
    const a = leadScopeWhere(session("MEMBER", { id: "m1" }));
    const b = leadScopeWhere(session("MEMBER", { id: "m1" }));
    expect(a).toEqual(b);
    expect(a.ownerId).toBe("m1");
  });

  it("COMPANY_ADMIN sees their whole team and no other", () => {
    expect(leadScopeWhere(session("COMPANY_ADMIN"))).toEqual({ companyId: CO, teamId: T1 });
  });

  it("SUPER_ADMIN given a company context sees every team in it", () => {
    expect(leadScopeWhere(session("SUPER_ADMIN", { companyId: CO }))).toEqual({ companyId: CO });
  });

  it("PARTNER_VIEWER is refused the CRM outright", () => {
    expect(() => leadScopeWhere(session("PARTNER_VIEWER", { accountId: "a1" }))).toThrow(ForbiddenError);
  });

  // Fail-closed set: each of these would otherwise emit a where-clause missing a key.
  it("fails closed for a COMPANY_ADMIN with no team", () => {
    expect(() => leadScopeWhere(session("COMPANY_ADMIN", { teamId: null }))).toThrow(ForbiddenError);
  });

  it("fails closed for a MEMBER with no team", () => {
    expect(() => leadScopeWhere(session("MEMBER", { teamId: null }))).toThrow(ForbiddenError);
  });

  it("fails closed with no company context, including for a SUPER_ADMIN", () => {
    expect(() => leadScopeWhere(session("MEMBER", { companyId: null }))).toThrow(ForbiddenError);
    expect(() => leadScopeWhere(session("SUPER_ADMIN"))).toThrow(ForbiddenError);
  });
});

describe("leadScopeWhere — ONBOARDING", () => {
  // THE SINGLE THROW THAT CLOSES THE WHOLE CRM. getDashboardStats, getReport, getMyWork, leads.ts
  // and stages.ts all resolve their scope through leadScopeWhere, so this one assertion is the
  // regression guard for every one of those surfaces at once.
  it("ONBOARDING is refused the CRM outright, and company/team context cannot buy it in", () => {
    expect(() => leadScopeWhere(session("ONBOARDING", { companyId: CO }))).toThrow(ForbiddenError);
    // Not an accident of the missing team: even handed one, the answer is the same.
    expect(() => leadScopeWhere(session("ONBOARDING", { companyId: CO, teamId: T1 }))).toThrow(ForbiddenError);
  });
});

describe("accountScopeWhere", () => {
  // THE MEMBER RELAXATION. This used to be `{ companyId, teamId, accountManagerId: "m1" }` — own
  // rows only. Several sales managers now work one building, so access is manager OR assigned.
  //
  // toEqual on the WHOLE object, not toMatchObject: a dropped key here is not a narrower filter,
  // it is the whole company. The exact shape is the contract, and `AND` holding the membership
  // test is the part callers must compose with rather than spread over (see the composition rule
  // in scope.ts, and the listAccounts test in team-isolation.test.ts that proves it).
  it("MEMBER sees the accounts they manage OR are assigned to, inside their own team", () => {
    expect(accountScopeWhere(session("MEMBER", { id: "m1" }))).toEqual({
      companyId: CO,
      teamId: T1,
      AND: [{ OR: [{ accountManagerId: "m1" }, { assignments: { some: { userId: "m1" } } }] }],
    });
  });

  it("MEMBER keeps its TEAM key, so an assignment cannot reach into another team's book", () => {
    const where = accountScopeWhere(session("MEMBER", { id: "m1" }));
    // The relaxation is strictly WITHIN the member's own team. Losing this key would turn an
    // AccountAssignment row into a cross-team grant, which nobody is entitled to issue.
    expect(where.teamId).toBe(T1);
    expect(where.companyId).toBe(CO);
  });

  it("ONBOARDING sees ONLY assigned accounts: company-wide, no team read, no company read", () => {
    expect(accountScopeWhere(session("ONBOARDING", { id: "ob1", companyId: CO }))).toEqual({
      companyId: CO,
      AND: [{ assignments: { some: { userId: "ob1" } } }],
    });
  });

  it("ONBOARDING carries NO teamId key, and a stray team on the session does not add one", () => {
    const where = accountScopeWhere(session("ONBOARDING", { id: "ob1", companyId: CO }));
    // Deliberate: activation staff serve every team, so requireTeam would refuse all of them. The
    // assignment test in `AND` is what selects rows — an inclusion list, so no assignments means
    // no rows, which is the fail-closed direction.
    expect(where.teamId).toBeUndefined();
    expect("teamId" in where).toBe(false);
    const withTeam = accountScopeWhere(session("ONBOARDING", { id: "ob1", companyId: CO, teamId: T1 }));
    expect(withTeam.teamId).toBeUndefined();
  });

  it("ONBOARDING fails closed with no company context", () => {
    expect(() => accountScopeWhere(session("ONBOARDING", { companyId: null }))).toThrow(ForbiddenError);
  });

  // `scope.companyId` is read straight off the returned object by service-fees.ts, settlements.ts
  // and accounts.ts getAccount. If it ever moved inside the AND, those callers would silently get
  // `undefined` — which in a Prisma WHERE is no filter at all.
  it("companyId is a TOP-LEVEL key in every branch", () => {
    for (const u of [
      session("MEMBER", { id: "m1" }),
      session("COMPANY_ADMIN"),
      session("SUPER_ADMIN", { companyId: CO }),
      session("ONBOARDING", { id: "ob1", companyId: CO }),
      session("PARTNER_VIEWER", { accountId: "a1" }),
    ]) {
      expect(accountScopeWhere(u).companyId).toBe(CO);
    }
  });

  it("COMPANY_ADMIN sees their whole team", () => {
    expect(accountScopeWhere(session("COMPANY_ADMIN"))).toEqual({ companyId: CO, teamId: T1 });
  });

  it("SUPER_ADMIN given a company context sees all of it", () => {
    expect(accountScopeWhere(session("SUPER_ADMIN", { companyId: CO }))).toEqual({ companyId: CO });
  });

  it("PARTNER_VIEWER is pinned to its one account", () => {
    expect(accountScopeWhere(session("PARTNER_VIEWER", { accountId: "a1" }))).toEqual({
      companyId: CO, id: "a1",
    });
  });

  it("PARTNER_VIEWER with no account matches nothing instead of the whole company", () => {
    const where = accountScopeWhere(session("PARTNER_VIEWER", { accountId: null }));
    expect(where.id).toBe("__no_access__");
    expect(where).toEqual({ companyId: CO, id: "__no_access__" });
  });

  it("fails closed for a team-scoped role with no team, and with no company", () => {
    expect(() => accountScopeWhere(session("MEMBER", { teamId: null }))).toThrow(ForbiddenError);
    expect(() => accountScopeWhere(session("COMPANY_ADMIN", { teamId: null }))).toThrow(ForbiddenError);
    expect(() => accountScopeWhere(session("SUPER_ADMIN"))).toThrow(ForbiddenError);
  });
});

describe("resolveAssignableOwner", () => {
  it("MEMBER is always the owner, and a supplied ownerId is ignored without a query", async () => {
    const u = session("MEMBER", { id: "m1" });
    await expect(resolveAssignableOwner(noReader(), u, "someone-else")).resolves.toEqual({
      ownerId: "m1", teamId: T1,
    });
    await expect(resolveAssignableOwner(noReader(), u)).resolves.toEqual({ ownerId: "m1", teamId: T1 });
  });

  it("MEMBER with no team fails closed", async () => {
    await expect(
      resolveAssignableOwner(noReader(), session("MEMBER", { teamId: null })),
    ).rejects.toThrow(ForbiddenError);
  });

  it("admin defaults to self without a query", async () => {
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(resolveAssignableOwner(noReader(), admin)).resolves.toEqual({ ownerId: "a1", teamId: T1 });
    await expect(resolveAssignableOwner(noReader(), admin, "a1")).resolves.toEqual({ ownerId: "a1", teamId: T1 });
  });

  it("admin may assign an ACTIVE member or admin of their own team", async () => {
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(resolveAssignableOwner(reader(member("m2")), admin, "m2")).resolves.toEqual({
      ownerId: "m2", teamId: T1,
    });
    const peer = member("a2", { role: "COMPANY_ADMIN" });
    await expect(resolveAssignableOwner(reader(peer), admin, "a2")).resolves.toEqual({
      ownerId: "a2", teamId: T1,
    });
  });

  it("admin may NOT assign across teams or companies", async () => {
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(
      resolveAssignableOwner(reader(member("m3", { teamId: T2 })), admin, "m3"),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveAssignableOwner(reader(member("m4", { companyId: "other" })), admin, "m4"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("admin may not assign an INACTIVE user, an unknown id, a super admin or a partner", async () => {
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(
      resolveAssignableOwner(reader(member("m5", { status: "INACTIVE" })), admin, "m5"),
    ).rejects.toThrow(ForbiddenError);
    await expect(resolveAssignableOwner(reader(), admin, "ghost")).rejects.toThrow(ForbiddenError);
    await expect(
      resolveAssignableOwner(reader(member("sa", { role: "SUPER_ADMIN", companyId: null, teamId: null })), admin, "sa"),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveAssignableOwner(reader(member("pv", { role: "PARTNER_VIEWER", teamId: null })), admin, "pv"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("SUPER_ADMIN must name an owner, and inherits that owner's team", async () => {
    const sa = session("SUPER_ADMIN");
    await expect(resolveAssignableOwner(noReader(), sa)).rejects.toThrow(ForbiddenError);
    await expect(
      resolveAssignableOwner(reader(member("m6", { companyId: "other", teamId: T2 })), sa, "m6"),
    ).resolves.toEqual({ ownerId: "m6", teamId: T2 });
  });

  it("SUPER_ADMIN may not assign a user who is on no team, nor another super admin", async () => {
    const sa = session("SUPER_ADMIN");
    await expect(
      resolveAssignableOwner(reader(member("m7", { teamId: null })), sa, "m7"),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveAssignableOwner(reader(member("sa2", { role: "SUPER_ADMIN", companyId: null, teamId: null })), sa, "sa2"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("PARTNER_VIEWER cannot assign anything", async () => {
    await expect(
      resolveAssignableOwner(noReader(), session("PARTNER_VIEWER", { accountId: "a1" }), "m1"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("ONBOARDING can neither assign nor be assigned", async () => {
    // Cannot ASSIGN: refused before any query, so onboarding staff cannot create owned records.
    await expect(
      resolveAssignableOwner(noReader(), session("ONBOARDING", { companyId: CO }), "m1"),
    ).rejects.toThrow(ForbiddenError);
    // Cannot BE assigned: OWNABLE_ROLES is an allowlist of COMPANY_ADMIN/MEMBER, so an onboarding
    // user named as a Lead owner or Account manager is refused at loadOwnable. This is what keeps
    // the role out of every owner picker's accepted set, not just out of the picker's options.
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(
      resolveAssignableOwner(reader(member("ob1", { role: "ONBOARDING", teamId: null })), admin, "ob1"),
    ).rejects.toThrow(ForbiddenError);
    const sa = session("SUPER_ADMIN");
    await expect(
      resolveAssignableOwner(reader(member("ob2", { role: "ONBOARDING", teamId: null })), sa, "ob2"),
    ).rejects.toThrow(ForbiddenError);
  });
});

// ===================== resolveLeadOwner — THE SUPER ADMIN AS A LEAD OWNER =====================
//
// The ONLY widening in this area: a SUPER_ADMIN may name ITSELF as the owner of a LEAD, with an
// explicit team. Everything else — who else may name it, what an account manager may be — must be
// exactly as before, which is what the delegation tests at the end of this block pin.

type TeamRow = { id: string; companyId: string };
type LeadReader = Parameters<typeof resolveLeadOwner>[0];

// A reader with a Team delegate as well as a User one. resolveLeadOwner validates the NAMED team
// against the database, because a teamId is client input that decides which book a lead lands in.
function leadReader(rows: Row[], teams: TeamRow[] = [{ id: T1, companyId: CO }]): LeadReader {
  return {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
    },
    team: {
      findUnique: async ({ where }: { where: { id: string } }) => teams.find((t) => t.id === where.id) ?? null,
    },
  } as unknown as LeadReader;
}

// The owner as it really exists: a SUPER_ADMIN row DOES carry a companyId (prisma/seed.ts); only
// its teamId is null. That missing team is the whole problem this function solves.
const superAdminRow = (id: string, over: Partial<Row> = {}): Row =>
  ({ id, role: "SUPER_ADMIN", status: "ACTIVE", companyId: CO, teamId: null, ...over });

describe("resolveLeadOwner — SUPER_ADMIN lead ownership", () => {
  const sa = (over: Partial<SessionUser> = {}) =>
    session("SUPER_ADMIN", { id: "sa1", companyId: CO, ...over });

  it("the super admin may own a lead by naming ITSELF and a team in its own company", async () => {
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1")]), sa(), "sa1", T1),
    ).resolves.toEqual({ ownerId: "sa1", teamId: T1 });
  });

  it("refuses the super admin naming itself with NO team", async () => {
    // Lead.teamId is NOT NULL and the owner has no team of its own, so there is no sane default.
    // A silent one would park the lead in whichever team a later line happened to pick.
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1")]), sa(), "sa1"),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a team that belongs to another company", async () => {
    const reader = leadReader([superAdminRow("sa1")], [{ id: T2, companyId: "other" }]);
    await expect(resolveLeadOwner(reader, sa(), "sa1", T2)).rejects.toThrow(ForbiddenError);
    // And a team id that does not exist at all is the same refusal, not a fallback.
    await expect(resolveLeadOwner(reader, sa(), "sa1", "ghost-team")).rejects.toThrow(ForbiddenError);
  });

  it("refuses an INACTIVE super admin", async () => {
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1", { status: "INACTIVE" })]), sa(), "sa1", T1),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses when the ROW disagrees with the session (forged or stale)", async () => {
    // Session claims SUPER_ADMIN of CO; the row says otherwise. The row wins.
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1", { companyId: "other" })]), sa(), "sa1", T1),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1", { role: "COMPANY_ADMIN", teamId: T2 })]), sa(), "sa1", T1),
    ).rejects.toThrow(ForbiddenError);
    await expect(resolveLeadOwner(leadReader([]), sa(), "sa1", T1)).rejects.toThrow(ForbiddenError);
  });

  it("refuses a super admin with no company context at all", async () => {
    // The unscoped owner session (companyId null) still fails closed, exactly as every other
    // super-admin read in this module does.
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1")]), sa({ companyId: null }), "sa1", T1),
    ).rejects.toThrow(ForbiddenError);
  });

  it("refuses a super admin naming a DIFFERENT super admin, including one from another company", async () => {
    // Only self. Anybody else goes down the unchanged path and hits OWNABLE_ROLES.
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa2")]), sa(), "sa2", T1),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa2", { companyId: "other" })]), sa(), "sa2", T1),
    ).rejects.toThrow(ForbiddenError);
  });

  it("a COMPANY_ADMIN naming the super admin is REFUSED, with the usual non-assignable message", async () => {
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(
      resolveLeadOwner(leadReader([superAdminRow("sa1")]), admin, "sa1", T1),
    ).rejects.toThrow("a SUPER_ADMIN cannot own records");
  });

  it("a MEMBER naming the super admin gets the existing behaviour: itself", async () => {
    // Unchanged and deliberately NOT an error: every create form posts the field, and a member
    // tampering with it must get a value with no effect rather than something to probe.
    const m = session("MEMBER", { id: "m1" });
    await expect(resolveLeadOwner(leadReader([superAdminRow("sa1")]), m, "sa1", T2))
      .resolves.toEqual({ ownerId: "m1", teamId: T1 });
  });

  it("the teamId argument is INERT for everyone but the self-naming super admin", async () => {
    // The forged-teamId bug this whole area exists to prevent: a team admin cannot use the new
    // argument to put a lead anywhere but its own team.
    const admin = session("COMPANY_ADMIN", { id: "a1" });
    await expect(resolveLeadOwner(leadReader([member("m2")]), admin, "m2", T2))
      .resolves.toEqual({ ownerId: "m2", teamId: T1 });
    await expect(resolveLeadOwner(leadReader([]), admin, undefined, T2))
      .resolves.toEqual({ ownerId: "a1", teamId: T1 });
  });

  it("delegates every other case to resolveAssignableOwner unchanged", async () => {
    const saSess = session("SUPER_ADMIN", { id: "sa1", companyId: CO });
    // A super admin naming a real team member still inherits THAT member's team.
    await expect(resolveLeadOwner(leadReader([member("m6", { teamId: T2 })]), saSess, "m6"))
      .resolves.toEqual({ ownerId: "m6", teamId: T2 });
    // Partners and onboarding staff are refused before any query, as before.
    await expect(
      resolveLeadOwner(leadReader([]), session("PARTNER_VIEWER", { accountId: "a1" }), "m1", T1),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      resolveLeadOwner(leadReader([]), session("ONBOARDING", { companyId: CO }), "m1", T1),
    ).rejects.toThrow(ForbiddenError);
  });
});
