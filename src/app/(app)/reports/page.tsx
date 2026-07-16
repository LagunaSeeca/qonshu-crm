import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listAccounts } from "@/lib/tenant/accounts";
import { getReport } from "@/lib/tenant/reports";
import { resolvePeriod } from "@/lib/reports/period";
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
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Company-wide or per-partner performance, with CSV export
        </p>
      </div>

      <ReportView
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        initialReport={report}
      />
    </div>
  );
}
