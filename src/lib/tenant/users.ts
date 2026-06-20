import type { PrismaClient, User, UserStatus } from "@prisma/client";
import type { TenantContext } from "./context";

export function listUsers(db: PrismaClient, ctx: TenantContext): Promise<User[]> {
  return db.user.findMany({ where: { companyId: ctx.companyId }, orderBy: { createdAt: "asc" } });
}
export function getUser(db: PrismaClient, ctx: TenantContext, id: string): Promise<User | null> {
  return db.user.findFirst({ where: { id, companyId: ctx.companyId } });
}
export async function setUserStatus(db: PrismaClient, ctx: TenantContext, id: string, status: UserStatus): Promise<User> {
  const found = await getUser(db, ctx, id);
  if (!found) throw new Error("user not in tenant");
  await db.user.updateMany({ where: { id, companyId: ctx.companyId }, data: { status } });
  const updated = await getUser(db, ctx, id);
  if (!updated) throw new Error("user not in tenant");
  return updated;
}
