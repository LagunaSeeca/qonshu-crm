import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { isAdmin } from "@/lib/auth/guards";
import { getAccount, listPartnerLogins } from "@/lib/tenant/accounts";
import { listAccountActivities } from "@/lib/tenant/account-activities";
import { listAccountTasks } from "@/lib/tenant/account-tasks";
import { listAsks } from "@/lib/tenant/account-asks";
import { listAccountAttachments } from "@/lib/tenant/account-attachments";
import { loadOwnerOptions, loadTeams } from "../../_lib/pickers";
import { AccountDetail } from "./AccountDetail";

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;

  const account = await getAccount(prisma, user, id);
  if (!account) notFound();

  const admin = isAdmin(user);
  const teams = await loadTeams(user);
  const [activities, tasks, asks, attachments, owners, partnerLogins] = await Promise.all([
    listAccountActivities(prisma, user, id),
    listAccountTasks(prisma, user, id),
    listAsks(prisma, user, id),
    listAccountAttachments(prisma, user, id),
    // Only an admin can reassign, so only an admin needs the picker list.
    admin ? loadOwnerOptions(user, teams) : Promise.resolve([]),
    listPartnerLogins(prisma, user, id),
  ]);
  // The manager (and activity authors) can be someone the viewer cannot assign to — a deactivated
  // user, say — so names are looked up directly rather than taken from the picker list.
  const nameIds = [...new Set([account.accountManagerId, ...activities.map((a) => a.authorId)].filter((x): x is string => !!x))];
  const people = nameIds.length
    ? await prisma.user.findMany({ where: { id: { in: nameIds } }, select: { id: true, name: true, email: true } })
    : [];

  return (
    <AccountDetail
      account={{
        id: account.id,
        name: account.name,
        status: account.status,
        website: account.website ?? null,
        industry: account.industry ?? null,
        accountManagerId: account.accountManagerId ?? null,
        primaryContactName: account.primaryContactName ?? null,
        primaryContactEmail: account.primaryContactEmail ?? null,
        primaryContactPhone: account.primaryContactPhone ?? null,
        externalPartnerKey: account.externalPartnerKey ?? null,
      }}
      members={people.map((m) => ({ id: m.id, name: m.name ?? m.email }))}
      owners={owners}
      groupOwners={user.role === "SUPER_ADMIN"}
      partnerLogins={partnerLogins}
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
      asks={asks.map((k) => ({
        id: k.id,
        title: k.title,
        detail: k.detail ?? null,
        status: k.status,
        createdAt: k.createdAt.toISOString(),
        resolvedAt: k.resolvedAt ? k.resolvedAt.toISOString() : null,
      }))}
      attachments={attachments.map((att) => ({
        id: att.id,
        filename: att.filename,
        size: att.size,
        mime: att.mime,
      }))}
      isAdmin={admin}
    />
  );
}
