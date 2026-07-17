import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listCompanyServiceFees } from "@/lib/tenant/service-fees";
import { ServiceFeesView } from "./ServiceFeesView";

export default async function ServiceFeesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const data = await listCompanyServiceFees(prisma, user);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Service fees</h1>
        <p className="text-sm text-muted-foreground mt-1">
          What accounts pay us monthly for using our app — separate from resident payments and settlements
        </p>
      </div>

      <ServiceFeesView initialData={data} />
    </div>
  );
}
