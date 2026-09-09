import type { PrismaClient, AccountActivity, AccountActivityKind } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { isPartnerLinkOutcome } from "./partner-link-audit";

export async function addAccountActivity(db: PrismaClient, user: SessionUser, accountId: string, args: { kind: AccountActivityKind; body: string; outcome?: string; occurredAt?: Date }): Promise<AccountActivity> {
  // `partner_link:*` is the audit trail for who pointed this account at which external complex
  // (./partner-link-audit.ts). This is the tenant-facing writer — free-text outcome, caller-chosen
  // occurredAt — so without this the company being audited could plant rows indistinguishable
  // from the platform admin's. The prefix is reserved to recordPartnerLinkChange.
  if (isPartnerLinkOutcome(args.outcome)) throw new ForbiddenError("reserved outcome prefix");
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  return db.accountActivity.create({ data: { companyId: user.companyId!, accountId, authorId: user.id, kind: args.kind, body: args.body, outcome: args.outcome, occurredAt: args.occurredAt ?? new Date() } });
}

export async function listAccountActivities(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountActivity[]> {
  // A SUPER_ADMIN has companyId: null, so the tenant-scoped path below throws for them — which
  // left the partner-link audit trail unreadable by the one role that writes half of it. Resolve
  // the account UNSCOPED and read that account's own company's rows: the same sanctioned
  // cross-tenant read as src/lib/platform/overview.ts, and read-only — addAccountActivity above
  // stays COMPANY_ADMIN/MEMBER, so a platform admin can never write a tenant's timeline.
  if (user.role === "SUPER_ADMIN") {
    const owner = await db.account.findUnique({ where: { id: accountId }, select: { companyId: true } });
    if (!owner) return [];
    return db.accountActivity.findMany({ where: { companyId: owner.companyId, accountId }, orderBy: { occurredAt: "desc" } });
  }
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountActivity.findMany({ where: { companyId: user.companyId!, accountId }, orderBy: { occurredAt: "desc" } });
}
