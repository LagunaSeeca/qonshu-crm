import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, Lead } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { assertCan, NotFoundError } from "@/lib/auth/guards";
import { leadScopeWhere } from "./scope";
import { createAccount, isPartnerKeyConflict, InvalidTrialError } from "./accounts";
import { seedOnboardingChecklist } from "./onboarding-seed";

// Lead -> Account conversion, extracted out of accounts.ts.
//
// WHY ITS OWN MODULE: leads.ts (moveLeadStage, auto-convert on Won) needs this function, and this
// function needs createAccount from accounts.ts. Defining it in accounts.ts made accounts.ts and
// leads.ts import each other — a real cycle that only happened to work because both sides were
// hoisted `function` declarations. One import graph now: leads.ts -> lead-conversion.ts ->
// accounts.ts, with the lead WHERE-builder pulled from scope.ts (which imports neither).

// Scoped lead lookup. Same rule as getLead() in leads.ts, re-derived from the shared
// leadScopeWhere rather than imported, so this module never points back at leads.ts.
function getLeadInScope(db: PrismaClient, user: SessionUser, id: string): Promise<Lead | null> {
  return db.lead.findFirst({ where: { id, ...leadScopeWhere(user) } });
}

// Unscoped by company on purpose: Account.sourceLeadId is @unique platform-wide, so there is at
// most one row to find and the LEAD is what was already scope-checked. Filtering by
// user.companyId here would answer null for a SUPER_ADMIN (whose companyId is null) and
// cheerfully convert the same lead a second time.
function findAccountForLead(db: PrismaClient, leadId: string): Promise<Account | null> {
  return db.account.findUnique({ where: { sourceLeadId: leadId } });
}

// lead.companyId, not user.companyId: the stage belongs to the lead's company, and a SUPER_ADMIN
// has no company of its own to filter by.
function leadStage(db: PrismaClient, lead: Lead) {
  return db.stage.findFirst({ where: { id: lead.stageId, companyId: lead.companyId } });
}

// The account fields a lead hands over, shared by the WON conversion and the TRIAL start so the
// two can never disagree about what a building inherits from its lead.
function accountDataFromLead(lead: Lead) {
  return {
    name: lead.companyName ?? lead.title,
    // The MANAGER is the person who sold it, not whoever clicked the button.
    accountManagerId: lead.ownerId,
    primaryContactName: lead.contactName,
    primaryContactEmail: lead.email ?? undefined,
    primaryContactPhone: lead.phone ?? undefined,
    // Tells createAccount's claim guard that THIS lead's hold on the building is not a clash:
    // the lead and the account it becomes legitimately share one buildingKey (separate tables,
    // separate unique indexes).
    sourceLeadId: lead.id,
  };
}

// START A 2-3 MONTH TRIAL from a lead that is still IN THE PIPELINE.
//
// WHY AN ACCOUNT AT ALL, for a building with no signed contract: it is already using the mobile
// app, so the sales team needs its live statistics — and statistics hang off an Account, through
// the partner link. The answer is an account in `DEMO`, which shows up in Accounts with its full
// statistics while being excluded from every "won customer" figure (the dashboard counts
// `status === "ACTIVE"`). The LEAD stays exactly where it is, not-yet-Won: starting a trial is not
// winning a deal.
//
// REFUSED ON A WON OR LOST LEAD. A won lead's building is a customer, not a prospect on trial
// (convertLeadToAccount is its path); a lost one is not getting a trial at all. Both are
// InvalidTrialError -> 400, because both are a mistake the caller can see and correct.
//
// IDEMPOTENT: a lead that already has an account — a trial started twice, a double-click, or a
// lead that was converted outright — gets that account back, UNCHANGED. No second account, no
// status or date overwrite: re-posting a trial must never re-open the window on a signed customer.
//
// IT CREATES THROUGH createAccount, deliberately, and must keep doing so. That is what preserves
// the BUILDING CLAIM — `buildingKey`, `@@unique([companyId, buildingKey])`, the `pg_advisory_xact_lock`
// and the `exceptLeadId` exemption for this lead's own hold on the key — plus the pending
// partner-link rules (name-derived, never confirmed here, two-person approval) and the
// `edit_accounts` gate. A hand-rolled insert here would let a trial grab a building another team
// already sold, which is the exact thing the claim exists to stop.
export async function startTrialFromLead(
  db: PrismaClient, user: SessionUser, leadId: string,
  trial: { trialStartsAt?: Date; trialEndsAt: Date },
): Promise<{ account: Account; created: boolean }> {
  const lead = await getLeadInScope(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const existing = await findAccountForLead(db, leadId);
  if (existing) return { account: existing, created: false };
  const stage = await leadStage(db, lead);
  if (stage?.type === "WON" || stage?.type === "LOST") {
    throw new InvalidTrialError("a won or lost lead cannot be put on trial");
  }
  try {
    const account = await createAccount(
      db, user,
      // createAccount validates the window (end date required, end >= start) and normalizes both
      // to the calendar days the `@db.Date` columns hold, so a bad trial is a 400 and never the
      // raw Postgres error from Account_demo_trial_dates_check.
      { ...accountDataFromLead(lead), status: "DEMO", ...trial },
      { teamId: lead.teamId },
    );
    return { account, created: true };
  } catch (e) {
    // Same lost-race resolution as convertLeadToAccount: `sourceLeadId` is @unique, so a
    // concurrent caller's account is THE account. See that function for why the partner-key
    // conflict and BuildingClaimedError are excluded.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && !isPartnerKeyConflict(e)) {
      const raced = await findAccountForLead(db, leadId);
      if (raced) return { account: raced, created: false };
    }
    throw e;
  }
}

// THE CONTRACT SIGNATURE on a building that was already on trial: DEMO -> ACTIVE, which seeds the
// onboarding checklist.
//
// It hangs off convertLeadToAccount because BOTH ways of saying "we won this" land there — the
// manual "Convert to Account" button (src/app/api/accounts/from-lead/route.ts) and the automatic
// convert-on-WON inside moveLeadStage (src/lib/tenant/leads.ts calls convertLeadToAccount after
// its stage transaction commits). Verified in both call sites: there is no second path that
// creates or activates an account from a lead.
//
// ONE TRANSACTION, CONDITIONAL CLAIM. `updateMany({ where: { id, status: "DEMO" } })` is what makes
// a double promotion a no-op: the second caller matches 0 rows, skips the seed, and returns the
// row the first one produced. Seeding shares that transaction, so "ACTIVE" and "has a checklist"
// commit together — and seedOnboardingChecklist's own claim is a second guard underneath this one.
//
// NOT GATED ON THE LEAD BEING IN WON, on purpose: the owner's rule is that activating a trial does
// NOT move its lead to Won — sales does that separately, and both orders must work. A LOST lead is
// the one exception: losing the deal during a trial leaves the account in DEMO for somebody to set
// CHURNED by hand, so a convert clicked on a lost lead changes nothing.
//
// Anything that is not DEMO is returned untouched, which keeps convertLeadToAccount's long-standing
// idempotency contract intact for ACTIVE, AT_RISK and CHURNED accounts.
async function promoteDemoAccount(
  db: PrismaClient, user: SessionUser, lead: Lead, existing: Account,
): Promise<Account> {
  if (existing.status !== "DEMO") return existing;
  const stage = await leadStage(db, lead);
  if (stage?.type === "LOST") return existing;
  // The status write is an account WRITE. The lead was scope-checked, but that authorizes reading
  // the lead, not activating the building — the same gate updateAccount applies, applied here
  // because this path does not go through it.
  assertCan(user, "edit_accounts");
  return db.$transaction(async (tx) => {
    const claim = await tx.account.updateMany({
      where: { id: existing.id, status: "DEMO" }, data: { status: "ACTIVE" },
    });
    if (claim.count > 0) await seedOnboardingChecklist(tx, existing);
    // Re-read inside the transaction: the caller gets the row as it now stands (status, and the
    // `onboardingSeededAt` stamp the seeder wrote), not the stale DEMO copy we started from.
    return tx.account.findUniqueOrThrow({ where: { id: existing.id } });
  });
}

// THE single conversion path — the manual "Convert to Account" button and the automatic
// convert-on-WON in moveLeadStage both land here, so a lead can never produce two accounts.
//
// Idempotent by design: a lead already converted returns its EXISTING account with
// created=false (no throw, no duplicate), whatever stage it sits in now. That covers
// double-clicks, retries, and moving out of Won and back in. `Account.sourceLeadId` is
// @unique, so a true race loses at the DB and is resolved by re-reading the winner's row.
export async function convertLeadToAccount(db: PrismaClient, user: SessionUser, leadId: string): Promise<{ account: Account; created: boolean }> {
  const lead = await getLeadInScope(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const existing = await findAccountForLead(db, leadId);
  // A lead whose building is already an account converts no second time. The account may however
  // be a TRIAL that this conversion is the signature on — see promoteDemoAccount.
  if (existing) return { account: await promoteDemoAccount(db, user, lead, existing), created: false };
  // lead.companyId, not user.companyId: the stage belongs to the lead's company, and a SUPER_ADMIN
  // converting a lead has no company of its own to filter by.
  const stage = await leadStage(db, lead);
  if (!stage || stage.type !== "WON") throw new Error("lead is not in a Won stage");
  try {
    const account = await createAccount(db, user, accountDataFromLead(lead), {
      // THE TEAM COMES FROM THE LEAD, never from the actor. A SUPER_ADMIN has no team at all, so
      // deriving it from the session would be null; and a team admin may legitimately convert a
      // member's lead, which must not re-home the building under the admin. The building belongs
      // to the team that won it — including when its owner has since changed teams.
      teamId: lead.teamId,
    });
    return { account, created: true };
  } catch (e) {
    // Lost the race on the unique sourceLeadId — the concurrent caller's account is the one.
    // A P2002 on externalPartnerKey never reaches here: createAccount absorbs that one by
    // re-inserting unlinked, so this branch only ever sees the sourceLeadId clash it is written
    // for (guarded explicitly so a future third unique column can't be silently misread as one).
    //
    // BuildingClaimedError is deliberately NOT caught: another team already holds this building,
    // which is a refusal and not a race, and the caller must be able to report it as
    // `building_claimed` rather than silently produce no account.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && !isPartnerKeyConflict(e)) {
      const raced = await findAccountForLead(db, leadId);
      if (raced) return { account: raced, created: false };
    }
    throw e;
  }
}
