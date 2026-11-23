import type { PrismaClient, AccountActivity, AccountActivityKind } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
import { getAccount } from "./accounts";
import { isPartnerLinkOutcome } from "./partner-link-audit";

export async function addAccountActivity(db: PrismaClient, user: SessionUser, accountId: string, args: { kind: AccountActivityKind; body: string; outcome?: string; occurredAt?: Date }): Promise<AccountActivity> {
  // `partner_link:*` marked the partner-link audit trail while it lived in this table. The trail
  // now has its own durable table (./partner-link-audit.ts), but the HISTORICAL rows are still
  // here and this is the tenant-facing writer — free-text outcome, caller-chosen occurredAt — so
  // the prefix stays reserved rather than letting a tenant plant rows indistinguishable from them.
  if (isPartnerLinkOutcome(args.outcome)) throw new ForbiddenError("reserved outcome prefix");
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  return db.accountActivity.create({ data: { companyId: account.companyId, accountId, authorId: user.id, kind: args.kind, body: args.body, outcome: args.outcome, occurredAt: args.occurredAt ?? new Date() } });
}

// ONE PATH, SCOPED. The unscoped SUPER_ADMIN branch that used to sit here existed for exactly one
// reason: the partner-link audit trail was written into this table, and a super admin (companyId
// null) could not read the half of it that they themselves wrote. The trail has moved to
// PartnerLinkAudit, which is read on the platform side, so the special case was dead weight — and
// an unscoped `findUnique` + company-wide read is not something to leave lying in a tenant module.
// getAccount is now the only account resolver here, for every role.
export async function listAccountActivities(db: PrismaClient, user: SessionUser, accountId: string): Promise<AccountActivity[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) return [];
  return db.accountActivity.findMany({ where: { companyId: account.companyId, accountId }, orderBy: { occurredAt: "desc" } });
}
