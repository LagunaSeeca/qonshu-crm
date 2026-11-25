import { describe, it, expect } from "vitest";
import { Role } from "@prisma/client";
import { can, assertCan, assertRole, ForbiddenError, type SessionUser } from "./guards";

const su: SessionUser = { id: "1", companyId: null, teamId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "2", companyId: "c1", teamId: "t1", role: "COMPANY_ADMIN" };
const member: SessionUser = { id: "3", companyId: "c1", teamId: "t1", role: "MEMBER" };
const viewer: SessionUser = { id: "4", companyId: "c1", teamId: null, role: "PARTNER_VIEWER", accountId: "a1" };
// teamId null, like a SUPER_ADMIN and unlike every other scoped role: onboarding staff work across
// the whole company's buildings but see only the ones they are ASSIGNED to, so a team would be a
// filter that means nothing. See scope.ts, where the ONBOARDING account scope carries no team key.
const onboarding: SessionUser = { id: "5", companyId: "c1", teamId: null, role: "ONBOARDING" };

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
    expect(() => assertCan(admin, "manage_companies")).toThrow(ForbiddenError);
    expect(() => assertCan(su, "manage_companies")).not.toThrow();
  });

  // The regression guard. write_settlements was once widened to COMPANY_ADMIN and THIS assertion
  // was deleted to accommodate it, so nothing failed. A team admin writing transfers moves what
  // Qonshu owes a partner; only the owner may. Keep both directions asserted here.
  it("a team admin may READ settlements but never WRITE them", () => {
    expect(can(admin, "view_settlements")).toBe(true);
    expect(can(admin, "write_settlements")).toBe(false);
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

// Exhaustive role x action table.
//
// THE ROLE LIST IS DERIVED FROM THE PRISMA ENUM, NOT HAND-WRITTEN, and that is the whole point of
// this block. It used to be `const ROLES = ["SUPER_ADMIN", ...] as const`, a literal list — so when
// ONBOARDING was added to the Prisma `Role` enum, NOTHING here failed: the new role was absent from
// every row, `Record<(typeof ROLES)[number], boolean>` demanded nothing for it, and a brand-new
// role went through the entire capability layer untested. A role the matrix has never been asked
// about is a role whose answers nobody checked.
//
// `Record<Action, Record<Role, boolean>>` over the enum's own keys makes the next Role a COMPILE
// ERROR in this file until every action states an explicit expectation for it. Do not replace this
// with a literal list, a Partial, or an index signature.
type A = Parameters<typeof can>[1];
const ROLES = Object.keys(Role) as Role[];
const EXPECTED: Record<A, Record<Role, boolean>> = {
  manage_companies:    { SUPER_ADMIN: true, COMPANY_ADMIN: false, MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: false },
  manage_users:        { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: false },
  view_payment_detail: { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: true },
  view_settlements:    { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: true },
  // SUPER_ADMIN alone, by explicit product rule. A COMPANY_ADMIN reads settlements (above) but
  // cannot amend them; a PARTNER_VIEWER may read its own and never amend it. This row is the
  // single place the rule is asserted for every role at once — if it is edited, the product rule
  // itself changed, so check before accommodating a 403.
  write_settlements:   { SUPER_ADMIN: true, COMPANY_ADMIN: false, MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: false },
  // THE ONE FALSE THAT HIDES MONEY FROM ONBOARDING. A MEMBER is true here, deliberately and
  // unchanged: a member already reads service fees and per-unit debt/balance, and this action was
  // introduced to deny ONBOARDING those figures WITHOUT changing what a member sees. If this row
  // ever gains `MEMBER: false`, every member's billing page and unit table went dark with it.
  view_financials:     { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: true,  ONBOARDING: false, PARTNER_VIEWER: true },
  // ONBOARDING is TRUE: resident names and phone numbers are what the SMS/WhatsApp/training steps
  // of the checklist are made of. The money that rides along in the same payload is removed by
  // view_financials above, not by withholding this.
  view_object_detail:  { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: false, ONBOARDING: true,  PARTNER_VIEWER: true },
  // Account + sub-resource WRITES. ONBOARDING false is the gate that stops an assigned activation
  // user renaming a building, flipping its status, deleting it or minting a partner login purely
  // because the assignment put it in their read scope.
  edit_accounts:       { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: true,  ONBOARDING: false, PARTNER_VIEWER: false },
  // The checklist itself: the one thing ONBOARDING may write. PARTNER_VIEWER never sees it.
  manage_onboarding:   { SUPER_ADMIN: true, COMPANY_ADMIN: true,  MEMBER: true,  ONBOARDING: true,  PARTNER_VIEWER: false },
  // Granting access to a building is an administrative act, because an assignment IS data access.
  manage_account_assignments: { SUPER_ADMIN: true, COMPANY_ADMIN: true, MEMBER: false, ONBOARDING: false, PARTNER_VIEWER: false },
};
const ACTIONS = Object.keys(EXPECTED) as A[];
const USERS: Record<Role, SessionUser> = {
  SUPER_ADMIN: su, COMPANY_ADMIN: admin, MEMBER: member, ONBOARDING: onboarding, PARTNER_VIEWER: viewer,
};

// The denial list from the feature brief, asserted as a SET rather than row by row. The rows above
// already cover each of these, but a single `false`ful row is easy to flip while accommodating a
// 403; a named list of "ONBOARDING must never hold these" is harder to edit by accident.
const ONBOARDING_MUST_NOT_HOLD: A[] = [
  "manage_users",
  "manage_companies",
  "view_payment_detail",
  "view_settlements",
  "write_settlements",
  "view_financials",
  "edit_accounts",
  "manage_account_assignments",
];

describe("capability matrix (role x action)", () => {
  // Belt and braces for the derivation above: if `Object.keys(Role)` ever stops producing every
  // role (a Prisma client regenerated from a stale schema, say), this fails instead of silently
  // testing fewer roles.
  it("covers every role in the Prisma enum", () => {
    expect(ROLES.length).toBe(5);
    expect(ROLES).toContain("ONBOARDING");
    for (const role of ROLES) expect(USERS[role]).toBeDefined();
  });

  for (const action of ACTIONS) {
    for (const role of ROLES) {
      it(`${role} ${EXPECTED[action][role] ? "can" : "cannot"} ${action}`, () => {
        expect(can(USERS[role], action)).toBe(EXPECTED[action][role]);
      });
    }
  }

  it("ONBOARDING holds none of the administrative, financial or write capabilities", () => {
    for (const action of ONBOARDING_MUST_NOT_HOLD) {
      expect(can(onboarding, action)).toBe(false);
      expect(() => assertCan(onboarding, action)).toThrow(ForbiddenError);
    }
  });

  it("ONBOARDING holds exactly the two capabilities the checklist needs", () => {
    expect(can(onboarding, "manage_onboarding")).toBe(true);
    expect(can(onboarding, "view_object_detail")).toBe(true);
    // The combination that defines the role: the units and the residents, never the money.
    expect(can(onboarding, "view_financials")).toBe(false);
  });

  // MEMBER behaviour is the thing this feature must not disturb. Asserted as its own test so a
  // regression reads as "members lost money" rather than as one `false` in a wide table.
  it("a MEMBER still reads financials and still writes accounts (unchanged by the ONBOARDING role)", () => {
    expect(can(member, "view_financials")).toBe(true);
    expect(can(member, "edit_accounts")).toBe(true);
    // And still does NOT get the two narrower money capabilities it never had.
    expect(can(member, "view_payment_detail")).toBe(false);
    expect(can(member, "view_settlements")).toBe(false);
  });
});
