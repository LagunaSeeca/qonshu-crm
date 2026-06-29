import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getTenantContext } from "@/lib/tenant/context";
import { listLeads } from "@/lib/tenant/leads";
import { listStages } from "@/lib/tenant/stages";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, TrendingUp, Trophy, CheckSquare } from "lucide-react";

export default async function Dashboard() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const ctx = getTenantContext(user);

  // Fetch real metrics
  const [leads, stages] = await Promise.all([
    listLeads(prisma, user),
    listStages(prisma, ctx),
  ]);

  const totalLeads = leads.length;

  // Pipeline value: sum of all lead values
  const pipelineValue = leads.reduce((sum, l) => sum + Number(l.value ?? 0), 0);

  // Leads won this month: leads in a WON-type stage, created this month
  const wonStageIds = new Set(stages.filter((s) => s.type === "WON").map((s) => s.id));
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const wonThisMonth = leads.filter(
    (l) => wonStageIds.has(l.stageId) && new Date(l.createdAt) >= startOfMonth
  ).length;

  // Open tasks: query directly (listTasks is per-lead; use raw count)
  const openTasksCount = await prisma.task.count({
    where: { companyId: user.companyId!, done: false },
  });

  const stats = [
    {
      label: "Total Leads",
      value: totalLeads.toLocaleString(),
      icon: Users,
      description: "Leads in pipeline",
    },
    {
      label: "Pipeline Value",
      value: `$${pipelineValue.toLocaleString("en-US", { minimumFractionDigits: 0 })}`,
      icon: TrendingUp,
      description: "Sum of all lead values",
    },
    {
      label: "Won This Month",
      value: wonThisMonth.toLocaleString(),
      icon: Trophy,
      description: "Leads closed won",
    },
    {
      label: "Open Tasks",
      value: openTasksCount.toLocaleString(),
      icon: CheckSquare,
      description: "Tasks not yet completed",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your sales pipeline
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.label} className="shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stat.label}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold tabular-nums">{stat.value}</div>
                <p className="text-xs text-muted-foreground mt-1">{stat.description}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Richer analytics with charts and trends arrive in a later milestone.
      </p>
    </div>
  );
}
