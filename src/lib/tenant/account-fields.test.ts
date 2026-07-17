import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { testPrisma, resetDb } from "@/test/db";
import {
  listFieldDefs,
  createFieldDef,
  updateFieldDef,
  deleteFieldDef,
  reorderFieldDefs,
  getAccountFields,
  setAccountFieldValue,
} from "./account-fields";
import type { SessionUser } from "@/lib/auth/guards";

async function setup(slug: string) {
  const c = await testPrisma.company.create({ data: { name: "A", slug } });
  const u = await testPrisma.user.create({ data: { companyId: c.id, email: `u-${slug}@a.com`, passwordHash: "x", name: "U", role: "COMPANY_ADMIN" } });
  const acc = await testPrisma.account.create({ data: { companyId: c.id, name: "Partner", accountManagerId: u.id } });
  const user: SessionUser = { id: u.id, companyId: c.id, role: "COMPANY_ADMIN" };
  return { c, acc, user };
}

describe("account-fields", () => {
  beforeEach(resetDb);
  afterAll(() => testPrisma.$disconnect());

  it("creates field defs scoped by company, ordered", async () => {
    const { user } = await setup("f1");
    const d1 = await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    const d2 = await createFieldDef(testPrisma, user, { label: "Contract value", type: "CURRENCY" });
    expect(d1.order).toBe(0);
    expect(d2.order).toBe(1);
    const defs = await listFieldDefs(testPrisma, user);
    expect(defs.map((d) => d.label)).toEqual(["Total area", "Contract value"]);
  });

  it("rejects duplicate label per company (P2002)", async () => {
    const { user } = await setup("f2");
    await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    await expect(createFieldDef(testPrisma, user, { label: "Total area", type: "TEXT" })).rejects.toThrow();
  });

  it("allows same label across different companies (tenant isolation)", async () => {
    const A = await setup("f3");
    const B = await setup("f4");
    await createFieldDef(testPrisma, A.user, { label: "Total area", type: "NUMBER" });
    await expect(createFieldDef(testPrisma, B.user, { label: "Total area", type: "NUMBER" })).resolves.toBeTruthy();
  });

  it("updates and deletes a field def scoped by tenant", async () => {
    const { user } = await setup("f5");
    const d = await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    const updated = await updateFieldDef(testPrisma, user, d.id, { label: "Area (sqm)" });
    expect(updated.label).toBe("Area (sqm)");
    await deleteFieldDef(testPrisma, user, d.id);
    expect(await listFieldDefs(testPrisma, user)).toHaveLength(0);
  });

  it("cross-tenant update/delete of a field def throws NotFoundError", async () => {
    const A = await setup("f6");
    const B = await setup("f7");
    const d = await createFieldDef(testPrisma, A.user, { label: "Total area", type: "NUMBER" });
    await expect(updateFieldDef(testPrisma, B.user, d.id, { label: "x" })).rejects.toThrow();
    await expect(deleteFieldDef(testPrisma, B.user, d.id)).rejects.toThrow();
  });

  it("reorders field defs", async () => {
    const { user } = await setup("f8");
    const d1 = await createFieldDef(testPrisma, user, { label: "A", type: "TEXT" });
    const d2 = await createFieldDef(testPrisma, user, { label: "B", type: "TEXT" });
    await reorderFieldDefs(testPrisma, user, [d2.id, d1.id]);
    const defs = await listFieldDefs(testPrisma, user);
    expect(defs.map((d) => d.id)).toEqual([d2.id, d1.id]);
  });

  it("getAccountFields returns every def with empty value when unset", async () => {
    const { user, acc } = await setup("f9");
    await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    await createFieldDef(testPrisma, user, { label: "Contract value", type: "CURRENCY" });
    const rows = await getAccountFields(testPrisma, user, acc.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.value === "")).toBe(true);
  });

  it("setAccountFieldValue upserts (set then update)", async () => {
    const { user, acc } = await setup("f10");
    const d = await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    await setAccountFieldValue(testPrisma, user, acc.id, d.id, "100");
    let rows = await getAccountFields(testPrisma, user, acc.id);
    expect(rows[0].value).toBe("100");
    await setAccountFieldValue(testPrisma, user, acc.id, d.id, "250");
    rows = await getAccountFields(testPrisma, user, acc.id);
    expect(rows[0].value).toBe("250");
  });

  it("deleting a def removes its values", async () => {
    const { user, acc } = await setup("f11");
    const d = await createFieldDef(testPrisma, user, { label: "Total area", type: "NUMBER" });
    await setAccountFieldValue(testPrisma, user, acc.id, d.id, "100");
    await deleteFieldDef(testPrisma, user, d.id);
    const remaining = await testPrisma.accountFieldValue.findMany({ where: { fieldDefId: d.id } });
    expect(remaining).toHaveLength(0);
  });

  it("cross-tenant account or def in getAccountFields/setAccountFieldValue throws", async () => {
    const A = await setup("f12");
    const B = await setup("f13");
    const dA = await createFieldDef(testPrisma, A.user, { label: "Total area", type: "NUMBER" });
    await expect(getAccountFields(testPrisma, B.user, A.acc.id)).rejects.toThrow();
    await expect(setAccountFieldValue(testPrisma, A.user, A.acc.id, dA.id, "1")).resolves.toBeTruthy();
    await expect(setAccountFieldValue(testPrisma, B.user, A.acc.id, dA.id, "1")).rejects.toThrow();
    await expect(setAccountFieldValue(testPrisma, B.user, B.acc.id, dA.id, "1")).rejects.toThrow();
  });
});
