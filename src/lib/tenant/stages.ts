import type { PrismaClient, Stage, StageType } from "@prisma/client";
import { ForbiddenError, NotFoundError, type SessionUser } from "@/lib/auth/guards";

export class StageHasLeadsError extends Error {}
export class LastStageError extends Error {}

// WHAT CHANGED: stages used to be company-wide — every function took `TenantContext`
// (`{ companyId }`), so every team in the company shared one pipeline. Stage.teamId now splits
// them, and this is the scope every function here is keyed on.
//
//   teamId: "<id>"  a TEAM'S OWN LIVE PIPELINE — the only rows a Lead may ever point at.
//   teamId: null    the ORG DEFAULT TEMPLATE a new team is seeded from. SUPER_ADMIN ONLY.
//
// `teamId` is REQUIRED rather than optional so a caller that forgets it is a compile error
// instead of silently resolving to `undefined` — which in a Prisma `where` means "no filter on
// this column", i.e. every team's stages plus the template. Null is the explicit "the template"
// value and is reachable only through resolveStageScope's SUPER_ADMIN branch.
export type StageScope = { companyId: string; teamId: string | null };

export const DEFAULT_STAGES: { name: string; type: StageType; probability: number }[] = [
  { name: "New", type: "OPEN", probability: 10 },
  { name: "Contacted", type: "OPEN", probability: 25 },
  { name: "Qualified", type: "OPEN", probability: 50 },
  { name: "Proposal", type: "OPEN", probability: 70 },
  { name: "Negotiation", type: "OPEN", probability: 90 },
  { name: "Won", type: "WON", probability: 100 },
  { name: "Lost", type: "LOST", probability: 0 },
];

// Seeds the company's ORG DEFAULT TEMPLATE (teamId null), not any team's pipeline. Signature
// unchanged so the two callers outside this slice — platform/companies.ts and prisma/seed.ts —
// keep working; what changed is that the rows it writes are template rows, and the idempotence
// check is scoped to the template so a company that already has team pipelines is not mistaken
// for one that is already seeded.
export async function seedDefaultStages(db: PrismaClient, companyId: string): Promise<void> {
  const existing = await db.stage.count({ where: { companyId, teamId: null } });
  if (existing > 0) return;
  await db.stage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({
      companyId, teamId: null, name: s.name, type: s.type, probability: s.probability, order: i,
    })),
  });
}

// Gives a team its own pipeline by copying the company's template (falling back to
// DEFAULT_STAGES when the company has none). A team with no stages cannot hold a lead at all —
// createLead requires a stage of the lead's own team — so whoever creates a Team must call this.
// Idempotent: a team that already has stages is left alone.
export async function seedTeamStages(db: PrismaClient, companyId: string, teamId: string): Promise<void> {
  const existing = await db.stage.count({ where: { companyId, teamId } });
  if (existing > 0) return;
  const template = await db.stage.findMany({ where: { companyId, teamId: null }, orderBy: { order: "asc" } });
  const source = template.length > 0
    ? template.map((s) => ({ name: s.name, type: s.type, probability: s.probability }))
    : DEFAULT_STAGES;
  await db.stage.createMany({
    data: source.map((s, i) => ({
      companyId, teamId, name: s.name, type: s.type, probability: s.probability, order: i,
    })),
  });
}

// What the caller asked to act on. `teamId` is a THREE-state field on purpose:
//   undefined  not named at all
//   null       the org default template
//   "<id>"     that team
// so `?teamId=` (named, empty) can mean the template without colliding with "not named".
export type StageScopeRequest = { teamId?: string | null; companyId?: string };

// The ONLY way to obtain a StageScope. Fails closed at every branch: a role this does not know,
// a team admin reaching for another team, or a super admin that named nothing all raise rather
// than fall through to a broader filter.
export async function resolveStageScope(
  db: Pick<PrismaClient, "team">,
  user: SessionUser,
  requested: StageScopeRequest = {},
): Promise<StageScope> {
  if (user.role === "PARTNER_VIEWER") throw new ForbiddenError("partners cannot access the CRM");

  if (user.role === "SUPER_ADMIN") {
    // REQUIRED, not defaulted: a super admin has no company and no team of its own, so there is
    // no scope to fall back to — and a silent fallback would edit whichever team a later line
    // happened to pick. Same rule as resolveAssignableOwner in scope.ts.
    if (requested.teamId === undefined) {
      throw new ForbiddenError("a super admin must name the team (or ?teamId= for the org template)");
    }
    if (requested.teamId === null) {
      const companyId = requested.companyId ?? user.companyId;
      if (!companyId) throw new ForbiddenError("a super admin must name the company for the stage template");
      return { companyId, teamId: null };
    }
    const team = await db.team.findUnique({
      where: { id: requested.teamId },
      select: { id: true, companyId: true },
    });
    if (!team) throw new NotFoundError("team not found");
    return { companyId: team.companyId, teamId: team.id };
  }

  if (user.role === "COMPANY_ADMIN" || user.role === "MEMBER") {
    if (!user.companyId) throw new ForbiddenError(`no company context for ${user.role}`);
    if (!user.teamId) throw new ForbiddenError(`${user.role} is not on a team`);
    // The template is what every future team is seeded from; letting one team's admin edit it
    // would silently reshape every team created after them.
    if (requested.teamId === null) throw new ForbiddenError("the org stage template is super-admin only");
    if (requested.teamId !== undefined && requested.teamId !== user.teamId) {
      throw new ForbiddenError("not your team");
    }
    return { companyId: user.companyId, teamId: user.teamId };
  }

  throw new ForbiddenError(`role ${user.role} has no stage scope`);
}

export function listStages(db: PrismaClient, scope: StageScope): Promise<Stage[]> {
  return db.stage.findMany({
    where: { companyId: scope.companyId, teamId: scope.teamId },
    orderBy: { order: "asc" },
  });
}

export async function createStage(
  db: PrismaClient, scope: StageScope, args: { name: string; type?: StageType; probability?: number },
): Promise<Stage> {
  const max = await db.stage.aggregate({
    where: { companyId: scope.companyId, teamId: scope.teamId },
    _max: { order: true },
  });
  return db.stage.create({
    data: {
      companyId: scope.companyId, teamId: scope.teamId, name: args.name,
      type: args.type ?? "OPEN", probability: args.probability ?? 0, order: (max._max.order ?? -1) + 1,
    },
  });
}

export async function updateStage(
  db: PrismaClient, scope: StageScope, id: string,
  data: { name?: string; type?: StageType; probability?: number },
): Promise<Stage> {
  const found = await findInScope(db, scope, id);
  if (!found) throw new NotFoundError("stage not in scope");
  return db.stage.update({ where: { id }, data });
}

export async function reorderStages(db: PrismaClient, scope: StageScope, orderedIds: string[]): Promise<void> {
  await db.$transaction(
    // updateMany, not update: the scope is part of the WHERE, so an id from another team (or
    // from the template) matches nothing instead of being reordered.
    orderedIds.map((id, i) =>
      db.stage.updateMany({ where: { id, companyId: scope.companyId, teamId: scope.teamId }, data: { order: i } }),
    ),
  );
}

export async function deleteStage(db: PrismaClient, scope: StageScope, id: string): Promise<void> {
  const found = await findInScope(db, scope, id);
  if (!found) throw new NotFoundError("stage not in scope");
  const count = await db.lead.count({ where: { companyId: scope.companyId, stageId: id } });
  if (count > 0) throw new StageHasLeadsError("stage has leads");
  // COUNTED PER TEAM, not per company. Company-wide this guard was wrong in both directions: a
  // team could delete its only WON stage as long as a sibling team still had one (leaving a
  // pipeline that can never be won, and moveLeadStage with nowhere to land), while a team with
  // two WON stages of its own could be blocked by a sibling team having none.
  const remaining = await db.stage.count({
    where: { companyId: scope.companyId, teamId: scope.teamId, type: found.type, id: { not: id } },
  });
  if (remaining < 1) throw new LastStageError(`cannot delete the last ${found.type} stage`);
  await db.stage.delete({ where: { id } });
}

function findInScope(db: PrismaClient, scope: StageScope, id: string): Promise<Stage | null> {
  return db.stage.findFirst({ where: { id, companyId: scope.companyId, teamId: scope.teamId } });
}
