import type { PrismaClient, User, UserStatus, Role } from "@prisma/client";
import type { TenantContext } from "./context";
import { NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { hashPassword } from "@/lib/auth/password";
import { getAccount } from "./accounts";

export class InvalidUserRoleError extends Error {}

// Direct user creation replaces the old invite-link flow: an admin types an email + password
// and tells the person directly (no email sending, no APP_URL-dependent links).
//
// Two actors can call this:
//  - COMPANY_ADMIN (user.companyId set): always creates within their OWN company. Passing their
//    own id in `args.companyId` is a no-op. Passing a DIFFERENT company's id is rejected outright
//    (rather than silently substituting their own company and reporting 201 for something other
//    than what was asked) — this is the load-bearing tenancy guard.
//  - SUPER_ADMIN (user.companyId null): has no company of their own, so they must name the
//    target company explicitly via `args.companyId`, which is validated to exist AND be ACTIVE
//    (a SUSPENDED tenant must not get working logins provisioned into it).
export async function createUser(
  db: PrismaClient, user: SessionUser,
  args: { name: string; email: string; password: string; role: Role; accountId?: string | null; companyId?: string | null },
): Promise<User> {
  let targetCompanyId: string;
  if (user.companyId) {
    if (args.companyId && args.companyId !== user.companyId) {
      throw new InvalidUserRoleError("companyId does not match the actor's own company");
    }
    targetCompanyId = user.companyId;
  } else {
    if (!args.companyId) throw new InvalidUserRoleError("companyId is required to create a user as a super admin");
    const company = await db.company.findUnique({ where: { id: args.companyId } });
    if (!company) throw new NotFoundError("company not found");
    if (company.status !== "ACTIVE") throw new InvalidUserRoleError("company is not active");
    targetCompanyId = company.id;
  }

  // PARTNER_VIEWER requires exactly one account, scoped to the target company (fail closed:
  // no silent fallback). Every other role must carry no accountId at all. Scope the accountId
  // lookup to targetCompanyId (not user.companyId, which is null for a super admin) — getAccount
  // only reads user.companyId, so a synthetic {...user, companyId: targetCompanyId} view scopes
  // it correctly for either actor without changing getAccount itself.
  let accountId: string | null = null;
  if (args.role === "PARTNER_VIEWER") {
    if (!args.accountId) throw new InvalidUserRoleError("accountId is required for PARTNER_VIEWER");
    const acc = await getAccount(db, { ...user, companyId: targetCompanyId }, args.accountId);
    if (!acc) throw new InvalidUserRoleError("accountId does not belong to this company");
    accountId = args.accountId;
  } else if (args.accountId) {
    throw new InvalidUserRoleError("accountId is only allowed for PARTNER_VIEWER");
  }

  const passwordHash = await hashPassword(args.password);
  return db.user.create({
    data: {
      companyId: targetCompanyId, email: args.email, name: args.name,
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
