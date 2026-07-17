import type { PrismaClient, User, UserStatus, Role } from "@prisma/client";
import type { TenantContext } from "./context";
import type { SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { getAccount } from "./accounts";

export class InvalidUserRoleError extends Error {}

// Direct user creation replaces the old invite-link flow: an admin types an email + password
// and tells the person directly (no email sending, no APP_URL-dependent links).
export async function createUser(
  db: PrismaClient, user: SessionUser,
  args: { name: string; email: string; password: string; role: Role; accountId?: string | null },
): Promise<User> {
  if (!user.companyId) throw new Error("no tenant context");

  // PARTNER_VIEWER requires exactly one account, scoped to this company (fail closed:
  // no silent fallback). Every other role must carry no accountId at all.
  let accountId: string | null = null;
  if (args.role === "PARTNER_VIEWER") {
    if (!args.accountId) throw new InvalidUserRoleError("accountId is required for PARTNER_VIEWER");
    const acc = await getAccount(db, user, args.accountId);
    if (!acc) throw new InvalidUserRoleError("accountId does not belong to this company");
    accountId = args.accountId;
  } else if (args.accountId) {
    throw new InvalidUserRoleError("accountId is only allowed for PARTNER_VIEWER");
  }

  const passwordHash = await hashPassword(args.password);
  return db.user.create({
    data: {
      companyId: user.companyId, email: args.email, name: args.name,
      passwordHash, role: args.role, accountId, status: "ACTIVE",
    },
  });
}

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
