import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, AccountStatus, User } from "@prisma/client";
import { assertCan, ForbiddenError, isAdmin, NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { removeLeadDir } from "@/lib/files/storage";
import { hashPassword } from "@/lib/auth/password";
import { accountScopeWhere, resolveAssignableOwner, type AssignableOwner } from "./scope";
import { assertBuildingUnclaimed, normalizeBuildingName } from "./building-claim";
import { recordPartnerLinkChange } from "./partner-link-audit";
import { seedOnboardingChecklist } from "./onboarding-seed";
import { toTrialDate, todayTrialDate } from "@/lib/trial";

export class InvalidPartnerLoginError extends Error {}
// A DEMO account's trial window is missing, backwards, or being edited on an account that is not
// on trial. Typed so the routes answer 400 with a message the user can act on.
//
// THE DATABASE WOULD ALSO CATCH IT — `Account_demo_trial_dates_check` (status <> 'DEMO' OR both
// dates present AND end >= start) — but as a RAW Postgres error with no Prisma code, which
// errorResponse cannot map and which surfaces as a bare 500. The CHECK is the backstop; this is
// the answer the user gets.
export class InvalidTrialError extends Error {}
// A status change the lifecycle does not allow. See assertStatusTransition for the rules.
export class InvalidStatusTransitionError extends Error {}
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
//
// COMPARED NORMALIZED, in JS. A PENDING link holds the normalized building name while a CONFIRMED
// one holds the upstream's exact spelling, so an exact string test would call "Komplex B" free
// while another account already had "komplex b" pending — two records for one complex, which is
// precisely what the global namespace cannot have. Postgres cannot express normalizeBuildingName
// identically (its lower() does not produce the combining dot the strip removes), and the scanned
// set is small: only accounts that hold a key at all.
export async function isPartnerKeyTaken(
  db: PrismaClient, key: string, exceptAccountId?: string,
): Promise<boolean> {
  const target = normalizeBuildingName(key);
  const holders = await db.account.findMany({
    where: {
      externalPartnerKey: { not: null },
      ...(exceptAccountId ? { id: { not: exceptAccountId } } : {}),
    },
    select: { externalPartnerKey: true },
  });
  return holders.some((h) => normalizeBuildingName(h.externalPartnerKey as string) === target);
}

// Every partner name claimed by an account ANYWHERE on the platform, NORMALIZED, in ONE query —
// the batched counterpart to isPartnerKeyTaken, for callers that must test a whole live partner
// list at once (GET /api/partners hides claimed partners so a name can't be double-claimed from
// the picker).
//
// NORMALIZED, not raw, because a PENDING link holds the normalized building name while a CONFIRMED
// one holds the upstream's exact spelling (confirmPartnerLink is where the exact spelling is
// resolved). Comparing raw strings would show "Komplex B" in the picker as unclaimed while an
// account already had "komplex b" pending — and assigning it would then collide at confirm time.
// Callers must normalize the candidate the same way before testing membership.
export async function listTakenPartnerKeys(db: PrismaClient): Promise<Set<string>> {
  const rows = await db.account.findMany({
    where: { externalPartnerKey: { not: null } },
    select: { externalPartnerKey: true },
  });
  return new Set(rows.map((r) => normalizeBuildingName(r.externalPartnerKey as string)));
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
  // THE TRIAL WINDOW, and only meaningful with `status: "DEMO"`. Dates, never strings: the routes
  // parse the ISO they receive so the service has one representation (see resolveTrialWindow).
  trialStartsAt?: Date; trialEndsAt?: Date;
};

// The trial window to WRITE for a new account, derived from its status.
//
// DEMO IS THE ONLY STATUS THAT CARRIES ONE, and an account may only BE DEMO if it was CREATED
// DEMO (updateAccount refuses every transition INTO it), so this is the one place a trial window
// is ever opened. For any other status both columns are written NULL rather than silently
// persisting dates nobody will ever read — a "trial" on an ACTIVE account is not a state this
// lifecycle has, and leaving stray dates there would make `trialEndsAt` stop meaning "on trial".
//
// `trialEndsAt` is REQUIRED for DEMO: a trial with no end is not a trial, and it is also what the
// DB CHECK demands. `trialStartsAt` defaults to TODAY, because "start the trial now" is the
// overwhelmingly common case and the UI offers a length rather than two dates.
function resolveTrialWindow(data: {
  status?: AccountStatus; trialStartsAt?: Date; trialEndsAt?: Date;
}): { trialStartsAt: Date | null; trialEndsAt: Date | null } {
  if ((data.status ?? "ACTIVE") !== "DEMO") return { trialStartsAt: null, trialEndsAt: null };
  if (!data.trialEndsAt) throw new InvalidTrialError("a trial needs an end date");
  const trialStartsAt = data.trialStartsAt ? toTrialDate(data.trialStartsAt) : todayTrialDate();
  const trialEndsAt = toTrialDate(data.trialEndsAt);
  assertTrialOrder(trialStartsAt, trialEndsAt);
  return { trialStartsAt, trialEndsAt };
}

function assertTrialOrder(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() < startsAt.getTime()) {
    throw new InvalidTrialError("the trial cannot end before it starts");
  }
}

// THE DEMO LIFECYCLE, as the owner settled it.
//
//   (create) --> DEMO --> ACTIVE   contract signed; seeds the onboarding checklist
//                    \--> CHURNED  trial lost; seeds NOTHING
//
// TWO RULES, both enforced here:
//
//  1. NOTHING MAY TRANSITION INTO DEMO. A trial is a state a building is BORN in — it is using the
//     app with no signed contract yet. "ACTIVE -> DEMO" would mean un-signing a contract, and it
//     would also have to invent a trial window for a customer who never had one. A building that
//     genuinely starts a second trial is a new conversation, not a status flip.
//  2. FROM DEMO, ONLY ACTIVE OR CHURNED. AT_RISK describes a paying customer whose relationship is
//     wobbling; applied to a trial it would quietly make the account look like a won customer in
//     every status filter while no contract exists. A trial either converts or it is written off.
//
// Everything outside DEMO keeps its existing freedom (ACTIVE <-> AT_RISK <-> CHURNED).
function assertStatusTransition(from: AccountStatus, to: AccountStatus): void {
  if (from === to) return;
  if (to === "DEMO") {
    throw new InvalidStatusTransitionError("invalid_status_transition: an account can only start as DEMO");
  }
  if (from === "DEMO" && to !== "ACTIVE" && to !== "CHURNED") {
    throw new InvalidStatusTransitionError("invalid_status_transition: a trial can only be activated or churned");
  }
}

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
//
// ONE EXCEPTION, AND IT IS NOT A WIDER OWNABLE_ROLES: converting a lead the SUPER_ADMIN owns.
// A super admin may own a LEAD (scope.ts resolveLeadOwner) but may still never be NAMED as an
// account manager through a request — OWNABLE_ROLES refuses it, which is what keeps the owner out
// of the account and task pickers and out of updateAccount's reassignment path. On CONVERSION the
// manager is not a request field at all: it is the lead's own owner, already validated when the
// lead was created or reassigned. `opts.teamId` is set ONLY by lead conversion (no route schema
// accepts it), which is what marks that path — see CreateAccountOptions above.
async function resolveOwnership(
  db: PrismaClient, user: SessionUser, data: NewAccountData, opts?: CreateAccountOptions,
): Promise<{ owner: AssignableOwner; companyId: string }> {
  const converted = opts?.teamId && data.accountManagerId
    ? await loadSuperAdminLeadOwner(db, data.accountManagerId, opts.teamId)
    : null;
  const resolved = converted ?? await resolveAssignableOwner(db, user, data.accountManagerId);
  const teamId = opts?.teamId ?? resolved.teamId;
  const team = await db.team.findUnique({ where: { id: teamId }, select: { companyId: true } });
  // Fail closed rather than fall back to user.companyId: a teamId with no team is a data bug, and
  // guessing the company would plant the row in whichever company the fallback happened to name.
  if (!team) throw new ForbiddenError("team not found");
  return { owner: { ownerId: resolved.ownerId, teamId }, companyId: team.companyId };
}

// NULL for every id that is not an ACTIVE SUPER_ADMIN of the converting team's company, so every
// other owner falls through to the unchanged resolveAssignableOwner path. A super admin that has
// been deactivated, or that belongs to another company, is a refusal rather than a fall-through:
// falling through would only produce the same refusal with a more confusing message.
async function loadSuperAdminLeadOwner(
  db: PrismaClient, ownerId: string, teamId: string,
): Promise<AssignableOwner | null> {
  const row = await db.user.findUnique({
    where: { id: ownerId },
    select: { id: true, role: true, status: true, companyId: true },
  });
  if (!row || row.role !== "SUPER_ADMIN") return null;
  if (row.status !== "ACTIVE") throw new ForbiddenError("owner is not active");
  const team = await db.team.findUnique({ where: { id: teamId }, select: { companyId: true } });
  if (!team || !row.companyId || team.companyId !== row.companyId) {
    throw new ForbiddenError("owner is not assignable");
  }
  return { ownerId: row.id, teamId };
}

// ONE attempt, INSIDE the caller's transaction: claim the building, insert, and — only if a key was
// actually written — record the audit row.
//
// Deliberately does NOT recover from a lost claim race: it lets the P2002 out so the recovery can
// happen at a level that owns the TRANSACTION. On Postgres a failed statement aborts the whole
// transaction and Prisma issues no savepoints, so a retry issued here would not be a retry at all
// — it would fail with "current transaction is aborted" (a DriverAdapterError with no `.code`,
// which falls through errorResponse to a 500) and take the account down with it.
async function insertAccount(
  tx: PrismaClient, user: SessionUser, data: NewAccountData,
  owner: AssignableOwner, companyId: string, pendingKey: string | null,
): Promise<Account> {
  const buildingKey = normalizeBuildingName(data.name);
  // BEFORE the claim guard, so a malformed trial costs neither an advisory lock nor a write: this
  // throws InvalidTrialError (-> 400) rather than letting the DB CHECK produce an unmappable 500.
  const trial = resolveTrialWindow(data);

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
    ...trial,
    accountManagerId: owner.ownerId,
    primaryContactName: data.primaryContactName,
    primaryContactEmail: data.primaryContactEmail, primaryContactPhone: data.primaryContactPhone,
    sourceLeadId: data.sourceLeadId ?? null,
    externalPartnerKey: pendingKey,
    // NEVER confirmed here, whatever else this function does. The whole point of the pending
    // state is that the person creating the account cannot be the person who approves its link —
    // see prisma/schema.prisma and ../partner-api/credentials.ts. Written explicitly rather than
    // left to the column default so that intent is visible at the insert.
    partnerLinkConfirmedAt: null,
    // WHO PROPOSED IT. Recorded only when a link was actually staked, and it is what the
    // two-person rule reads: this person cannot later confirm this link (unless they are the
    // SUPER_ADMIN, who is exempt). A COMPANY_ADMIN creating an account is therefore proposing,
    // not granting — the same as any member.
    partnerLinkProposedById: pendingKey === null ? null : user.id,
  } });

  // SEED HOOK (a): an account that is born ACTIVE has a signed contract from day one, so its
  // onboarding checklist starts now. This covers BOTH manual creation and the Won -> convert path
  // (lead-conversion.ts creates through here), which is why the hook sits at the shared insert
  // rather than in either caller. A DEMO account seeds NOTHING: no contract, no onboarding.
  //
  // Inside the caller's transaction, as seedOnboardingChecklist requires — so a later failure in
  // this same transaction (the partner audit row below, or createAccountWithLogin's partner user)
  // rolls the claim back with it and the retry re-seeds cleanly.
  if (account.status === "ACTIVE") await seedOnboardingChecklist(tx, account);

  if (pendingKey === null) return account;
  // Attribution for the most security-sensitive write in the system — see ./partner-link-audit.ts.
  // Same `tx` as the insert, so the audit row can never outlive the link it describes. The actor
  // is the salesperson: they really did propose this link, they just cannot grant it.
  await recordPartnerLinkChange(tx, {
    companyId, accountId: account.id, accountName: account.name,
    actorId: user.id, action: "pending", partnerName: pendingKey,
  });
  return account;
}

// Creates the account and stakes a PENDING partner link on the building it names.
//
// NO UPSTREAM CALL HAPPENS HERE, and that is deliberate on two counts.
//
// 1. SECURITY. This path used to resolve the account's name against the LIVE upstream partner list
//    and link on a hit, which made creating an account a yes/no oracle for "does complex X exist
//    upstream" — observable through timing and through the upstream fan-out even after the resolved
//    key was stripped from the 201 body. With the approval gate there is nothing to ask here:
//    whether the complex exists is answered at CONFIRM time, by an admin who is entitled to decide
//    it, and even there the answer never leaves the server as more than yes/no for one name.
// 2. COST. It fired a full GET /partners at the upstream on every ordinary account write.
//
// So the pending key is derived from the NAME ALONE — the normalized building name, which is the
// same identity the claim guard uses. confirmPartnerLink (src/lib/platform/account-partners.ts) is
// what later re-checks it against the live list and swaps in the upstream's exact spelling.
//
// MUST be called with a client that is NOT already inside a transaction: this opens its own (the
// claim guard's advisory lock is only a lock while a transaction is open) and the lost-race
// recovery below is a fresh transaction, not a retried statement.
export async function createAccount(
  db: PrismaClient, user: SessionUser, data: NewAccountData, opts?: CreateAccountOptions,
): Promise<Account> {
  // UP FRONT, before any lookup or write: creating a building is an account WRITE. There is no id
  // to protect here, so there is no 404-vs-403 question — a role that may not edit accounts may not
  // conjure one either. (resolveAssignableOwner would also refuse an ONBOARDING actor a line later,
  // but relying on that would make "who may create an account" a side effect of "who may own one",
  // and the two are not the same question.)
  assertCan(user, "edit_accounts");
  const { owner, companyId } = await resolveOwnership(db, user, data, opts);
  const pendingKey = await pendingPartnerKey(db, data.name);

  const attempt = (key: string | null) =>
    db.$transaction((tx) => insertAccount(tx as PrismaClient, user, data, owner, companyId, key));

  try {
    return await attempt(pendingKey);
  } catch (e) {
    // Lost the race for the GLOBAL partner namespace: another account already holds this key, and
    // @@unique([externalPartnerKey]) is what actually decides it (the in-company claim guard above
    // only sees one company). A pending link is a convenience, never a dependency, so a lost race
    // degrades to "created with no link" — the SUPER_ADMIN can still assign one by hand. Any OTHER
    // unique violation still propagates (lead-conversion.ts needs the sourceLeadId one), and so
    // does BuildingClaimedError — a taken BUILDING is a refusal, not a degradation.
    if (!isPartnerKeyConflict(e)) throw e;
    return attempt(null);
  }
}

// The key a newly named building stakes its PENDING claim with: the normalized building name, the
// same identity `buildingKey` and the claim guard use. Null means "stake nothing".
//
// Null for a name that normalizes to nothing (whitespace only). An empty-string key would be a
// meaningless global claim, and Postgres would let exactly one account hold it platform-wide.
//
// ALSO NULL WHEN THE KEY IS ALREADY HELD, NORMALIZED, ANYWHERE ON THE PLATFORM — and that check
// cannot be left to the unique index. @@unique([externalPartnerKey]) compares EXACT STRINGS, and
// the two states of a link do not store the same string: a pending link holds "komplex b" while a
// confirmed one holds the upstream's exact "Komplex B". So a member naming a building another
// company's account already reads would sail past the index and stake a second claim on one
// complex. The index catches two PENDING claims (identical normalized strings, which is the
// ordinary collision); this catches pending-against-confirmed.
//
// Compared in JS for the reason stated throughout this module: Postgres `lower()` cannot produce
// normalizeBuildingName's output (the U+0307 strip), so no index or generated column can express
// this comparison. That makes it check-then-act, and the residual window — somebody confirming
// another account onto this very complex in the milliseconds after this read — FAILS CLOSED: the
// pending link it leaves behind can never be confirmed (confirmPartnerLink runs the same
// normalized check) and shows up in the confirmation queue to be rejected.
//
// STRICTLY BEFORE the transaction: holding the advisory lock across this read would serialise
// every account create in the company behind it for no benefit.
//
// `exceptAccountId` is REQUIRED on the rename path and must not be forgotten: a rename whose new
// name normalizes to the key the account ALREADY holds ("Komplex B" -> "komplex  b") would
// otherwise find itself in the taken set and drop its own proposal.
async function pendingPartnerKey(
  db: PrismaClient, name: string, exceptAccountId?: string,
): Promise<string | null> {
  const key = normalizeBuildingName(name);
  if (!key) return null;
  return (await isPartnerKeyTaken(db, key, exceptAccountId)) ? null : key;
}

// Same as createAccount, but can also provision the partner's PARTNER_VIEWER login in the same
// transaction — so "add an account" and "give the partner portal access" happen atomically instead
// of as two separate admin steps (Accounts, then Users).
export async function createAccountWithLogin(db: PrismaClient, user: SessionUser, data: NewAccountData & {
  partnerLogin?: { name: string; email: string; password: string };
}): Promise<{ account: Account; partnerUser: User | null }> {
  const { partnerLogin, ...accountData } = data;
  // Same up-front account-write gate as createAccount, and for the same reason. Before the
  // partner-login check below so that a role which may not create accounts at all gets one answer
  // whether or not it also asked for a login.
  assertCan(user, "edit_accounts");
  // Creating the ACCOUNT stays open to a MEMBER; attaching a partner login to it does not. This is
  // the same gate as createPartnerLogin and for the same reason — a PARTNER_VIEWER holds the
  // capabilities a MEMBER is denied, so minting one is privilege escalation. Checked before any
  // write so a member's request creates nothing at all rather than the account alone.
  if (partnerLogin && !isAdmin(user)) {
    throw new ForbiddenError("only a team admin may create a partner login");
  }
  if (partnerLogin && partnerLogin.password.length < 8) {
    throw new InvalidPartnerLoginError("password must be at least 8 characters");
  }
  const { owner, companyId } = await resolveOwnership(db, user, accountData);
  const pendingKey = await pendingPartnerKey(db, accountData.name);

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
    return await attempt(pendingKey);
  } catch (e) {
    // Lost the race for the global partner key. Recovery is a fresh TRANSACTION, not a retried
    // statement: the first attempt's P2002 has already aborted this one, so nothing more can run
    // inside it (see insertAccount). The whole unit — account + partner login — is re-run with the
    // link forced off. The failed attempt rolled back in full, so the re-run cannot duplicate the
    // partner user.
    if (!isPartnerKeyConflict(e)) throw e;
    return attempt(null);
  }
}

// tryAutoLink IS GONE (security review finding F1).
//
// It was a last-chance re-resolution of the upstream partner name, run as a side effect of opening
// the Analytics tab, and its ONLY purpose was recovering a link that a Django outage had cost at
// account-creation time. The create path no longer calls the upstream at all — the pending key
// comes from the account's own name — so there is no outage to recover from and nothing left to
// retry.
//
// Removing it also retires the last tenant-reachable WRITE to externalPartnerKey: the field now
// changes only through createAccount (pending, grants nothing) and the SUPER_ADMIN paths in
// src/lib/platform/account-partners.ts.

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

// Create the representative login for ONE building.
//
// ADMIN ONLY, AND ENFORCED HERE rather than only at the route. Scope is NOT sufficient
// authorization for this write: a PARTNER_VIEWER holds exactly the capabilities a MEMBER is denied
// (view_settlements, view_payment_detail, view_object_detail — see src/lib/auth/guards.ts), so a
// member who may mint one on an account they manage can mint it with a password of their choosing,
// log in as it, and read the settlement and payment data their own gate refuses. That is privilege
// escalation, not delegation, which is why the earlier "a sales manager owns the relationship with
// their representative" convenience could not stand. `getAccount` still runs first and still
// decides WHICH account may be named; isAdmin decides whether the caller may mint at all.
//
// The new user gets `teamId: null` and `accountId` set: a partner is not in anybody's sales book
// (see scope.ts — PARTNER_VIEWER is scoped by accountId, never by team).
export async function createPartnerLogin(
  db: PrismaClient, user: SessionUser, accountId: string,
  login: { name: string; email: string; password: string },
): Promise<PartnerLoginRow> {
  // getWritableAccount, not getAccount: minting a login is a write on this account. The isAdmin
  // check below is NARROWER than edit_accounts (it keeps a MEMBER out, who does hold edit_accounts)
  // and stays where it was, behind the scope lookup — see getWritableAccount on the ordering.
  const account = await getWritableAccount(db, user, accountId);
  if (!account) throw new NotFoundError("account not in scope");
  // After the scope check on purpose: an out-of-scope account stays a 404 for everyone rather than
  // turning into a 403 that confirms the id exists. isAdmin, not assertCan("view_settlements"),
  // because that capability admits PARTNER_VIEWER — a partner must never mint a second login on
  // its own account.
  if (!isAdmin(user)) throw new ForbiddenError("only a team admin may create a partner login");
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
  // accountScopeWhere (./scope.ts) is the single source of truth: manager-or-assigned inside their
  // own team for a MEMBER, own team for a team admin, assigned-only for ONBOARDING, the whole
  // company for a super admin given a company, and exactly one id for a PARTNER_VIEWER. The local
  // `{ companyId }`-for-everyone copy this file used to carry was the last place in the app where a
  // member still saw the whole org.
  //
  // THE SCOPE IS NESTED, NOT SPREAD. This line used to read
  //
  //     { ...scope, AND: filters }
  //
  // which was correct only while every key in the scope was a scalar. The scope now carries its
  // MEMBERSHIP TEST under `AND` (manager OR assigned), so that spread copied the scope's `AND` in
  // and the literal's own `AND:` immediately REPLACED it — and the failure mode is open, not
  // closed: searching or filtering the account list returned the member's whole TEAM instead of
  // their own buildings, and ONBOARDING's whole COMPANY instead of their assignments. A filter must
  // only ever be able to NARROW the scope, which `{ AND: [scope, ...filters] }` guarantees because
  // the scope is one of the conjuncts rather than a set of keys something can overwrite.
  const filters: Prisma.AccountWhereInput[] = [];
  if (opts?.status) filters.push({ status: opts.status });
  if (opts?.accountManagerId) filters.push({ accountManagerId: opts.accountManagerId });
  if (opts?.q) filters.push({ OR: [
    { name: { contains: opts.q, mode: "insensitive" } },
    { industry: { contains: opts.q, mode: "insensitive" } },
  ] });
  const scope = accountScopeWhere(user);
  const where: Prisma.AccountWhereInput = filters.length > 0 ? { AND: [scope, ...filters] } : scope;
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

  // `{ AND: [{ id }, scope] }`, not `{ id, ...scope }`. The spread was safe (the literal added only
  // a scalar `id`, so nothing of the scope was overwritten) and is still replaced, because the
  // scope now carries an `AND` and a one-key spread next to a membership filter is exactly the
  // shape that turns into a leak the first time somebody adds a second key here.
  return db.account.findFirst({ where: { AND: [{ id }, accountScopeWhere(user)] } });
}

// THE WRITE CHOKEPOINT. Use this, never getAccount, for anything that MUTATES an account or one of
// its sub-resources (tasks, asks, activities, attachments, custom field values, installs, fees).
//
// WHY IT HAD TO EXIST. Every account mutator in this codebase authorized with getAccount alone,
// which encodes the rule "if you can read it, you can write it". That held only while read access
// meant ownership. It stopped holding the moment access could come from an ASSIGNMENT: an
// ONBOARDING user assigned to building X is legitimately inside X's read scope, and with no second
// gate they could rename it (re-staking the building claim and its pending partner link), change
// its status — including DEMO -> ACTIVE, which seeds the onboarding checklist — delete it, mint a
// PARTNER_VIEWER login for it, or edit its fields, fees, installs, tasks and asks. Read access for
// the activation checklist is not write authority over the CRM record.
//
// ORDER: THE CAPABILITY FIRST, THEN THE SCOPE. That is the opposite of createPartnerLogin's
// isAdmin check below, and the difference is deliberate. The 404-before-403 discipline exists so a
// refusal cannot confirm that an id EXISTS. `edit_accounts` is a pure ROLE test — it does not look
// at the id at all — so an ONBOARDING caller gets the identical ForbiddenError for a real id, a
// foreign id and a made-up one. It is not an oracle, and checking it first means a denied write
// costs no query. createPartnerLogin's isAdmin check is narrower than this gate (it keeps a MEMBER
// out, who DOES hold edit_accounts) and stays behind the scope lookup, where it was.
//
// Returns null for out-of-scope, exactly like getAccount, so every existing
// `if (!found) throw new NotFoundError(...)` call site keeps its shape and its 404.
export async function getWritableAccount(
  db: PrismaClient, user: SessionUser, id: string,
): Promise<Account | null> {
  assertCan(user, "edit_accounts");
  return getAccount(db, user, id);
}

export async function updateAccount(db: PrismaClient, user: SessionUser, id: string, data: Partial<{
  name: string; website: string | null; industry: string | null; status: AccountStatus;
  accountManagerId: string; primaryContactName: string | null;
  primaryContactEmail: string | null; primaryContactPhone: string | null;
  // EXTENDING A TRIAL — the only reason these are writable at all, and only while the account IS
  // DEMO (see below). NOT nullable: a DEMO account with a missing date is exactly what the DB
  // CHECK forbids, and clearing a trial is not an operation this lifecycle has.
  trialStartsAt: Date; trialEndsAt: Date;
  // NO `externalPartnerKey` and NO `teamId`. Same reason as createAccount: the partner namespace
  // is global, so setAccountPartner (SUPER_ADMIN-only) is the sole explicit writer; and the team
  // follows the validated manager, so a caller naming it directly must fail to compile.
}>): Promise<Account> {
  // getWritableAccount: a rename re-stakes the pending partner link and re-claims the building, and
  // a status change can seed the onboarding checklist. Neither is something read access buys.
  const found = await getWritableAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");

  // THE LIFECYCLE GATE, before any other work: an illegal status change must cost nothing and must
  // not half-apply the rest of the patch. Every status write in the app comes through here.
  if (data.status) assertStatusTransition(found.status, data.status);

  // SEEDING IS DRIVEN OFF THE TRANSITION, not off the new value: a patch that re-posts ACTIVE on an
  // already-ACTIVE account is not an activation and must not look like one. (seedOnboardingChecklist
  // would refuse it anyway — the claim is the authority — but the intent belongs here, in the
  // caller that knows what changed.)
  const becameActive = data.status === "ACTIVE" && found.status !== "ACTIVE";

  // TRIAL DATES ARE EDITABLE ONLY WHILE THE ACCOUNT IS DEMO. That is how a trial gets EXTENDED,
  // and it is the whole of the permission: re-dating the trial of a signed customer (or of a
  // churned one) would rewrite history on a window nothing reads any more, and on a non-DEMO row
  // the DB CHECK does not even require the pair to be coherent. Refused together with a status
  // change out of DEMO in the same patch, because "activate and also extend the trial you are
  // ending" has no meaning — the UI sends one or the other.
  //
  // A NO-OP RE-POST IS NOT AN EDIT. Every edit form in this app posts the whole record back (see
  // the accountManagerId branch above, which exists for the same reason), so a form that renders
  // the trial window would otherwise 400 on an ACTIVE account merely for echoing the dates that
  // are already stored. Compared against the row, not against `undefined`.
  const { trialStartsAt: patchStart, trialEndsAt: patchEnd, ...rest } = data;
  const unchanged = (patch: Date | undefined, current: Date | null) =>
    patch === undefined || (current !== null && toTrialDate(patch).getTime() === current.getTime());
  const editingTrial = !unchanged(patchStart, found.trialStartsAt) || !unchanged(patchEnd, found.trialEndsAt);
  let trial: { trialStartsAt: Date; trialEndsAt: Date } | null = null;
  if (editingTrial) {
    if (found.status !== "DEMO" || (data.status !== undefined && data.status !== "DEMO")) {
      throw new InvalidTrialError("trial dates can only be changed while the account is on trial");
    }
    // Each side falls back to what the row already holds, so extending a trial means sending the
    // new end date alone. A DEMO row always has both (the DB CHECK guarantees it); the `??` is
    // there so a hand-edited row cannot turn this into a crash.
    const trialStartsAt = patchStart ? toTrialDate(patchStart)
      : found.trialStartsAt ? toTrialDate(found.trialStartsAt) : todayTrialDate();
    const trialEndsAt = patchEnd ? toTrialDate(patchEnd)
      : found.trialEndsAt ? toTrialDate(found.trialEndsAt) : todayTrialDate();
    assertTrialOrder(trialStartsAt, trialEndsAt);
    trial = { trialStartsAt, trialEndsAt };
  }

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

  // A RENAME RE-STAKES A PENDING LINK, and only a pending one.
  //
  // The pending key is derived from the account's name, so after a rename the old key no longer
  // names the building the account now claims — a typo staked "sabah citi" and the corrected
  // account would otherwise sit behind a proposal that can never be confirmed, with nothing in the
  // app able to re-stake it. Re-pointing it is safe precisely because a pending link grants
  // nothing: this is editing a proposal, not moving an entitlement.
  //
  // A CONFIRMED LINK IS NEVER TOUCHED HERE. That is the long-standing rule the whole module is
  // built around — externalPartnerKey is what decides which complex's data flows in, so renaming
  // an account must not re-point live data, and setAccountPartner (SUPER_ADMIN-only) stays the
  // sole writer of a live link. A rename on a confirmed account changes its name and its
  // buildingKey, and leaves the link exactly as the owner approved it.
  //
  // `restaking` is false when nothing about the link should change — not renamed, or renamed on a
  // CONFIRMED link, which is never re-pointed here.
  const restaking = renamed && !found.partnerLinkConfirmedAt;
  // `let`, because the lost-race recovery below re-runs with the proposal forced off.
  let restakeKey = restaking ? await pendingPartnerKey(db, data.name!, found.id) : null;

  const attempt = () => db.$transaction(async (tx) => {
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
      // ONE SOURCE PER FACT. The new manager has access through `accountManagerId`; an assignment
      // row saying the same thing is a second, independent grant that outlives the next
      // reassignment — revoking their management would leave them silently assigned. Deleted
      // BEFORE the keep-list is read so the row cannot come back as its own justification.
      await tx.accountAssignment.deleteMany({
        where: { accountId: found.id, userId: reassigned.ownerId },
      });
      // ASSIGNED USERS KEEP THEIR WORK. The keep-list used to be the new manager plus the target
      // team's admins, which pre-dates AccountAssignment: an ONBOARDING user assigned to this
      // building is still in its scope after a manager change (accountScopeWhere admits them by
      // assignment, not by team), so nulling their open items would strip the checklist they are
      // there to run for a change that has nothing to do with them.
      const assigned = await tx.accountAssignment.findMany({
        where: { accountId: found.id }, select: { userId: true },
      });
      const keep = [reassigned.ownerId, ...admins.map((a) => a.id), ...assigned.map((a) => a.userId)];
      await tx.accountTask.updateMany({
        where: { accountId: found.id, done: false, assigneeId: { not: null, notIn: keep } },
        data: { assigneeId: null },
      });
      // The same treatment for the onboarding checklist, which is the other thing on an account
      // that carries an assignee. Open steps only: a DONE step records who actually did it and is
      // history, not a work item.
      await tx.onboardingStep.updateMany({
        where: { accountId: found.id, done: false, assigneeId: { not: null, notIn: keep } },
        data: { assigneeId: null },
      });
    }

    const updated = await tx.account.update({ where: { id }, data: {
      // `rest`, not `data`: the trial dates are re-written below from `trial`, normalized to the
      // UTC-midnight calendar days the `@db.Date` columns hold.
      ...rest,
      ...(trial ?? {}),
      ...(renamed ? { buildingKey } : {}),
      ...(restaking
        ? {
            externalPartnerKey: restakeKey,
            partnerLinkConfirmedAt: null,
            // The renamer becomes the proposer, and so cannot confirm it themselves. Null when the
            // key is null, so a dropped proposal leaves no stale proposer behind.
            partnerLinkProposedById: restakeKey === null ? null : user.id,
          }
        : {}),
      ...(reassigned ? { accountManagerId: reassigned.ownerId, teamId: reassigned.teamId } : {}),
    } });

    // Audit the re-stake, and only a REAL one. Driven off `restakeKey`, which is the value actually
    // written above — not off the pre-check — so the recovery path below, which forces the key to
    // null, cannot leave behind a row claiming a proposal that was never staked. A rename landing
    // on the same key is likewise not a transition worth a row.
    if (restakeKey !== null && restakeKey !== found.externalPartnerKey) {
      await recordPartnerLinkChange(tx as PrismaClient, {
        companyId: found.companyId, accountId: found.id, accountName: updated.name,
        actorId: user.id, action: "pending", partnerName: restakeKey,
      });
    }

    // SEED HOOK (b): the account BECAME ACTIVE in this transaction — the DEMO -> ACTIVE contract
    // signature, or any other status landing on ACTIVE. Inside the same transaction as the status
    // write, so "is ACTIVE" and "has a checklist" commit together or not at all, and so the claim
    // inside seedOnboardingChecklist sees the ACTIVE row it requires.
    //
    // A PRE-EXISTING account coming back from AT_RISK seeds NOTHING: the migration backfilled its
    // `onboardingSeededAt`, so the claim matches zero rows. That is the regression the backfill
    // exists to prevent.
    if (becameActive) await seedOnboardingChecklist(tx, updated);
    return updated;
  });

  try {
    return await attempt();
  } catch (e) {
    // Lost the race for the global partner key between the pre-check and the write. Degrade to
    // "renamed, proposal dropped" rather than failing the rename: the rename is what the user
    // asked for, and the proposal is a convenience a SUPER_ADMIN can supply by hand. A fresh
    // transaction, not a retried statement — the P2002 has already aborted the first one.
    if (!isPartnerKeyConflict(e) || !restaking || restakeKey === null) throw e;
    restakeKey = null;
    return attempt();
  }
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
  const found = await getWritableAccount(db, user, id);
  if (!found) throw new NotFoundError("account not in scope");
  // found.companyId, not user.companyId: a SUPER_ADMIN has none, and the uploads directory is
  // keyed by the ACCOUNT's company either way.
  await removeLeadDir(found.companyId, `account-${id}`); // uploads/<companyId>/account-<id>
  await db.account.delete({ where: { id } });
}

// convertLeadToAccount lives in ./lead-conversion.ts, not here: leads.ts needs it (auto-convert
// on the move to Won) and it needs createAccount from here, which made accounts.ts <-> leads.ts a
// genuine import cycle that only worked by accident of function-declaration hoisting.
