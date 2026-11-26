import type { PrismaClient, Lead, Priority, Prisma, Stage } from "@prisma/client";
import { ForbiddenError, NotFoundError, isAdmin, type SessionUser } from "@/lib/auth/guards";
import { leadScopeWhere, resolveLeadOwner } from "./scope";
import { assertBuildingUnclaimed, BuildingClaimedError, normalizeBuildingName } from "./building-claim";
import { removeLeadDir } from "@/lib/files/storage";
import { convertLeadToAccount } from "./lead-conversion";

// Anything shaped like an interactive-transaction client: what $transaction's callback hands us.
// Deliberately NOT PrismaClient — assertBuildingUnclaimed throws if it is given a full client,
// because the advisory lock would then commit (and release) before the caller's write.
type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export type CreateLeadInput = {
  title: string;
  contactName: string;
  stageId: string;
  // REQUIRED, where it used to be optional. The company name IS the building name, and the
  // building name is the claim identity (Lead.buildingKey, unique per company). Optional, it
  // fell back to `title` — so two salespeople typing different titles for the same complex each
  // got their own claim, which is the exact thing the claim exists to prevent.
  companyName: string;
  email?: string;
  phone?: string;
  source?: string;
  priority?: Priority;
  ownerId?: string;
  // READ ONLY WHEN THE SUPER ADMIN NAMES ITSELF AS THE OWNER. Lead.teamId is NOT NULL and the
  // owner has no team, so that one case must say which team's book the lead lands in. For every
  // other actor resolveLeadOwner drops this value and the team keeps following the validated
  // owner — a COMPANY_ADMIN or MEMBER cannot move a lead with a forged teamId.
  teamId?: string;
  expectedCloseDate?: Date | null;
};

// Create a lead and claim its building, in ONE transaction.
//
// The guard and the insert MUST share a transaction: pg_advisory_xact_lock is held only until
// the transaction that took it ends, so a guard that commits before the insert serialises
// nothing at all (see building-claim.ts). Everything that decides WHERE the row lands — the
// owner, the owner's team, the company, the stage — is resolved inside that same transaction,
// so none of it can be stale by the time the row is written.
export async function createLead(db: PrismaClient, user: SessionUser, data: CreateLeadInput): Promise<Lead> {
  const buildingKey = normalizeBuildingName(data.companyName);
  // Defensive: the route rejects a blank name with a 400 before reaching here (zod
  // `.trim().min(1)`). A name that normalizes to "" would claim the empty key — one shared
  // claim for every unnamed building in the company.
  if (!buildingKey) throw new Error("companyName (building name) is required");

  return db.$transaction(async (tx) => {
    // The owner decides the team, the team decides the company. Never read a teamId from the
    // request: scope.ts validates the owner against the database and returns the pair.
    const { ownerId, teamId } = await resolveLeadOwner(tx, user, data.ownerId, data.teamId);
    const team = await tx.team.findUnique({ where: { id: teamId }, select: { companyId: true } });
    if (!team) throw new NotFoundError("team not found");
    const companyId = team.companyId;
    // Cross-company fail-safe for a corrupt session (a teamId belonging to another company than
    // the session's companyId): deriving companyId from the team would otherwise write the row
    // into that other company. A SUPER_ADMIN has no companyId of its own, so it is exempt.
    if (user.companyId && user.role !== "SUPER_ADMIN" && companyId !== user.companyId) {
      throw new ForbiddenError("team is not in your company");
    }

    // The stage must be the OWNER'S TEAM'S own stage. `teamId` in the WHERE is what rejects both
    // a sibling team's stage and an org-template row (teamId null) — template stages are never
    // attached to leads.
    const stage = await tx.stage.findFirst({ where: { id: data.stageId, companyId, teamId } });
    if (!stage) throw new NotFoundError("stage not in this team");

    await assertBuildingUnclaimed(tx, { companyId, key: buildingKey, user, name: data.companyName });

    return tx.lead.create({
      data: {
        companyId, teamId, buildingKey, ownerId,
        title: data.title, contactName: data.contactName, stageId: data.stageId,
        companyName: data.companyName,
        email: data.email, phone: data.phone, source: data.source,
        priority: data.priority ?? "MEDIUM",
        expectedCloseDate: data.expectedCloseDate ?? null,
        // A lead created straight into a Won stage is won as of now. Left null, it would be a
        // won lead that no wonAt-based report ever counts.
        wonAt: stage.type === "WON" ? new Date() : null,
      },
    });
  });
}

function searchFilter(q: string): Prisma.LeadWhereInput {
  return {
    OR: [
      { title: { contains: q, mode: "insensitive" } },
      { contactName: { contains: q, mode: "insensitive" } },
      { companyName: { contains: q, mode: "insensitive" } },
    ],
  };
}

// Every caller-supplied filter is AND-ed onto the scope, never spread over it.
//
// THE BUG THIS FIXES: the old body was `const where = { ...scope }; if (opts.ownerId) where.ownerId
// = opts.ownerId`. For a MEMBER the scope had just pinned `ownerId: user.id`, and that line
// OVERWROTE it — so `GET /api/leads?ownerId=<colleague>` handed a member another person's book.
// As an AND a filter can only ever narrow what the scope already allows.
function scopedWhere(user: SessionUser, filters: Prisma.LeadWhereInput[]): Prisma.LeadWhereInput {
  const scope = leadScopeWhere(user);
  const applied = filters.filter((f) => Object.keys(f).length > 0);
  return applied.length > 0 ? { ...scope, AND: applied } : { ...scope };
}

export async function listLeads(db: PrismaClient, user: SessionUser, opts?: {
  stageId?: string; ownerId?: string; q?: string; sort?: "createdAt"; skip?: number; take?: number;
}): Promise<Lead[]> {
  const where = scopedWhere(user, [
    opts?.stageId ? { stageId: opts.stageId } : {},
    opts?.ownerId ? { ownerId: opts.ownerId } : {},
    opts?.q ? searchFilter(opts.q) : {},
  ]);
  return db.lead.findMany({
    where, orderBy: { [opts?.sort ?? "createdAt"]: "desc" }, skip: opts?.skip, take: opts?.take,
  });
}

// Enriched rows for the board cards + list table: everything worth seeing at a glance without
// opening the lead — owner, contact phone, the last time anything happened, and the next date on
// the calendar. Kept to one findMany (owner join + newest activity) so it stays cheap.
export type LeadCard = {
  id: string; title: string; stageId: string; contactName: string; phone: string | null;
  priority: Priority; ownerName: string; lastActivityAt: string | null; nextDate: string | null;
};
export async function listLeadCards(db: PrismaClient, user: SessionUser, opts?: {
  stageId?: string; q?: string;
}): Promise<LeadCard[]> {
  const where = scopedWhere(user, [
    opts?.stageId ? { stageId: opts.stageId } : {},
    opts?.q ? searchFilter(opts.q) : {},
  ]);
  const leads = await db.lead.findMany({
    where,
    orderBy: { createdAt: "desc" },
    include: {
      owner: { select: { name: true, email: true } },
      activities: { orderBy: { occurredAt: "desc" }, take: 1, select: { occurredAt: true } },
    },
  });
  return leads.map((l) => ({
    id: l.id, title: l.title, stageId: l.stageId, contactName: l.contactName, phone: l.phone,
    priority: l.priority,
    ownerName: l.owner?.name ?? l.owner?.email ?? "—",
    lastActivityAt: l.activities[0]?.occurredAt.toISOString() ?? null,
    nextDate: l.expectedCloseDate?.toISOString() ?? null,
  }));
}

export async function getLead(db: PrismaClient, user: SessionUser, id: string): Promise<Lead | null> {
  return db.lead.findFirst({ where: { id, ...leadScopeWhere(user) } });
}

export type UpdateLeadInput = Partial<{
  title: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  // NOT nullable: it is the building name, and a lead with no building has no claim.
  companyName: string;
  source: string | null;
  priority: Priority;
  ownerId: string;
  // Same rule as on create, plus one: OMITTED MEANS "KEEP THE LEAD'S CURRENT TEAM". The fallback
  // is found.teamId, never a default team, so a super admin re-saving their own lead without
  // naming a team cannot transfer it as a side effect.
  teamId: string;
  expectedCloseDate: Date | null;
}>;

export async function updateLead(
  db: PrismaClient, user: SessionUser, id: string, data: UpdateLeadInput,
): Promise<Lead> {
  const found = await getLead(db, user, id);
  if (!found) throw new NotFoundError("lead not in scope");

  // ONLY ADMINS MAY REASSIGN. Before this, PATCH /api/leads/[id] accepted `ownerId` from anyone
  // who could see the lead and checked only "is that user in my company" — so a MEMBER could
  // push a lead into a colleague's book and, under the scope rules, never see it again.
  const wantsReassign = data.ownerId !== undefined && data.ownerId !== found.ownerId;
  if (wantsReassign && !isAdmin(user)) throw new ForbiddenError("only a team admin may reassign a lead");

  const renamed = data.companyName !== undefined && data.companyName !== found.companyName;
  const nextKey = data.companyName !== undefined ? normalizeBuildingName(data.companyName) : null;
  if (data.companyName !== undefined && !nextKey) throw new Error("companyName (building name) is required");

  return db.$transaction(async (tx) => {
    const update: Prisma.LeadUncheckedUpdateInput = {};
    if (data.title !== undefined) update.title = data.title;
    if (data.contactName !== undefined) update.contactName = data.contactName;
    if (data.email !== undefined) update.email = data.email;
    if (data.phone !== undefined) update.phone = data.phone;
    if (data.source !== undefined) update.source = data.source;
    if (data.priority !== undefined) update.priority = data.priority;
    if (data.expectedCloseDate !== undefined) update.expectedCloseDate = data.expectedCloseDate;
    if (data.companyName !== undefined) update.companyName = data.companyName;

    // A rename is a re-claim: the building this lead occupies changes, so the new key has to be
    // free. `exceptLeadId` is this lead, so re-saving a record without really changing its
    // building (different spelling, same normalized key) never reports the lead against itself.
    if (renamed && nextKey && nextKey !== found.buildingKey) {
      await assertBuildingUnclaimed(tx, {
        companyId: found.companyId, key: nextKey, user,
        name: data.companyName, exceptLeadId: id,
      });
      update.buildingKey = nextKey;
    }

    if (wantsReassign) {
      // The TEAM FOLLOWS THE OWNER. scope.ts returns the pair precisely so they cannot drift:
      // a COMPANY_ADMIN is confined to its own team, a SUPER_ADMIN may name any team's member,
      // and that is what makes the cross-team transfer below reachable only by a super admin.
      // When the super admin names ITSELF the pair is (self, the named team) and the team
      // defaults to the lead's current one, so no transfer happens unless one was asked for.
      const assigned = await resolveLeadOwner(tx, user, data.ownerId, data.teamId ?? found.teamId);
      update.ownerId = assigned.ownerId;
      if (assigned.teamId !== found.teamId) {
        await transferTeam(tx, found, assigned.teamId, assigned.ownerId, user, update);
      } else {
        // SAME-TEAM reassignment changes who can see the lead just as a transfer does: the old
        // owner no longer can, so their open assigned tasks must not linger in My Work.
        await clearUnseeableAssignees(tx, found, assigned.teamId, assigned.ownerId);
      }
    }

    return tx.lead.update({ where: { id }, data: update });
  });
}

// Move a lead into another team, in the caller's transaction. Only a SUPER_ADMIN can get here:
// resolveAssignableOwner refuses a COMPANY_ADMIN an owner outside its own team.
//
// Mutates `update` rather than returning fields, so the single lead.update at the call site
// stays the only write to the row.
async function transferTeam(
  tx: Tx, lead: Lead, toTeamId: string, toOwnerId: string, user: SessionUser,
  update: Prisma.LeadUncheckedUpdateInput,
): Promise<void> {
  const toTeam = await tx.team.findUnique({ where: { id: toTeamId }, select: { name: true, companyId: true } });
  if (!toTeam) throw new NotFoundError("target team not found");
  // Lead.companyId never changes, so a team in another company would leave the row pointing at
  // a team outside its own tenant — and the building claim (unique per COMPANY) would be
  // enforced against the wrong company from then on.
  if (toTeam.companyId !== lead.companyId) throw new ForbiddenError("cannot move a lead to another company");

  const { stageId, fromName, toName } = await remapStage(tx, lead, toTeamId);
  update.teamId = toTeamId;
  update.stageId = stageId;

  // One STAGE_CHANGE, because from the pipeline's point of view that is what happened: the lead
  // is in a differently-named column now. Without it the stage silently changes under the lead's
  // history and nobody can tell why.
  await tx.activity.create({
    data: {
      companyId: lead.companyId, leadId: lead.id, authorId: user.id, kind: "STAGE_CHANGE",
      body: `Transferred to ${toTeam.name}; stage ${fromName} → ${toName}`,
    },
  });

  await clearUnseeableAssignees(tx, lead, toTeamId, toOwnerId);
}

// Stages are per team, so the lead's old stageId is meaningless in the target team.
async function remapStage(
  tx: Tx, lead: Lead, toTeamId: string,
): Promise<{ stageId: string; fromName: string; toName: string }> {
  const from: Stage | null = await tx.stage.findUnique({ where: { id: lead.stageId } });
  if (!from) throw new NotFoundError("current stage not found");

  // SAME NAME **WITHIN THE SAME TYPE**, then the first stage of that type by order.
  //
  // Matching on name alone is not safe: the target team is free to have an OPEN stage called
  // "Won", and landing a won lead there would take it out of WON while `wonAt` stayed set — a
  // lead that is won by one metric and open by another, and every won-count shifts. The TYPE is
  // the invariant a transfer must preserve; the name is only the preference within it.
  const byName = await tx.stage.findFirst({
    where: {
      companyId: lead.companyId, teamId: toTeamId, type: from.type,
      name: { equals: from.name, mode: "insensitive" },
    },
    orderBy: { order: "asc" },
  });
  const to = byName ?? await tx.stage.findFirst({
    where: { companyId: lead.companyId, teamId: toTeamId, type: from.type },
    orderBy: { order: "asc" },
  });
  // Fail rather than park the lead in a stage of another type: a target team with no WON stage
  // cannot hold a won lead, and the transfer is the wrong place to discover that silently.
  if (!to) throw new NotFoundError(`target team has no ${from.type} stage`);
  return { stageId: to.id, fromName: from.name, toName: to.name };
}

// After a transfer the lead is visible to its new owner and to the new team's admins — and to
// nobody else, by the rules in scope.ts. An OPEN task still assigned to someone outside that
// set is work nobody can open, so the assignment is dropped (the task itself survives, now
// unassigned, for the new team to pick up). DONE tasks keep their assignee: that is history.
async function clearUnseeableAssignees(tx: Tx, lead: Lead, toTeamId: string, toOwnerId: string): Promise<void> {
  const admins = await tx.user.findMany({
    where: { companyId: lead.companyId, teamId: toTeamId, role: "COMPANY_ADMIN", status: "ACTIVE" },
    select: { id: true },
  });
  const allowed = [toOwnerId, ...admins.map((a) => a.id)];
  await tx.task.updateMany({
    where: { leadId: lead.id, done: false, assigneeId: { not: null, notIn: allowed } },
    data: { assigneeId: null },
  });
}

export async function deleteLead(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  const found = await getLead(db, user, id);
  if (!found) throw new NotFoundError("lead not in scope");
  // found.companyId, not user.companyId: the row is the authority on which tenant's upload
  // directory holds its files, and a SUPER_ADMIN has no companyId at all.
  await removeLeadDir(found.companyId, id);
  await db.lead.delete({ where: { id } });
}

// WHY A REASON. The auto-convert is swallowed on failure (the stage move is the user's action
// and must stand on its own), and "Won, but no account" has two completely different cures:
//
//   "building_claimed"  another team already holds this building. Nobody's bug; the person needs
//                       to be told WHO holds it and to ask for a reassignment.
//   "error"             a real failure. Retry, or escalate.
//
// Without it the client could only say "the conversion didn't happen" and leave the user to guess.
export type MoveLeadStageReason = "building_claimed" | "error";
export type MoveLeadStageResult = { lead: Lead; autoConverted: boolean; reason?: MoveLeadStageReason };

export async function moveLeadStage(
  db: PrismaClient, user: SessionUser, leadId: string, toStageId: string, lostReason?: string,
): Promise<MoveLeadStageResult> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  // `teamId` in both WHEREs: stages belong to a team now, so a stage id from a sibling team (or
  // an org-template row) is not a stage this lead can be in, even inside the same company.
  const from = await db.stage.findFirst({
    where: { id: lead.stageId, companyId: lead.companyId, teamId: lead.teamId },
  });
  const to = await db.stage.findFirst({
    where: { id: toStageId, companyId: lead.companyId, teamId: lead.teamId },
  });
  if (!to) throw new NotFoundError("target stage not in this team");

  const enteringWon = to.type === "WON";
  const [updated] = await db.$transaction([
    db.lead.update({
      where: { id: leadId },
      data: {
        stageId: toStageId,
        lostReason: to.type === "LOST" ? (lostReason ?? null) : null,
        // Stamped on ENTERING a WON stage and nulled on LEAVING one, so "won in this period"
        // is a fact about the transition rather than about the last time anyone edited the row.
        // A WON -> WON move (a team with two won stages) keeps the original timestamp:
        // `undefined` means "leave this column alone", where null would erase the win date.
        wonAt: enteringWon ? (from?.type === "WON" ? undefined : new Date()) : null,
      },
    }),
    db.activity.create({
      data: {
        companyId: lead.companyId, leadId, authorId: user.id, kind: "STAGE_CHANGE",
        body: `Moved from ${from?.name ?? "?"} to ${to.name}`,
      },
    }),
  ]);

  // Landing in Won auto-creates the account, so nobody has to remember the button. Deliberately
  // AFTER the transaction commits: the stage move is the user's action and must stand on its own,
  // so a conversion failure is reported and swallowed rather than left as a stuck lead. The lead
  // stays in Won either way. convertLeadToAccount is idempotent, so moving out of Won and back
  // in — or double-clicking — reuses the existing account instead of creating a second one.
  let autoConverted = false;
  let reason: MoveLeadStageReason | undefined;
  if (enteringWon) {
    try {
      await convertLeadToAccount(db, user, leadId);
      autoConverted = true;
    } catch (e) {
      reason = e instanceof BuildingClaimedError ? "building_claimed" : "error";
      console.error("[moveLeadStage] auto-convert to account failed", {
        leadId, reason, message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return reason ? { lead: updated, autoConverted, reason } : { lead: updated, autoConverted };
}
