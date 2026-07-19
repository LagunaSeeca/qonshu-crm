import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getDashboardStats } from "@/lib/tenant/dashboard";
import { resolvePeriod } from "@/lib/reports/period";
import { PageHeader } from "@/components/PageHeader";
import { DashboardView } from "./DashboardView";

export default async function Dashboard() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const period = resolvePeriod({ type: "MONTHLY" });
  const stats = await getDashboardStats(prisma, user, { from: period.from, to: period.to });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        subtitle="Overview of your sales pipeline, activity, partners and finances"
      />

      <DashboardView initialStats={stats} initialPeriod="MONTHLY" />
    </div>
  );
}
