import { Prisma } from "@prisma/client";
import type { PrismaClient, Account, Lead } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { leadScopeWhere } from "./visibility";
import { createAccount, isPartnerKeyConflict } from "./accounts";

// Lead -> Account conversion, extracted out of accounts.ts.
//
// WHY ITS OWN MODULE: leads.ts (moveLeadStage, auto-convert on Won) needs this function, and this
// function needs createAccount from accounts.ts. Defining it in accounts.ts made accounts.ts and
// leads.ts import each other — a real cycle that only happened to work because both sides were
// hoisted `function` declarations. One import graph now: leads.ts -> lead-conversion.ts ->
// accounts.ts, with the lead WHERE-builder pulled from visibility.ts (which imports neither).

// Scoped lead lookup. Same rule as getLead() in leads.ts, re-derived from the shared
// leadScopeWhere rather than imported, so this module never points back at leads.ts.
function getLeadInScope(db: PrismaClient, user: SessionUser, id: string): Promise<Lead | null> {
  return leadScopeWhere(db, user).then((where) => db.lead.findFirst({ where: { id, ...where } }));
}

function findAccountForLead(db: PrismaClient, user: SessionUser, leadId: string): Promise<Account | null> {
  return db.account.findFirst({ where: { companyId: user.companyId!, sourceLeadId: leadId } });
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
  const existing = await findAccountForLead(db, user, leadId);
  if (existing) return { account: existing, created: false };
  const stage = await db.stage.findFirst({ where: { id: lead.stageId, companyId: user.companyId! } });
  if (!stage || stage.type !== "WON") throw new Error("lead is not in a Won stage");
  const name = lead.companyName ?? lead.title;
  try {
    // No partner key is passed: createAccount does the allowlist auto-link itself, so a Won drag
    // can only ever link this company to a complex a SUPER_ADMIN granted it. The lead's company
    // name is tenant-supplied free text and carries no authority of its own.
    const account = await createAccount(db, user, {
      name,
      accountManagerId: lead.ownerId, primaryContactName: lead.contactName,
      primaryContactEmail: lead.email ?? undefined, primaryContactPhone: lead.phone ?? undefined,
      sourceLeadId: lead.id,
    });
    return { account, created: true };
  } catch (e) {
    // Lost the race on the unique sourceLeadId — the concurrent caller's account is the one.
    // A P2002 on externalPartnerKey never reaches here: createAccount absorbs that one by
    // re-inserting unlinked, so this branch only ever sees the sourceLeadId clash it is written
    // for (guarded explicitly so a future third unique column can't be silently misread as one).
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002" && !isPartnerKeyConflict(e)) {
      const raced = await findAccountForLead(db, user, leadId);
      if (raced) return { account: raced, created: false };
    }
    throw e;
  }
}
