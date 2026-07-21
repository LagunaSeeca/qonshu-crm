import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listCompanyServiceFees } from "@/lib/tenant/service-fees";
import { PageHeader } from "@/components/PageHeader";
import { ServiceFeesView } from "./ServiceFeesView";

export default async function ServiceFeesPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const data = await listCompanyServiceFees(prisma, user);
  const isPartner = user.role === "PARTNER_VIEWER";

  return (
    <div className="space-y-6">
      <PageHeader
        title="Service fees"
        subtitle="What accounts pay us monthly for using our app — separate from resident payments and settlements"
      />

      <ServiceFeesView initialData={data} isPartner={isPartner} />
    </div>
  );
}
