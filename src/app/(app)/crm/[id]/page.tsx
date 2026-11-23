import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { isAdmin } from "@/lib/auth/guards";
import { getLead } from "@/lib/tenant/leads";
import { listStages } from "@/lib/tenant/stages";
import { listActivities } from "@/lib/tenant/activities";
import { listTasks } from "@/lib/tenant/tasks";
import { listAttachments } from "@/lib/tenant/attachments";
import { loadOwnerOptions, loadTeams } from "../../_lib/pickers";
import { LeadDetail } from "./LeadDetail";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;

  const lead = await getLead(prisma, user, id);
  if (!lead) notFound();

  const admin = isAdmin(user);
  const teams = await loadTeams(user);
  const [stages, activities, tasks, attachments, owners] = await Promise.all([
    // The LEAD's own team pipeline: the only stages it may move between, and what makes the stage
    // picker correct for the owner (who has no team of their own).
    listStages(prisma, { companyId: lead.companyId, teamId: lead.teamId }),
    listActivities(prisma, user, id),
    listTasks(prisma, user, id),
    listAttachments(prisma, user, id),
    // Only an admin can reassign, so only an admin needs the picker list.
    admin ? loadOwnerOptions(user, teams) : Promise.resolve([]),
  ]);
  // Activity authors can be anyone who touched the lead (including people the viewer cannot assign
  // to), so their names are looked up directly rather than taken from the picker list.
  const authorIds = [...new Set(activities.map((a) => a.authorId).filter((x): x is string => !!x))];
  const authors = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, email: true } })
    : [];

  return (
    <LeadDetail
      lead={{
        id: lead.id,
        title: lead.title,
        contactName: lead.contactName,
        email: lead.email ?? null,
        phone: lead.phone ?? null,
        companyName: lead.companyName ?? null,
        priority: lead.priority,
        stageId: lead.stageId,
        lostReason: lead.lostReason ?? null,
        ownerId: lead.ownerId,
      }}
      stages={stages.map((s) => ({ id: s.id, name: s.name, type: s.type }))}
      activities={activities.map((a) => ({
        id: a.id,
        kind: a.kind,
        body: a.body,
        outcome: a.outcome ?? null,
        occurredAt: a.occurredAt.toISOString(),
        authorId: a.authorId ?? null,
      }))}
      tasks={tasks.map((t) => ({
        id: t.id,
        title: t.title,
        dueDate: t.dueDate ? t.dueDate.toISOString() : null,
        done: t.done,
      }))}
      attachments={attachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        size: att.size,
        mime: att.mime,
      }))}
      members={authors.map((m) => ({ id: m.id, name: m.name ?? m.email }))}
      owners={owners}
      isAdmin={admin}
      groupOwners={user.role === "SUPER_ADMIN"}
    />
  );
}
