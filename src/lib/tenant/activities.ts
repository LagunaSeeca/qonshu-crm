import type { PrismaClient, Activity, ActivityKind } from "@prisma/client";
import { NotFoundError, type SessionUser } from "@/lib/auth/guards";
import { getLead } from "./leads";

// companyId is taken from the LEAD, not from `user.companyId!`. The lead is the row whose tenant
// these children belong to, and getLead has already proved it is in the caller's scope — whereas
// a SUPER_ADMIN's companyId is null, which the old non-null assertion papered over.
export async function addActivity(
  db: PrismaClient, user: SessionUser, leadId: string,
  args: { kind: ActivityKind; body: string; outcome?: string; occurredAt?: Date },
): Promise<Activity> {
  if (args.kind === "STAGE_CHANGE") throw new Error("STAGE_CHANGE is system-generated");
  const lead = await getLead(db, user, leadId);
  if (!lead) throw new NotFoundError("lead not in scope");
  return db.activity.create({
    data: {
      companyId: lead.companyId, leadId, authorId: user.id, kind: args.kind,
      body: args.body, outcome: args.outcome, occurredAt: args.occurredAt ?? new Date(),
    },
  });
}

export async function listActivities(db: PrismaClient, user: SessionUser, leadId: string): Promise<Activity[]> {
  const lead = await getLead(db, user, leadId);
  if (!lead) return [];
  return db.activity.findMany({ where: { companyId: lead.companyId, leadId }, orderBy: { occurredAt: "desc" } });
}
