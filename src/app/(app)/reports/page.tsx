import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listAccounts } from "@/lib/tenant/accounts";
import { getReport } from "@/lib/tenant/reports";
import { resolvePeriod } from "@/lib/reports/period";
import { PageHeader } from "@/components/PageHeader";
import { ReportView } from "./ReportView";

export default async function ReportsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const period = resolvePeriod({ type: "MONTHLY" });

  const [accounts, report] = await Promise.all([
    listAccounts(prisma, user),
    getReport(prisma, user, { range: { from: period.from, to: period.to }, label: period.label }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        subtitle="Company-wide or per-partner performance, with CSV export"
      />

      <ReportView
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        initialReport={report}
      />
    </div>
  );
}
