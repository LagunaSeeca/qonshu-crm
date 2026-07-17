import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getCompanyAnalytics } from "@/lib/tenant/company-analytics";
import { resolvePeriod } from "@/lib/reports/period";
import { AnalyticsView } from "./AnalyticsView";

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const period = resolvePeriod({ type: "MONTHLY" });
  const data = await getCompanyAnalytics(prisma, user, { from: period.from, to: period.to });

  return <AnalyticsView initialData={data} initialPeriod="MONTHLY" />;
}
