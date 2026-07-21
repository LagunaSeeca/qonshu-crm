import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { getCompanyAnalytics } from "@/lib/tenant/company-analytics";
import { listAccounts } from "@/lib/tenant/accounts";
import { resolvePeriod } from "@/lib/reports/period";
import { AnalyticsView } from "./AnalyticsView";

export default async function AnalyticsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const period = resolvePeriod({ type: "MONTHLY" });
  const isPartner = user.role === "PARTNER_VIEWER";

  const [data, accounts] = await Promise.all([
    getCompanyAnalytics(prisma, user, { from: period.from, to: period.to }),
    // Partner logins are locked to their own account server-side already — the filter is
    // hidden for them, so there's no need to fetch the full partner list.
    isPartner ? Promise.resolve([]) : listAccounts(prisma, user),
  ]);

  return (
    <AnalyticsView
      initialData={data}
      initialPeriod="MONTHLY"
      accounts={isPartner ? [] : accounts.map((a) => ({ id: a.id, name: a.name }))}
      showCompanyFilter={!isPartner}
      isPartner={isPartner}
    />
  );
}
