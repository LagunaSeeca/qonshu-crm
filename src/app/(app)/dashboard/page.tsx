import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getDashboardStats } from "@/lib/tenant/dashboard";
import { resolvePeriod } from "@/lib/reports/period";
import { DashboardView } from "./DashboardView";

export default async function Dashboard() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const period = resolvePeriod({ type: "MONTHLY" });
  const stats = await getDashboardStats(prisma, user, { from: period.from, to: period.to });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Overview of your sales pipeline, activity, partners and finances
        </p>
      </div>

      <DashboardView initialStats={stats} initialPeriod="MONTHLY" />
    </div>
  );
}
