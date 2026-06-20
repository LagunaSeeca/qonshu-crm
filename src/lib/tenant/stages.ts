import type { PrismaClient, Stage, StageType } from "@prisma/client";
import type { TenantContext } from "./context";
import { NotFoundError } from "@/lib/auth/guards";

export class StageHasLeadsError extends Error {}
export class LastStageError extends Error {}

export const DEFAULT_STAGES: { name: string; type: StageType; probability: number }[] = [
  { name: "New", type: "OPEN", probability: 10 },
  { name: "Contacted", type: "OPEN", probability: 25 },
  { name: "Qualified", type: "OPEN", probability: 50 },
  { name: "Proposal", type: "OPEN", probability: 70 },
  { name: "Negotiation", type: "OPEN", probability: 90 },
  { name: "Won", type: "WON", probability: 100 },
  { name: "Lost", type: "LOST", probability: 0 },
];

export async function seedDefaultStages(db: PrismaClient, companyId: string): Promise<void> {
  const existing = await db.stage.count({ where: { companyId } });
  if (existing > 0) return;
  await db.stage.createMany({
    data: DEFAULT_STAGES.map((s, i) => ({ companyId, name: s.name, type: s.type, probability: s.probability, order: i })),
  });
}

export function listStages(db: PrismaClient, ctx: TenantContext): Promise<Stage[]> {
  return db.stage.findMany({ where: { companyId: ctx.companyId }, orderBy: { order: "asc" } });
}

export async function createStage(db: PrismaClient, ctx: TenantContext, args: { name: string; type?: StageType; probability?: number }): Promise<Stage> {
  const max = await db.stage.aggregate({ where: { companyId: ctx.companyId }, _max: { order: true } });
  return db.stage.create({ data: { companyId: ctx.companyId, name: args.name, type: args.type ?? "OPEN", probability: args.probability ?? 0, order: (max._max.order ?? -1) + 1 } });
}

export async function updateStage(db: PrismaClient, ctx: TenantContext, id: string, data: { name?: string; type?: StageType; probability?: number }): Promise<Stage> {
  const found = await db.stage.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!found) throw new NotFoundError("stage not in tenant");
  return db.stage.update({ where: { id }, data });
}

export async function reorderStages(db: PrismaClient, ctx: TenantContext, orderedIds: string[]): Promise<void> {
  await db.$transaction(
    orderedIds.map((id, i) => db.stage.updateMany({ where: { id, companyId: ctx.companyId }, data: { order: i } })),
  );
}

export async function deleteStage(db: PrismaClient, ctx: TenantContext, id: string): Promise<void> {
  const found = await db.stage.findFirst({ where: { id, companyId: ctx.companyId } });
  if (!found) throw new NotFoundError("stage not in tenant");
  const count = await db.lead.count({ where: { companyId: ctx.companyId, stageId: id } });
  if (count > 0) throw new StageHasLeadsError("stage has leads");
  const remaining = await db.stage.count({ where: { companyId: ctx.companyId, type: found.type, id: { not: id } } });
  if (remaining < 1) throw new LastStageError(`cannot delete the last ${found.type} stage`);
  await db.stage.delete({ where: { id } });
}
