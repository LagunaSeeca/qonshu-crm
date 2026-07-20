import type { PrismaClient, Account, AccountStatus, Prisma, User } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getLead } from "./leads";
import { removeLeadDir } from "@/lib/files/storage";
import { hashPassword } from "@/lib/auth/password";

export class AlreadyConvertedError extends Error {}
export class InvalidPartnerLoginError extends Error {}

export function accountScopeWhere(user: SessionUser): { companyId: string } {
  if (!user.companyId) throw new Error("no tenant context");
  return { companyId: user.companyId };
}

export function createAccount(db: PrismaClient, user: SessionUser, data: {
  name: string; website?: string; industry?: string; status?: AccountStatus;
  accountManagerId?: string; primaryContactName?: string;
  primaryContactEmail?: string; primaryContactPhone?: string; sourceLeadId?: string;
  externalPartnerKey?: string;
}): Promise<Account> {
  return db.account.create({ data: {
    companyId: user.companyId!, name: data.name, website: data.website, industry: data.industry,
    status: data.status ?? "ACTIVE", accountManagerId: data.accountManagerId ?? user.id,
    primaryContactName: data.primaryContactName,
    primaryContactEmail: data.primaryContactEmail, primaryContactPhone: data.primaryContactPhone,
    sourceLeadId: data.sourceLeadId ?? null,
    externalPartnerKey: data.externalPartnerKey ?? null,
  } });
}

// Same as createAccount, but can also provision the partner's PARTNER_VIEWER login in the
// same transaction — so "add an account" and "give the partner portal access" happen atomically
// instead of as two separate admin steps (Accounts, then Users).
export function createAccountWithLogin(db: PrismaClient, user: SessionUser, data: {
  name: string; website?: string; industry?: string; status?: AccountStatus;
  accountManagerId?: string; primaryContactName?: string;
  primaryContactEmail?: string; primaryContactPhone?: string; sourceLeadId?: string;
  partnerLogin?: { name: string; email: string; password: string };
}): Promise<{ account: Account; partnerUser: User | null }> {
  const { partnerLogin, ...accountData } = data;
  if (partnerLogin && partnerLogin.password.length < 8) {
    throw new InvalidPartnerLoginError("password must be at least 8 characters");
  }
  return db.$transaction(async (tx) => {
    const account = await createAccount(tx as PrismaClient, user, accountData);
    if (!partnerLogin) return { account, partnerUser: null };
    const passwordHash = await hashPassword(partnerLogin.password);
    const partnerUser = await tx.user.create({
      data: {
        companyId: user.companyId!, email: partnerLogin.email, name: partnerLogin.name,
        passwordHash, role: "PARTNER_VIEWER", accountId: account.id, status: "ACTIVE",
      },
    });
    return { account, partnerUser };
  });
}

export function listAccounts(db: PrismaClient, user: SessionUser, opts?: { status?: AccountStatus; accountManagerId?: string; q?: string }): Promise<Account[]> {
  // Partner logins are tied to exactly one account — fail closed when unset.
  if (user.role === "PARTNER_VIEWER") {
    if (!user.accountId) return Promise.resolve([]);
    return db.account.findMany({ where: { id: user.accountId, ...accountScopeWhere(user) } });
  }
  const where: Prisma.AccountWhereInput = { ...accountScopeWhere(user) };
  if (opts?.status) where.status = opts.status;
  if (opts?.accountManagerId) where.accountManagerId = opts.accountManagerId;
  if (opts?.q) where.OR = [
    { name: { contains: opts.q, mode: "insensitive" } },
    { industry: { contains: opts.q, mode: "insensitive" } },
  ];
  return db.account.findMany({ where, orderBy: { updatedAt: "desc" } });
}

export function getAccount(db: PrismaClient, user: SessionUser, id: string): Promise<Account | null> {
  // THE CHOKEPOINT: every account-scoped read/write flows through this. A partner login
  // requesting any account other than their own gets null -> 404 everywhere downstream.
  // A partner with no accountId (data bug) gets nothing at all — fail closed.
  if (user.role === "PARTNER_VIEWER" && (!user.accountId || user.accountId !== id)) {
    return Promise.resolve(null);
  }
  return db.account.findFirst({ where: { id, ...accountScopeWhere(user) } });
}

export async function updateAccount(db: PrismaClient, user: SessionUser, id: string, data: Partial<{
  name: string; website: string | null; industry: string | null; status: AccountStatus;
  accountManagerId: string; primaryContactName: string | null;
  primaryContactEmail: string | null; primaryContactPhone: string | null;
  externalPartnerKey: string | null;
}>): Promise<Account> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  if (data.accountManagerId) {
    const mgr = await db.user.findFirst({ where: { id: data.accountManagerId, companyId: user.companyId! } });
    if (!mgr) throw new NotFoundError("manager not in tenant");
  }
  return db.account.update({ where: { id }, data });
}

export async function deleteAccount(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  await removeLeadDir(user.companyId!, `account-${id}`); // reuse storage dir-removal under uploads/<companyId>/account-<id>
  await db.account.delete({ where: { id } });
}

export async function convertLeadToAccount(db: PrismaClient, user: SessionUser, leadId: string): Promise<Account> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const stage = await db.stage.findFirst({ where: { id: lead.stageId, companyId: user.companyId! } });
  if (!stage || stage.type !== "WON") throw new Error("lead is not in a Won stage");
  const existing = await db.account.findFirst({ where: { companyId: user.companyId!, sourceLeadId: leadId } });
  if (existing) throw new AlreadyConvertedError("lead already converted");
  return createAccount(db, user, {
    name: lead.companyName ?? lead.title,
    accountManagerId: lead.ownerId, primaryContactName: lead.contactName,
    primaryContactEmail: lead.email ?? undefined, primaryContactPhone: lead.phone ?? undefined,
    sourceLeadId: lead.id,
  });
}
