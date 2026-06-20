import type { PrismaClient, Activity, ActivityKind } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { NotFoundError } from "@/lib/auth/guards";
import { getLead } from "./leads";

export async function addActivity(db: PrismaClient, user: SessionUser, leadId: string, args: { kind: ActivityKind; body: string; outcome?: string; occurredAt?: Date }): Promise<Activity> {
  if (args.kind === "STAGE_CHANGE") throw new Error("STAGE_CHANGE is system-generated");
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  return db.activity.create({ data: { companyId: user.companyId!, leadId, authorId: user.id, kind: args.kind, body: args.body, outcome: args.outcome, occurredAt: args.occurredAt ?? new Date() } });
}

export async function listActivities(db: PrismaClient, user: SessionUser, leadId: string): Promise<Activity[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.activity.findMany({ where: { companyId: user.companyId!, leadId }, orderBy: { occurredAt: "desc" } });
}
