import { describe, it, expect } from "vitest";
import { can, assertCan, assertRole, ForbiddenError, type SessionUser } from "./guards";

const su: SessionUser = { id: "1", companyId: null, teamId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "2", companyId: "c1", teamId: "t1", role: "COMPANY_ADMIN" };
const member: SessionUser = { id: "3", companyId: "c1", teamId: "t1", role: "MEMBER" };
const viewer: SessionUser = { id: "4", companyId: "c1", teamId: null, role: "PARTNER_VIEWER", accountId: "a1" };

describe("guards", () => {
  it("super admin manages companies, not company data", () => {
    expect(can(su, "manage_companies")).toBe(true);
    expect(can(admin, "manage_companies")).toBe(false);
  });
  it("company admin and super admin manage users; members do not", () => {
    expect(can(admin, "manage_users")).toBe(true);
    expect(can(su, "manage_users")).toBe(true);
    expect(can(member, "manage_users")).toBe(false);
  });
  it("assertRole throws ForbiddenError when role not allowed", () => {
    expect(() => assertRole(member, ["COMPANY_ADMIN"])).toThrow(ForbiddenError);
    expect(() => assertRole(admin, ["COMPANY_ADMIN"])).not.toThrow();
  });

  it("assertCan throws ForbiddenError when not permitted", () => {
    expect(() => assertCan(admin, "write_settlements")).toThrow(ForbiddenError);
    expect(() => assertCan(su, "write_settlements")).not.toThrow();
  });
  it("fails closed for an unknown role or action", () => {
    const ghost = { ...member, role: "FUTURE_ROLE" as never };
    for (const action of ACTIONS) expect(can(ghost, action)).toBe(false);
    expect(can(su, "nonexistent" as never)).toBe(false);
    expect(can(su, "toString" as never)).toBe(false);
  });
});

// Exhaustive role x action table. Records are typed so adding a Role or Action without a row here
// is a compile error; the runtime check below fails if a key is missing.
type A = Parameters<typeof can>[1];
const ROLES = ["SUPER_ADMIN", "COMPANY_ADMIN", "MEMBER", "PARTNER_VIEWER"] as const;
const EXPECTED: Record<A, Record<(typeof ROLES)[number], boolean>> = {
  manage_companies:    { SUPER_ADMIN: true, COMPANY_ADMIN: false, MEMBER: false, PARTNER_VIEWER: false },
  manage_users:        { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, PARTNER_VIEWER: false },
  view_payment_detail: { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, PARTNER_VIEWER: true },
  view_settlements:    { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, PARTNER_VIEWER: true },
  write_settlements:   { SUPER_ADMIN: true, COMPANY_ADMIN: false, MEMBER: false, PARTNER_VIEWER: false },
  view_object_detail:  { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, PARTNER_VIEWER: true },
};
const ACTIONS = Object.keys(EXPECTED) as A[];
const USERS = { SUPER_ADMIN: su, COMPANY_ADMIN: admin, MEMBER: member, PARTNER_VIEWER: viewer };

describe("capability matrix (role x action)", () => {
  for (const action of ACTIONS) {
    for (const role of ROLES) {
      it(`${role} ${EXPECTED[action][role] ? "can" : "cannot"} ${action}`, () => {
        expect(can(USERS[role], action)).toBe(EXPECTED[action][role]);
      });
    }
  }
});
