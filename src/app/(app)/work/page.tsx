import { redirect } from "next/navigation";
import Link from "next/link";
import { ListTodo, CalendarCheck, MessageSquare, Calendar as CalendarIcon, CheckCircle2 } from "lucide-react";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { getMyWork } from "@/lib/tenant/work";
import { listLeads } from "@/lib/tenant/leads";
import { listAccounts } from "@/lib/tenant/accounts";
import { listUsers } from "@/lib/tenant/users";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { AddTask } from "./AddTask";

function isOverdue(dueDate: Date | null) {
  if (!dueDate) return false;
  return dueDate < new Date();
}

function parentHref(parentType: "LEAD" | "ACCOUNT", parentId: string) {
  return parentType === "LEAD" ? `/crm/${parentId}` : `/accounts/${parentId}`;
}

export default async function WorkPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const ctx = getTenantContext(user);
  const [{ tasks, meetings }, leads, accounts, members] = await Promise.all([
    getMyWork(prisma, user),
    listLeads(prisma, user),
    listAccounts(prisma, user),
    listUsers(prisma, ctx),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="My Work"
        subtitle="Open tasks and recent meetings across your leads and accounts"
        action={
          <AddTask
            leads={leads.map((l) => ({ id: l.id, title: l.title }))}
            accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
            members={members.map((m) => ({ id: m.id, name: m.name, email: m.email }))}
          />
        }
      />

      {/* Tasks */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <ListTodo className="size-4 text-muted-foreground" />
            <CardTitle className="text-base font-semibold">Tasks</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <CheckCircle2 className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No open tasks</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableHead className="font-semibold text-foreground">Task</TableHead>
                    <TableHead className="font-semibold text-foreground">Related to</TableHead>
                    <TableHead className="font-semibold text-foreground">Due date</TableHead>
                    <TableHead className="font-semibold text-foreground">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tasks.map((t) => {
                    const overdue = isOverdue(t.dueDate);
                    return (
                      <TableRow key={`${t.parentType}-${t.id}`} className="hover:bg-muted/40 transition-colors duration-150">
                        <TableCell className="font-medium text-foreground">{t.title}</TableCell>
                        <TableCell>
                          <Link
                            href={parentHref(t.parentType, t.parentId)}
                            className="text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                          >
                            {t.parentTitle}
                          </Link>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {t.dueDate ? new Date(t.dueDate).toLocaleDateString() : "—"}
                        </TableCell>
                        <TableCell>
                          {overdue && (
                            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50 dark:text-amber-400 dark:border-amber-700 dark:bg-amber-950 font-medium text-xs">
                              Overdue
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recent meetings */}
      <Card>
        <CardHeader className="border-b border-border pb-4">
          <div className="flex items-center gap-2">
            <CalendarCheck className="size-4 text-muted-foreground" />
            <CardTitle className="text-base font-semibold">Recent Meetings</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          {meetings.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
              <MessageSquare className="size-8 mb-2 opacity-40" />
              <p className="text-sm">No meetings yet</p>
            </div>
          ) : (
            <ul className="space-y-3">
              {meetings.map((m) => (
                <li key={`${m.parentType}-${m.id}`} className="flex gap-3 text-sm">
                  <div className="mt-0.5 flex-none flex items-center justify-center size-6 rounded-full bg-muted">
                    <CalendarIcon className="size-3.5 text-violet-600 dark:text-violet-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground mb-0.5">
                      <span>{new Date(m.occurredAt).toLocaleDateString()}</span>
                      <span>·</span>
                      <Link
                        href={parentHref(m.parentType, m.parentId)}
                        className="font-medium text-sky-700 dark:text-sky-400 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                      >
                        {m.parentTitle}
                      </Link>
                    </div>
                    <p className="text-foreground">{m.body}</p>
                    {m.outcome && <p className="text-muted-foreground italic text-xs mt-0.5">Outcome: {m.outcome}</p>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
