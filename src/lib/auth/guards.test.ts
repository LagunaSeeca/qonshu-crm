import { describe, it, expect } from "vitest";
import { can, assertRole, ForbiddenError, type SessionUser } from "./guards";

const su: SessionUser = { id: "1", companyId: null, role: "SUPER_ADMIN" };
const admin: SessionUser = { id: "2", companyId: "c1", role: "COMPANY_ADMIN" };
const member: SessionUser = { id: "3", companyId: "c1", role: "MEMBER" };

describe("guards", () => {
  it("super admin manages companies, not company data", () => {
    expect(can(su, "manage_companies")).toBe(true);
    expect(can(admin, "manage_companies")).toBe(false);
  });
  it("company admin manages users", () => {
    expect(can(admin, "manage_users")).toBe(true);
    expect(can(member, "manage_users")).toBe(false);
  });
  it("members view company data", () => {
    expect(can(member, "view_company_data")).toBe(true);
    expect(can(su, "view_company_data")).toBe(false);
  });
  it("assertRole throws ForbiddenError when role not allowed", () => {
    expect(() => assertRole(member, ["COMPANY_ADMIN"])).toThrow(ForbiddenError);
    expect(() => assertRole(admin, ["COMPANY_ADMIN"])).not.toThrow();
  });
});
