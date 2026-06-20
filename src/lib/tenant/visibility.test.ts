import { describe, it, expect } from "vitest";
import { leadVisibilityWhere } from "./visibility";
import type { SessionUser } from "@/lib/auth/guards";

const admin: SessionUser = { id: "a", companyId: "c1", role: "COMPANY_ADMIN" };
const member: SessionUser = { id: "m", companyId: "c1", role: "MEMBER" };

describe("leadVisibilityWhere", () => {
  it("admin always sees all", () => {
    expect(leadVisibilityWhere(admin, false)).toEqual({ companyId: "c1" });
  });
  it("member sees all when shared", () => {
    expect(leadVisibilityWhere(member, true)).toEqual({ companyId: "c1" });
  });
  it("member restricted to own when not shared", () => {
    expect(leadVisibilityWhere(member, false)).toEqual({ companyId: "c1", ownerId: "m" });
  });
});
