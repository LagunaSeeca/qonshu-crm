import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, AccountStatus, User } from "@prisma/client";
import { ForbiddenError, isAdmin, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { removeLeadDir } from "@/lib/files/storage";
import { hashPassword } from "@/lib/auth/password";
import { accountScopeWhere, resolveAssignableOwner, type AssignableOwner } from "./scope";
import { assertBuildingUnclaimed, BuildingClaimedError, normalizeBuildingName } from "./building-claim";
import { recordPartnerLinkChange } from "./partner-link-audit";
import { fetchPartners } from "@/lib/partner-api/client";
import { resolveGlobalCredentials } from "@/lib/partner-api/credentials";

export class InvalidPartnerLoginError extends Error {}
// At most ONE ACTIVE PARTNER_VIEWER per account. A second live login for one building means two
// sets of credentials nobody is tracking for the same complex's debt, payments and unit-level
// owner names/phones — and revoking "the" partner's access no longer means anything. Typed so the
// route can answer 409 instead of a bare 500 from some unique index that does not exist.
export class PartnerLoginExistsError extends Error {}

// The partner namespace is GLOBAL, not per-team: there is ONE shared X-API-Key, so
// `?partner=<name>` addresses the same upstream complex no matter which account holds the name.
// Two accounts holding the same name therefore double-count EVERYTHING in the analytics fan-outs
// (src/lib/tenant/company-analytics.ts, src/lib/platform/overview.ts) AND show one team's complex
// to another. So this lookup is deliberately UNSCOPED.
//
// `Account.externalPartnerKey` is `@@unique`, which is the real guarantee — every caller of this
// helper is check-then-act and so racy on its own. Treat this as the friendly pre-check that
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
export async function listTakenPartnerKeys(db: PrismaClient): Promise<Set<string>> {
  const rows = await db.account.findMany({
    where: { externalPartnerKey: { not: null } },
    select: { externalPartnerKey: true },
  });
  return new Set(rows.map((r) => r.externalPartnerKey as string));
}

// AUTO-LINK RESOLUTION, against the LIVE upstream partner list.
//
// WHY THE LIVE LIST AND NOT A LOCAL GRANT TABLE: the PartnerAllowlist that used to authorize this
// existed because Company was the customer boundary — one tenant naming another tenant's complex
// was a cross-customer data leak, and the 201 body confirming a hit was an enumeration oracle over
// every complex on the platform. There is now ONE org (Qonshu) and the boundary is the TEAM, so
// the authorization question changed shape: the thing that must not happen is one team taking a
// building another team is already working. That is exactly what the building claim guard decides
// (./building-claim.ts), it decides it under an advisory lock rather than check-then-act, and it
// covers the lead side too — which a grant table never did. The grant table is therefore dead
// weight, and the upstream list is the only source that can tell us the complex exists at all.
//
// EXACTLY ONE MATCH, or nothing. Zero means no such complex upstream. TWO OR MORE means two
// upstream names normalize to the same building ("Sabah City" / "SABAH  CITY"), and picking either
// one would silently point this account at a complex whose identity we cannot establish — so we
// refuse to guess and leave the account unlinked for a SUPER_ADMIN to resolve by hand.
//
// NEVER THROWS, and never called from inside a transaction: it is an outbound HTTP request, and a
// transaction held open across one holds the advisory lock (and a connection) for the duration of
// somebody else's outage.
export async function resolveUpstreamPartnerName(buildingKey: string): Promise<string | null> {
  if (!buildingKey) return null;
  const creds = resolveGlobalCredentials();
  // PARTNER_API_KEY unset — nothing to ask. Not an error: a dev/test install with no partner API
  // configured must still be able to create accounts, just unlinked.
  if (!creds) return null;

  let partners: { name: string }[];
  try {
    ({ partners } = await fetchPartners({ baseUrl: creds.baseUrl, apiKey: creds.apiKey }));
  } catch (e) {
    // Upstream down, bad key, timeout, shape drift. The account is created UNLINKED and the miss
    // is logged — a Django outage must not fail the sale. tryAutoLink() below is the recovery:
    // without it, an outage at this exact moment would leave the account unlinked permanently,
    // because nothing else ever re-ran this resolution.
    console.warn("[accounts] auto-link skipped: live partner list unavailable", {
      buildingKey, reason: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  const hits = partners.filter((p) => normalizeBuildingName(p.name) === buildingKey);
  return hits.length === 1 ? hits[0].name : null;
}

// True when a write failed the @@unique([externalPartnerKey]) backstop specifically, rather than
// some other unique constraint on Account (sourceLeadId and (companyId, buildingKey) are unique
// too, and lead-conversion.ts depends on being able to tell them apart).
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

// There is deliberately NO `externalPartnerKey` and NO `teamId` field. The partner namespace is
// global, so an explicit key from a caller is a tenancy hole; setAccountPartner (SUPER_ADMIN-only,
// in src/lib/platform/account-partners.ts) is the ONLY explicit writer. The team is derived from
// the validated OWNER (resolveAssignableOwner) and never accepted from a request, because the team
// is which book the account lands in. Keeping both out of the TYPE means a future regression that
// tries to pass one is a compile error rather than a silent cross-team write.
export type NewAccountData = {
  name: string; website?: string; industry?: string; status?: AccountStatus;
  accountManagerId?: string; primaryContactName?: string;
  primaryContactEmail?: string; primaryContactPhone?: string; sourceLeadId?: string;
};

export type CreateAccountOptions = {
  // CONVERSION ONLY, and only ever read off a Lead row that already passed leadScopeWhere.
  //
  // The building belongs to the team that WON it, which is not necessarily the team the manager
  // sits in today: a salesperson who closed a deal and then moved teams must not drag the building
  // with them, and a team admin converting a member's lead must not re-home it under themselves.
  // So conversion states the team explicitly instead of letting it fall out of the owner.
  //
  // NEVER populate this from a request body — no route schema accepts it.
  teamId?: string;
};

// Who owns the new account and which company+team row it belongs to.
//
// `accountManagerId` arrives as CLIENT INPUT and used to be written straight through with no check
// at all: any id, from any company, including a PARTNER_VIEWER or another team's member. Every
// value now goes through resolveAssignableOwner, which validates the candidate against the
// database (exists, ACTIVE, an ownable role, and on a team the actor may assign into) and returns
// the team the row therefore belongs to.
//
// companyId follows the TEAM, not the actor: a SUPER_ADMIN has companyId null (see scope.ts), so
// taking it from the session would write null for exactly the role that may act across teams.
async function resolveOwnership(
  db: PrismaClient, user: SessionUser, data: NewAccountData, opts?: CreateAccountOptions,
): Promise<{ owner: AssignableOwner; companyId: string }> {
  const resolved = await resolveAssignableOwner(db, user, data.accountManagerId);
  const teamId = opts?.teamId ?? resolved.teamId;
  const team = await db.team.findUnique({ where: { id: teamId }, select: { companyId: true } });
  // Fail closed rather than fall back to user.companyId: a teamId with no team is a data bug, and
  // guessing the company would plant the row in whichever company the fallback happened to name.
  if (!team) throw new ForbiddenError("team not found");
  return { owner: { ownerId: resolved.ownerId, teamId }, companyId: team.companyId };
}

// ONE attempt, INSIDE the caller's transaction: claim the building, insert, and — only if a key was
// actually written — record the audit row.
//
// Deliberately does NOT recover from a lost auto-link race: it lets the P2002 out so the recovery
// can happen at a level that owns the TRANSACTION. On Postgres a failed statement aborts the whole
// transaction and Prisma issues no savepoints, so a retry issued here would not be a retry at all
// — it would fail with "current transaction is aborted" (a DriverAdapterError with no `.code`,
// which falls through errorResponse to a 500) and take the account down with it.
async function insertAccount(
  tx: PrismaClient, user: SessionUser, data: NewAccountData,
  owner: AssignableOwner, companyId: string, autoKey: string | null,
): Promise<Account> {
  const buildingKey = normalizeBuildingName(data.name);

  // ONE BUILDING, ONE TEAM — under an advisory lock, immediately before the insert. The unique
  // index on (companyId, buildingKey) cannot do this alone: a lead and an account live in
  // DIFFERENT tables with SEPARATE indexes, so without the lock a new lead and a converting
  // account for the same complex both read "free" and both commit. `exceptLeadId` is the won lead
  // this account came FROM, which legitimately shares the key it is handing over.
  await assertBuildingUnclaimed(tx, {
    companyId, key: buildingKey, user, name: data.name,
    exceptLeadId: data.sourceLeadId,
  });

  const account = await tx.account.create({ data: {
    companyId, teamId: owner.teamId, name: data.name, buildingKey,
    website: data.website, industry: data.industry,
    status: data.status ?? "ACTIVE",
    accountManagerId: owner.ownerId,
    primaryContactName: data.primaryContactName,
    primaryContactEmail: data.primaryContactEmail, primaryContactPhone: data.primaryContactPhone,
    sourceLeadId: data.sourceLeadId ?? null,
    externalPartnerKey: autoKey,
  } });

  if (autoKey === null) return account;
  // Attribution for the most security-sensitive write in the system — see ./partner-link-audit.ts.
  // Same `tx` as the insert, so the audit row can never outlive the link it describes.
  await recordPartnerLinkChange(tx, {
    companyId, accountId: account.id, accountName: account.name,
    actorId: user.id, action: "auto_link", partnerName: autoKey,
  });
  return account;
}

// Creates the account and, when exactly one live upstream complex matches its building, links it.
//
// MUST be called with a client that is NOT already inside a transaction: this opens its own (the
// claim guard's advisory lock is only a lock while a transaction is open) and the lost-race
// recovery below is a fresh transaction, not a retried statement.
export async function createAccount(
  db: PrismaClient, user: SessionUser, data: NewAccountData, opts?: CreateAccountOptions,
): Promise<Account> {
  const { owner, companyId } = await resolveOwnership(db, user, data, opts);

  // STRICTLY BEFORE the transaction: this is an outbound HTTP call. Resolving it inside would hold
  // the advisory lock on this building — and a pooled connection — for as long as the upstream
  // takes to answer or time out.
  const autoKey = await resolveUpstreamPartnerName(normalizeBuildingName(data.name));

  const attempt = (key: string | null) =>
    db.$transaction((tx) => insertAccount(tx as PrismaClient, user, data, owner, companyId, key));

  try {
    return await attempt(autoKey);
  } catch (e) {
    // Lost the race to a concurrent claim on the same complex — the upstream match is
    // check-then-act, @@unique([externalPartnerKey]) is what actually decides. Auto-link is a
    // convenience, never a dependency, so a lost race degrades to "created but unlinked", the same
    // outcome as every other auto-link miss. Any OTHER unique violation still propagates
    // (lead-conversion.ts needs the sourceLeadId one), and so does BuildingClaimedError — a taken
    // BUILDING is a refusal, not a degradation.
    if (!isPartnerKeyConflict(e)) throw e;
    return attempt(null);
  }
}

// Same as createAccount, but can also provision the partner's PARTNER_VIEWER login in the same
// transaction — so "add an account" and "give the partner portal access" happen atomically instead
// of as two separate admin steps (Accounts, then Users).
export async function createAccountWithLogin(db: PrismaClient, user: SessionUser, data: NewAccountData & {
  partnerLogin?: { name: string; email: string; password: string };
}): Promise<{ account: Account; partnerUser: User | null }> {
  const { partnerLogin, ...accountData } = data;
  if (partnerLogin && partnerLogin.password.length < 8) {
    throw new InvalidPartnerLoginError("password must be at least 8 characters");
  }
  const { owner, companyId } = await resolveOwnership(db, user, accountData);
  const autoKey = await resolveUpstreamPartnerName(normalizeBuildingName(accountData.name));

  const attempt = (key: string | null) => db.$transaction(async (tx) => {
    const account = await insertAccount(tx as PrismaClient, user, accountData, owner, companyId, key);
    if (!partnerLogin) return { account, partnerUser: null };
    // Same one-ACTIVE-login-per-account rule as createPartnerLogin. Vacuous on a brand-new account
    // today, and kept anyway so the rule lives in one place for both writers rather than only in
    // the one that happens to be re-entrant.
    await assertNoActivePartnerLogin(tx as PrismaClient, account.id);
    const partnerUser = await tx.user.create({
      data: {
        companyId, teamId: null, email: partnerLogin.email, name: partnerLogin.name,
        passwordHash: await hashPassword(partnerLogin.password),
        role: "PARTNER_VIEWER", accountId: account.id, status: "ACTIVE",
      },
    });
    return { account, partnerUser };
  });

  try {
    return await attempt(autoKey);
  } catch (e) {
    // Lost the auto-link race. Recovery is a fresh TRANSACTION, not a retried statement: the first
    // attempt's P2002 has already aborted this one, so nothing more can run inside it (see
    // insertAccount). The whole unit — account + partner login — is re-run with the link forced
    // off. The failed attempt rolled back in full, so the re-run cannot duplicate the partner user.
    if (!isPartnerKeyConflict(e)) throw e;
    return attempt(null);
  }
}

// A LAST-CHANCE auto-link for an account that was created unlinked, run when its Analytics tab is
// opened (src/lib/tenant/partner-analytics.ts).
//
// WHY IT EXISTS: createAccount resolves the upstream match over HTTP. If Django is down for the
// thirty seconds in which the winning team registers the building, the account is created unlinked
// and — without this — stays unlinked forever, because nothing ever re-ran the resolution. A
// transient outage must not cost a permanent link.
//
// Same claim rules as creation, and BEST EFFORT: this is a side effect of a READ, so a refusal or
// a race leaves the account exactly as it was and the tab still renders.
export async function tryAutoLink(
  db: PrismaClient, user: SessionUser, account: Account,
): Promise<Account> {
  if (account.externalPartnerKey) return account;

  const name = await resolveUpstreamPartnerName(account.buildingKey);
  if (!name) return account;

  try {
    return await db.$transaction(async (tx) => {
      await assertBuildingUnclaimed(tx as PrismaClient, {
        companyId: account.companyId, key: account.buildingKey, user, name: account.name,
        // Self and the won lead this account came from are not competitors for its own building.
        exceptAccountId: account.id, exceptLeadId: account.sourceLeadId ?? undefined,
      });
      const linked = await tx.account.update({
        where: { id: account.id }, data: { externalPartnerKey: name },
      });
      // actorId null — A SYSTEM ACTION, NOT A PERSON'S. Nobody asked for this link: it is the
      // system re-running the upstream name resolution as a side effect of somebody opening a
      // page. Stamping the reader's id would read, in the one audit that answers "who pointed this
      // account at this complex", as that reader deliberately assigning a partner — a write their
      // role may well be forbidden to make. (createAccount's auto_link keeps its actor: there the
      // link rides along with a write that person really did request.)
      await recordPartnerLinkChange(tx as PrismaClient, {
        companyId: account.companyId, accountId: account.id, accountName: account.name,
        actorId: null, action: "auto_link", partnerName: name,
      });
      return linked;
    });
  } catch (e) {
    // A taken building, a lost race on the global partner key, or anything else: the account keeps
    // its current (unlinked) state and the caller renders "not configured". Never rethrow — the
    // user asked to look at a page, not to link anything.
    if (!(e instanceof BuildingClaimedError) && !isPartnerKeyConflict(e)) {
      console.warn("[accounts] opportunistic auto-link failed", {
        accountId: account.id, reason: e instanceof Error ? e.message : String(e),
      });
    }
    return account;
  }
}

// At most one ACTIVE PARTNER_VIEWER per account. INACTIVE ones are left alone on purpose: a
// revoked login is history, and deactivating it is how a building's representative is replaced.
async function assertNoActivePartnerLogin(db: PrismaClient, accountId: string): Promise<void> {
  const existing = await db.user.findFirst({
    where: { accountId, role: "PARTNER_VIEWER", status: "ACTIVE" },
    select: { id: true },
  });
  if (existing) throw new PartnerLoginExistsError("this account already has an active partner login");
}

export type PartnerLoginRow = { id: string; name: string; email: string; status: User["status"] };

// The partner logins on one account, masked. Never returns passwordHash.
export async function listPartnerLogins(
  db: PrismaClient, user: SessionUser, accountId: string,
): Promise<PartnerLoginRow[]> {
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  const rows = await db.user.findMany({
    where: { accountId: account.id, role: "PARTNER_VIEWER" },
    select: { id: true, name: true, email: true, status: true },
    orderBy: [{ status: "asc" }, { email: "asc" }],
  });
  return rows;
}

// Create the representative login for ONE building, as the person who manages that building.
//
// This is deliberately NOT behind the user-admin gate: a sales manager owns the relationship with
// their complex's representative and must be able to hand them the portal without going through a
// team admin. `getAccount` is the whole authorization — a MEMBER can only name an account they
// manage, so a member can only ever mint a login confined to their own building.
//
// The new user gets `teamId: null` and `accountId` set: a partner is not in anybody's sales book
// (see scope.ts — PARTNER_VIEWER is scoped by accountId, never by team).
export async function createPartnerLogin(
  db: PrismaClient, user: SessionUser, accountId: string,
  login: { name: string; email: string; password: string },
): Promise<PartnerLoginRow> {
  const account = await getAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  if (login.password.length < 8) {
    throw new InvalidPartnerLoginError("password must be at least 8 characters");
  }
  const passwordHash = await hashPassword(login.password);
  return db.$transaction(async (tx) => {
    await assertNoActivePartnerLogin(tx as PrismaClient, account.id);
    const created = await tx.user.create({
      data: {
        companyId: account.companyId, teamId: null, email: login.email, name: login.name,
        passwordHash, role: "PARTNER_VIEWER", accountId: account.id, status: "ACTIVE",
      },
      select: { id: true, name: true, email: true, status: true },
    });
    return created;
  });
}

export function listAccounts(db: PrismaClient, user: SessionUser, opts?: { status?: AccountStatus; accountManagerId?: string; q?: string }): Promise<Account[]> {
  // accountScopeWhere (./scope.ts) is the single source of truth: own rows for a MEMBER, own team
  // for a team admin, the whole company for a super admin given a company, and exactly one id for
  // a PARTNER_VIEWER. The local `{ companyId }`-for-everyone copy this file used to carry was the
  // last place in the app where a member still saw the whole org.
  //
  // Caller-supplied filters are AND-ed onto the scope, never assigned over it (same rule as
  // leads.ts scopedWhere): `where.accountManagerId = x` would overwrite the `accountManagerId:
  // user.id` pinned for a MEMBER. As an AND a filter can only narrow the scope.
  const filters: Prisma.AccountWhereInput[] = [];
  if (opts?.status) filters.push({ status: opts.status });
  if (opts?.accountManagerId) filters.push({ accountManagerId: opts.accountManagerId });
  if (opts?.q) filters.push({ OR: [
    { name: { contains: opts.q, mode: "insensitive" } },
    { industry: { contains: opts.q, mode: "insensitive" } },
  ] });
  const scope = accountScopeWhere(user);
  const where: Prisma.AccountWhereInput = filters.length > 0 ? { ...scope, AND: filters } : { ...scope };
  // `id` breaks ties: equal updatedAt values would otherwise order nondeterministically, and
  // the partner dedup in company-analytics.ts takes the FIRST account per partner off this list.
  return db.account.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "asc" }] });
}

// THE CHOKEPOINT: every account-scoped read/write flows through this. A caller who cannot see the
// account gets null -> 404 everywhere downstream.
export async function getAccount(db: PrismaClient, user: SessionUser, id: string): Promise<Account | null> {
  // A partner login requesting any account other than their own, or with no accountId at all
  // (a data bug), gets nothing — checked before any query so it cannot be answered by one.
  if (user.role === "PARTNER_VIEWER" && (!user.accountId || user.accountId !== id)) {
    return Promise.resolve(null);
  }

  // A SUPER_ADMIN sits above every company and so has companyId null, which accountScopeWhere
  // rejects outright — "every company" is not a filter, and a missing key in a WHERE is the whole
  // table rather than a smaller result set. The sanctioned way through is the one scope.ts names:
  // the CALLER supplies a concrete company context. For a request that already names one account,
  // that context is the account's own company, read by primary key — and the scope function still
  // decides, it is just finally given the value it demands.
  if (user.role === "SUPER_ADMIN" && !user.companyId) {
    const row = await db.account.findUnique({ where: { id } });
    if (!row) return null;
    const scope = accountScopeWhere({ ...user, companyId: row.companyId });
    return row.companyId === scope.companyId ? row : null;
  }

  return db.account.findFirst({ where: { id, ...accountScopeWhere(user) } });
}

export async function updateAccount(db: PrismaClient, user: SessionUser, id: string, data: Partial<{
  name: string; website: string | null; industry: string | null; status: AccountStatus;
  accountManagerId: string; primaryContactName: string | null;
  primaryContactEmail: string | null; primaryContactPhone: string | null;
  // NO `externalPartnerKey` and NO `teamId`. Same reason as createAccount: the partner namespace
  // is global, so setAccountPartner (SUPER_ADMIN-only) is the sole explicit writer; and the team
  // follows the validated manager, so a caller naming it directly must fail to compile.
}>): Promise<Account> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");

  // REASSIGNMENT IS AN ADMIN ACTION. Letting a MEMBER set accountManagerId is letting them hand
  // their own account to anybody — or, under accountScopeWhere, delete it from their own book and
  // out of their own sight. Re-posting the CURRENT manager is not a reassignment and stays
  // allowed, because every edit form posts the whole record back.
  let reassigned: AssignableOwner | null = null;
  if (data.accountManagerId && data.accountManagerId !== found.accountManagerId) {
    if (!isAdmin(user)) throw new ForbiddenError("only a team admin may reassign an account");
    // Validates the candidate (exists, ACTIVE, ownable, assignable by this actor) and returns the
    // team the account therefore belongs to — so teamId FOLLOWS the manager and the two can never
    // disagree. A COMPANY_ADMIN is confined to their own team by resolveAssignableOwner, so only a
    // SUPER_ADMIN can move an account across teams.
    reassigned = await resolveAssignableOwner(db, user, data.accountManagerId);
  }

  const renamed = data.name !== undefined && data.name !== found.name;
  const buildingKey = renamed ? normalizeBuildingName(data.name!) : found.buildingKey;

  return db.$transaction(async (tx) => {
    // A RENAME IS A RE-CLAIM: "Sabah City" typed into an existing account grabs the same building
    // a create would have been refused for. Self is excepted (re-saving its own name is not a
    // clash) and so is the won lead it came from, which legitimately holds the same key.
    if (renamed) {
      await assertBuildingUnclaimed(tx as PrismaClient, {
        companyId: found.companyId, key: buildingKey, user, name: data.name,
        exceptAccountId: found.id, exceptLeadId: found.sourceLeadId ?? undefined,
      });
    }

    if (reassigned && reassigned.teamId !== found.teamId) {
      await remapFieldValuesToTeam(tx as PrismaClient, found, reassigned.teamId, user);
    }
    // Any manager change (same team or not) hides the account from the old manager: drop their
    // open task assignments, mirroring leads.ts clearUnseeableAssignees.
    if (reassigned) {
      const admins = await tx.user.findMany({
        where: { companyId: found.companyId, teamId: reassigned.teamId, role: "COMPANY_ADMIN", status: "ACTIVE" },
        select: { id: true },
      });
      await tx.accountTask.updateMany({
        where: {
          accountId: found.id, done: false,
          assigneeId: { not: null, notIn: [reassigned.ownerId, ...admins.map((a) => a.id)] },
        },
        data: { assigneeId: null },
      });
    }

    return tx.account.update({ where: { id }, data: {
      ...data,
      ...(renamed ? { buildingKey } : {}),
      ...(reassigned ? { accountManagerId: reassigned.ownerId, teamId: reassigned.teamId } : {}),
    } });
  });
}

// CROSS-TEAM TRANSFER: carry the account's custom field VALUES over to the target team's own
// definitions.
//
// AccountFieldDef is per-team (two teams may each define "Total area"), and AccountFieldValue
// points at a definition, not at a label. Moving the account without this leaves every value
// attached to the OLD team's definitions: invisible on the account (getAccountFields reads the
// account's team's defs) yet still counted by the old team, and destroyed outright the day that
// team deletes the definition. So each value is re-pointed at the target team's definition with
// the SAME label AND the same type — type included because re-pointing a NUMBER value at a DATE
// field produces a row that renders as garbage.
//
// A value with no counterpart cannot be carried, and silently dropping it would lose data the
// account's own history depended on. It is written into ONE AccountActivity note first — a human
// record on the timeline the account already shows — and then deleted.
//
// Note the deliberate asymmetry: the SOURCE LEAD stays with the team that won it. The lead is the
// record of who did the selling and is not the thing being transferred.
async function remapFieldValuesToTeam(
  tx: PrismaClient, account: Account, targetTeamId: string, user: SessionUser,
): Promise<void> {
  const values = await tx.accountFieldValue.findMany({
    where: { accountId: account.id },
    select: { id: true, value: true, fieldDef: { select: { label: true, type: true } } },
  });
  if (values.length === 0) return;

  const targetDefs = await tx.accountFieldDef.findMany({
    where: { companyId: account.companyId, teamId: targetTeamId },
    select: { id: true, label: true, type: true },
  });
  const key = (label: string, type: string) => `${label}\u0000${type}`;
  const byLabelType = new Map(targetDefs.map((d) => [key(d.label, d.type), d.id]));

  const orphans: { id: string; label: string; value: string }[] = [];
  for (const v of values) {
    const toId = byLabelType.get(key(v.fieldDef.label, v.fieldDef.type));
    if (toId) await tx.accountFieldValue.update({ where: { id: v.id }, data: { fieldDefId: toId } });
    else orphans.push({ id: v.id, label: v.fieldDef.label, value: v.value });
  }
  if (orphans.length === 0) return;

  await tx.accountActivity.create({ data: {
    companyId: account.companyId, accountId: account.id, authorId: user.id, kind: "NOTE",
    body: `Fields from previous team: ${orphans.map((o) => `${o.label}: ${o.value}`).join("; ")}`,
  } });
  await tx.accountFieldValue.deleteMany({ where: { id: { in: orphans.map((o) => o.id) } } });
}

export async function deleteAccount(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  const found = await getAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  // found.companyId, not user.companyId: a SUPER_ADMIN has none, and the uploads directory is
  // keyed by the ACCOUNT's company either way.
  await removeLeadDir(found.companyId, `account-${id}`); // uploads/<companyId>/account-<id>
  await db.account.delete({ where: { id } });
}

// convertLeadToAccount lives in ./lead-conversion.ts, not here: leads.ts needs it (auto-convert
// on the move to Won) and it needs createAccount from here, which made accounts.ts <-> leads.ts a
// genuine import cycle that only worked by accident of function-declaration hoisting.
