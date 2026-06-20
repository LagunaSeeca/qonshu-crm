import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import { getCompanySettings } from "./company";

describe("getCompanySettings", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("returns the company's shareAllLeads", async () => {
    const c = await testPrisma.company.create({
      data: { name: "A", slug: "a-cs", shareAllLeads: false },
    });
    expect(await getCompanySettings(testPrisma, { companyId: c.id })).toEqual({
      shareAllLeads: false,
    });
  });

  it("fails closed when company missing", async () => {
    expect(
      await getCompanySettings(testPrisma, { companyId: "nope" })
    ).toEqual({ shareAllLeads: false });
  });
});
