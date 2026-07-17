import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { getLead } from "@/lib/tenant/leads";
import { listStages } from "@/lib/tenant/stages";
import { listActivities } from "@/lib/tenant/activities";
import { listTasks } from "@/lib/tenant/tasks";
import { listAttachments } from "@/lib/tenant/attachments";
import { listUsers } from "@/lib/tenant/users";
import { LeadDetail } from "./LeadDetail";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const ctx = getTenantContext(user);

  const lead = await getLead(prisma, user, id);
  if (!lead) notFound();

  const [stages, activities, tasks, attachments, members] = await Promise.all([
    listStages(prisma, ctx),
    listActivities(prisma, user, id),
    listTasks(prisma, user, id),
    listAttachments(prisma, user, id),
    listUsers(prisma, ctx),
  ]);

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
      members={members.map((m) => ({ id: m.id, name: m.name }))}
    />
  );
}
