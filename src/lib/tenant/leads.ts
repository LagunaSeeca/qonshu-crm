import type { PrismaClient, Lead, Priority, Prisma } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { leadVisibilityWhere } from "./visibility";
import { removeLeadDir } from "@/lib/files/storage";

async function shareFlag(db: PrismaClient, companyId: string): Promise<boolean> {
  const c = await db.company.findUnique({ where: { id: companyId } });
  return c?.shareAllLeads ?? true;
}
async function scopeWhere(db: PrismaClient, user: SessionUser) {
  return leadVisibilityWhere(user, await shareFlag(db, user.companyId!));
}

export async function createLead(db: PrismaClient, user: SessionUser, data: {
  title: string; contactName: string; stageId: string; email?: string; phone?: string;
  companyName?: string; source?: string; value?: number | string; priority?: Priority;
  ownerId?: string; expectedCloseDate?: Date | null;
}): Promise<Lead> {
  const stage = await db.stage.findFirst({ where: { id: data.stageId, companyId: user.companyId! } });
  if (!stage) throw new NotFoundError("stage not in tenant");
  if (data.ownerId !== undefined) {
    const o = await db.user.findFirst({ where: { id: data.ownerId, companyId: user.companyId! } });
    if (!o) throw new NotFoundError("owner not in tenant");
  }
  return db.lead.create({ data: {
    companyId: user.companyId!, title: data.title, contactName: data.contactName, stageId: data.stageId,
    email: data.email, phone: data.phone, companyName: data.companyName, source: data.source,
    value: data.value ?? 0, priority: data.priority ?? "MEDIUM", ownerId: data.ownerId ?? user.id,
    expectedCloseDate: data.expectedCloseDate ?? null,
  } });
}

export async function listLeads(db: PrismaClient, user: SessionUser, opts?: {
  stageId?: string; ownerId?: string; q?: string; sort?: "value" | "createdAt"; skip?: number; take?: number;
}): Promise<Lead[]> {
  const where: Prisma.LeadWhereInput = { ...(await scopeWhere(db, user)) };
  if (opts?.stageId) where.stageId = opts.stageId;
  if (opts?.ownerId) where.ownerId = opts.ownerId;
  if (opts?.q) where.OR = [
    { title: { contains: opts.q, mode: "insensitive" } },
    { contactName: { contains: opts.q, mode: "insensitive" } },
    { companyName: { contains: opts.q, mode: "insensitive" } },
  ];
  return db.lead.findMany({ where, orderBy: { [opts?.sort ?? "createdAt"]: "desc" }, skip: opts?.skip, take: opts?.take });
}

export async function getLead(db: PrismaClient, user: SessionUser, id: string): Promise<Lead | null> {
  return db.lead.findFirst({ where: { id, ...(await scopeWhere(db, user)) } });
}

export async function updateLead(db: PrismaClient, user: SessionUser, id: string, data: Partial<{
  title: string; contactName: string; email: string | null; phone: string | null; companyName: string | null;
  source: string | null; value: number | string; priority: Priority; ownerId: string; expectedCloseDate: Date | null;
}>): Promise<Lead> {
  const found = await getLead(db, user, id);
  if (!found) throw new NotFoundError("lead not in scope");
  if (data.ownerId !== undefined) {
    const o = await db.user.findFirst({ where: { id: data.ownerId, companyId: user.companyId! } });
    if (!o) throw new NotFoundError("owner not in tenant");
  }
  return db.lead.update({ where: { id }, data });
}

export async function deleteLead(db: PrismaClient, user: SessionUser, id: string): Promise<void> {
  const found = await getLead(db, user, id);
  if (!found) throw new NotFoundError("lead not in scope");
  await removeLeadDir(user.companyId!, id);
  await db.lead.delete({ where: { id } });
}

export async function moveLeadStage(db: PrismaClient, user: SessionUser, leadId: string, toStageId: string, lostReason?: string): Promise<Lead> {
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  const from = await db.stage.findFirst({ where: { id: lead.stageId, companyId: user.companyId! } });
  const to = await db.stage.findFirst({ where: { id: toStageId, companyId: user.companyId! } });
  if (!to) throw new NotFoundError("target stage not in tenant");
  const [updated] = await db.$transaction([
    db.lead.update({ where: { id: leadId }, data: { stageId: toStageId, lostReason: to.type === "LOST" ? (lostReason ?? null) : null } }),
    db.activity.create({ data: { companyId: user.companyId!, leadId, authorId: user.id, kind: "STAGE_CHANGE", body: `Moved from ${from?.name ?? "?"} to ${to.name}` } }),
  ]);
  return updated;
}
