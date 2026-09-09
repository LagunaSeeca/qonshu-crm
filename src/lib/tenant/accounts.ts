import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, AccountStatus, User } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { removeLeadDir } from "@/lib/files/storage";
import { hashPassword } from "@/lib/auth/password";
import { resolveAllowlistedPartner } from "@/lib/platform/partner-allowlist";
import { recordPartnerLinkChange } from "./partner-link-audit";

export class InvalidPartnerLoginError extends Error {}

// The partner namespace is GLOBAL, not per-company: there is ONE shared X-API-Key, so
// `?partner=<name>` addresses the same upstream complex no matter which company's account holds
// the name. Two accounts holding the same name therefore double-count EVERYTHING in the analytics
// fan-outs (src/lib/tenant/company-analytics.ts, src/lib/platform/overview.ts) AND cross-expose
// two tenants' debt, payments and unit-level owner names/phones. So this lookup is deliberately
// UNSCOPED by companyId.
//
// `Account.externalPartnerKey` is now `@@unique`, which is the real guarantee — every caller of
// this helper is check-then-act and so racy on its own. Treat this as the friendly pre-check that
// produces a good error/skip, and the constraint as the thing that actually holds.
// `exceptAccountId` lets a caller ask "taken by SOMEONE ELSE?" — the platform re-assign path
// needs that so re-saving an account's own current partner isn't reported as a clash.
export async function isPartnerKeyTaken(
  db: PrismaClient, key: string, exceptAccountId?: string,
): Promise<boolean> {
  const holder = await db.account.findFirst({
    where: { externalPartnerKey: key, ...(exceptAccountId ? { id: { not: exceptAccountId } } : {}) },
    select: { id: true },
  });
  return holder !== null;
}

// Every partner name claimed by an account ANYWHERE on the platform, in ONE query — the batched
// counterpart to isPartnerKeyTaken, for callers that must test a whole live partner list at once
// (GET /api/partners hides claimed partners so a name can't be double-claimed from the picker).
// Unscoped by companyId for the same reason as isPartnerKeyTaken: the namespace is global.
export async function listTakenPartnerKeys(db: PrismaClient): Promise<Set<string>> {
  const rows = await db.account.findMany({
    where: { externalPartnerKey: { not: null } },
    select: { externalPartnerKey: true },
  });
  return new Set(rows.map((r) => r.externalPartnerKey as string));
}

// Auto-link: a LOOKUP against the SUPER_ADMIN-managed allowlist, never a CLAIM on a name.
//
// It used to resolve the partner from the account NAME against the live upstream partner list.
// The account name is free text the tenant supplies, so a MEMBER could
// `POST /api/accounts {"name":"Someone.Elses.Complex"}` and take over another tenant's complex,
// and the 201 body confirmed the hit — an enumeration oracle over every complex on the platform.
//
// Now the name only selects a row a SUPER_ADMIN already granted to THIS company
// (src/lib/platform/partner-allowlist.ts). Every failure — not granted, granted to another
// company, no such complex, already claimed — returns the same `null`, so a non-authorized name
// is indistinguishable from a wrong one and the oracle is dead. No upstream call is involved in
// the authorization decision at all. Never throws.
export async function resolveUnclaimedPartnerKey(
  db: PrismaClient, companyId: string, accountName: string,
): Promise<string | null> {
  const key = await resolveAllowlistedPartner(db, companyId, accountName);
  if (!key) return null;
  return (await isPartnerKeyTaken(db, key)) ? null : key;
}

// True when a write failed the @@unique([externalPartnerKey]) backstop specifically, rather than
// some other unique constraint on Account (sourceLeadId is @unique too, and lead-conversion.ts
// depends on being able to tell them apart).
//
// Prisma reports WHICH constraint failed in a different place depending on the driver: `meta.target`
// on the classic engine path, but `meta.driverAdapterError.cause.constraint.fields` (as `"col"`,
// quotes included) plus the raw Postgres message under the pg driver adapter this app actually
// uses. So serialize the whole meta and look for the column name rather than reaching for one
// shape — a Prisma or adapter upgrade that moves the field would otherwise silently return false
// here, turning a recoverable lost race back into a 500 on account creation.
//
// Fail-safe either way: a false negative surfaces the P2002 to the caller, and a false positive
// only costs one retry that fails again on the real constraint and propagates.
export function isPartnerKeyConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== "P2002") return false;
  try {
    return JSON.stringify(e.meta ?? "").includes("externalPartnerKey");
  } catch {
    return false;
  }
}

export function accountScopeWhere(user: SessionUser): { companyId: string } {
  if (!user.companyId) throw new Error("no tenant context");
  return { companyId: user.companyId };
}

// There is deliberately NO `externalPartnerKey` field. The partner namespace is global, so an
// explicit key from a caller is a tenancy hole; setAccountPartner (SUPER_ADMIN-only, in
// src/lib/platform/account-partners.ts) is the ONLY explicit writer. Keeping the field out of the
// TYPE means a future regression that tries to pass one is a compile error rather than a silent
// cross-tenant link. The link written by this module can only ever be the allowlisted one.
export type NewAccountData = {
  name: string; website?: string; industry?: string; status?: AccountStatus;
  accountManagerId?: string; primaryContactName?: string;
  primaryContactEmail?: string; primaryContactPhone?: string; sourceLeadId?: string;
};

// ONE attempt: resolve the auto-link (unless `autoLink` is false), insert, and — only if a key was
// actually written — record the audit row. Deliberately does NOT recover from a lost auto-link
// race: it lets the P2002 out so the recovery can happen at a level that owns the TRANSACTION.
//
// WHY THAT MATTERS: this runs inside `db.$transaction` for every account created through the API
// (createAccountWithLogin always opens one). On Postgres a failed statement aborts the whole
// transaction and Prisma issues no savepoints, so a retry issued here would not be a retry at all
// — it would fail with "current transaction is aborted" (a DriverAdapterError with no `.code`,
// which falls through errorResponse to a 500) and take the account down with it. Retrying is the
// caller's job precisely because only the caller can restart the transaction.
async function insertAccount(
  db: PrismaClient, user: SessionUser, data: NewAccountData, autoLink: boolean,
): Promise<Account> {
  const companyId = user.companyId!;
  const autoKey = autoLink ? await resolveUnclaimedPartnerKey(db, companyId, data.name) : null;

  const account = await db.account.create({ data: {
    companyId, name: data.name, website: data.website, industry: data.industry,
    status: data.status ?? "ACTIVE", accountManagerId: data.accountManagerId ?? user.id,
    primaryContactName: data.primaryContactName,
    primaryContactEmail: data.primaryContactEmail, primaryContactPhone: data.primaryContactPhone,
    sourceLeadId: data.sourceLeadId ?? null,
    externalPartnerKey: autoKey,
  } });

  if (autoKey === null) return account;
  // Attribution for the most security-sensitive write in the system — see
  // ./partner-link-audit.ts. Same `db` as the insert, so inside the caller's transaction the audit
  // row can never outlive the link it describes.
  await recordPartnerLinkChange(db, {
    companyId, accountId: account.id, authorId: user.id,
    action: "auto_link", partnerName: autoKey,
  });
  return account;
}

// Creates the account and, when the company has been granted this complex, links it.
//
// MUST be called with a client that is NOT already inside a transaction — the retry below is a
// second INSERT on the same connection, which a Postgres transaction aborted by the first one
// would refuse. Transactional callers use createAccountWithLogin, which retries at the
// transaction boundary instead. (Today's callers: POST /api/accounts via createAccountWithLogin,
// and convertLeadToAccount, which runs after moveLeadStage's transaction has committed.)
export async function createAccount(
  db: PrismaClient, user: SessionUser, data: NewAccountData,
): Promise<Account> {
  try {
    return await insertAccount(db, user, data, true);
  } catch (e) {
    // Lost the race to a concurrent claim on the same complex — isPartnerKeyTaken is
    // check-then-act, @@unique([externalPartnerKey]) is what actually decides. Auto-link is a
    // convenience, never a dependency, so a lost race degrades to "created but unlinked", the
    // same outcome as every other auto-link miss. Any OTHER unique violation still propagates
    // (lead-conversion.ts needs the sourceLeadId one).
    if (!isPartnerKeyConflict(e)) throw e;
    return insertAccount(db, user, data, false);
  }
}

// Same as createAccount, but can also provision the partner's PARTNER_VIEWER login in the
// same transaction — so "add an account" and "give the partner portal access" happen atomically
// instead of as two separate admin steps (Accounts, then Users).
//
// No `externalPartnerKey` parameter here either: the key is computed SOLELY by createAccount's
// allowlist auto-link. That auto-link is now a pure DB lookup rather than an outbound HTTP call,
// so it safely runs inside the transaction instead of having to be resolved ahead of it.
export async function createAccountWithLogin(db: PrismaClient, user: SessionUser, data: NewAccountData & {
  partnerLogin?: { name: string; email: string; password: string };
}): Promise<{ account: Account; partnerUser: User | null }> {
  const { partnerLogin, ...accountData } = data;
  if (partnerLogin && partnerLogin.password.length < 8) {
    throw new InvalidPartnerLoginError("password must be at least 8 characters");
  }
  const attempt = (autoLink: boolean) => db.$transaction(async (tx) => {
    const account = await insertAccount(tx as PrismaClient, user, accountData, autoLink);
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

  try {
    return await attempt(true);
  } catch (e) {
    // Lost the auto-link race. Recovery is a fresh TRANSACTION, not a retried statement: the
    // first attempt's P2002 has already aborted this one, so nothing more can run inside it (see
    // insertAccount). The whole unit — account + partner login — is re-run with the link forced
    // off, which is the same "created but unlinked" degradation every other auto-link miss gets.
    // The failed attempt rolled back in full, so the re-run cannot duplicate the partner user.
    if (!isPartnerKeyConflict(e)) throw e;
    return attempt(false);
  }
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
  // `id` breaks ties: equal updatedAt values would otherwise order nondeterministically, and
  // the partner dedup in company-analytics.ts takes the FIRST account per partner off this list.
  return db.account.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] });
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
  // NO `externalPartnerKey`. Same reason as createAccount: the partner namespace is global, so
  // setAccountPartner (SUPER_ADMIN-only) is the sole explicit writer, and anything else trying to
  // re-point an account at another complex must fail to compile.
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

// convertLeadToAccount lives in ./lead-conversion.ts, not here: leads.ts needs it (auto-convert
// on the move to Won) and it needs createAccount from here, which made accounts.ts <-> leads.ts a
// genuine import cycle that only worked by accident of function-declaration hoisting.
