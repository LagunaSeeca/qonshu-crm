import { redirect, notFound } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { getAccount } from "@/lib/tenant/accounts";
import { listAccountActivities } from "@/lib/tenant/account-activities";
import { listAccountTasks } from "@/lib/tenant/account-tasks";
import { listAsks } from "@/lib/tenant/account-asks";
import { listAccountAttachments } from "@/lib/tenant/account-attachments";
import { listUsers } from "@/lib/tenant/users";
import { AccountDetail } from "./AccountDetail";

export default async function AccountDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { id } = await params;
  const ctx = getTenantContext(user);

  const account = await getAccount(prisma, user, id);
  if (!account) notFound();

  const [activities, tasks, asks, attachments, members] = await Promise.all([
    listAccountActivities(prisma, user, id),
    listAccountTasks(prisma, user, id),
    listAsks(prisma, user, id),
    listAccountAttachments(prisma, user, id),
    listUsers(prisma, ctx),
  ]);

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
      members={members.map((m) => ({ id: m.id, name: m.name }))}
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
      isAdmin={user.role === "COMPANY_ADMIN"}
    />
  );
}
