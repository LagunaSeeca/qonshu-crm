import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, Lead } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { leadScopeWhere } from "./scope";
import { createAccount, isPartnerKeyConflict } from "./accounts";

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
  if (existing) return { account: existing, created: false };
  // lead.companyId, not user.companyId: the stage belongs to the lead's company, and a SUPER_ADMIN
  // converting a lead has no company of its own to filter by.
  const stage = await db.stage.findFirst({ where: { id: lead.stageId, companyId: lead.companyId } });
  if (!stage || stage.type !== "WON") throw new Error("lead is not in a Won stage");
  const name = lead.companyName ?? lead.title;
  try {
    const account = await createAccount(
      db,
      user,
      {
        name,
        // The MANAGER is the person who sold it, not whoever clicked Convert.
        accountManagerId: lead.ownerId, primaryContactName: lead.contactName,
        primaryContactEmail: lead.email ?? undefined, primaryContactPhone: lead.phone ?? undefined,
        // Tells createAccount's claim guard that THIS lead's hold on the building is not a clash:
        // the won lead and the account it becomes legitimately share one buildingKey (separate
        // tables, separate unique indexes).
        sourceLeadId: lead.id,
      },
      {
        // THE TEAM COMES FROM THE LEAD, never from the actor. A SUPER_ADMIN has no team at all, so
        // deriving it from the session would be null; and a team admin may legitimately convert a
        // member's lead, which must not re-home the building under the admin. The building belongs
        // to the team that won it — including when its owner has since changed teams.
        teamId: lead.teamId,
      },
    );
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
