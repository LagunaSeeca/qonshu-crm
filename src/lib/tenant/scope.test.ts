import { describe, it, expect } from "vitest";
import type { Role } from "@prisma/client";
import { ForbiddenError, type SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere, accountScopeWhere, resolveAssignableOwner } from "./scope";

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

describe("accountScopeWhere", () => {
  it("MEMBER sees only the accounts they manage", () => {
    expect(accountScopeWhere(session("MEMBER", { id: "m1" }))).toEqual({
      companyId: CO, teamId: T1, accountManagerId: "m1",
    });
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
});
