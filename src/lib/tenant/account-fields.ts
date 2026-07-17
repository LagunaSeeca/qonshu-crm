import type { PrismaClient, AccountFieldDef, AccountFieldType } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";

export function listFieldDefs(db: PrismaClient, user: SessionUser): Promise<AccountFieldDef[]> {
  if (!user.companyId) throw new Error("no tenant context");
  return db.accountFieldDef.findMany({ where: { companyId: user.companyId }, orderBy: { order: "asc" } });
}

export async function createFieldDef(db: PrismaClient, user: SessionUser, data: { label: string; type: AccountFieldType }): Promise<AccountFieldDef> {
  if (!user.companyId) throw new Error("no tenant context");
  const max = await db.accountFieldDef.aggregate({ where: { companyId: user.companyId }, _max: { order: true } });
  return db.accountFieldDef.create({
    data: { companyId: user.companyId, label: data.label, type: data.type, order: (max._max.order ?? -1) + 1 },
  });
}

export async function updateFieldDef(db: PrismaClient, user: SessionUser, id: string, data: Partial<{ label: string; type: AccountFieldType }>): Promise<AccountFieldDef> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.accountFieldDef.findFirst({ where: { id, companyId: user.companyId } });
  if (!found) throw new NotFoundError("field def not in tenant");
  return db.accountFieldDef.update({ where: { id }, data });
}

export async function deleteFieldDef(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  if (!user.companyId) throw new Error("no tenant context");
  const found = await db.accountFieldDef.findFirst({ where: { id, companyId: user.companyId } });
  if (!found) throw new NotFoundError("field def not in tenant");
  await db.accountFieldDef.delete({ where: { id } });
}

export async function reorderFieldDefs(db: PrismaClient, user: SessionUser, orderedIds: string[]): Promise<void> {
  if (!user.companyId) throw new Error("no tenant context");
  const companyId = user.companyId;
  await db.$transaction(
    orderedIds.map((id, i) => db.accountFieldDef.updateMany({ where: { id, companyId }, data: { order: i } })),
  );
}

export type AccountFieldRow = { fieldDefId: string; label: string; type: AccountFieldType; order: number; value: string };

export async function getAccountFields(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountFieldRow[]> {
  if (!user.companyId) throw new Error("no tenant context");
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const [defs, values] = await Promise.all([
    db.accountFieldDef.findMany({ where: { companyId: user.companyId }, orderBy: { order: "asc" } }),
    db.accountFieldValue.findMany({ where: { companyId: user.companyId, accountId } }),
  ]);
  const valueMap = new Map(values.map((v) => [v.fieldDefId, v.value]));
  return defs.map((d) => ({
    fieldDefId: d.id,
    label: d.label,
    type: d.type,
    order: d.order,
    value: valueMap.get(d.id) ?? "",
  }));
}

export async function setAccountFieldValue(db: PrismaClient, user: SessionUser, accountId: string, fieldDefId: string, value: string) {
  if (!user.companyId) throw new Error("no tenant context");
  const companyId = user.companyId;
  const acc = await getAccount(db, user, accountId);
  if (!acc) throw new NotFoundError("account not in scope");
  const def = await db.accountFieldDef.findFirst({ where: { id: fieldDefId, companyId } });
  if (!def) throw new NotFoundError("field def not in tenant");
  return db.accountFieldValue.upsert({
    where: { accountId_fieldDefId: { accountId, fieldDefId } },
    create: { companyId, accountId, fieldDefId, value },
    update: { value },
  });
}
