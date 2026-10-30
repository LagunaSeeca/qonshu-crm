import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listAllAccountsForPartnerAssignment } from "@/lib/platform/account-partners";
import { PageHeader } from "@/components/PageHeader";
import { PartnerAssign } from "./PartnerAssign";

// The one place partner links are governed. Account forms show the link read-only, because the
// partner namespace is global — see src/lib/platform/account-partners.ts.
//
// SUPER_ADMIN only. listAllAccountsForPartnerAssignment asserts the role itself; the redirect
// here is just the UX half of that guard.
export default async function PartnerLinksPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const accounts = await listAllAccountsForPartnerAssignment(prisma, user);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner links"
        subtitle="Link an external complex to the account that works it"
      />
      <div className="flex flex-col lg:flex-row items-start gap-6">
        <PartnerAssign accounts={accounts} />
      </div>
    </div>
  );
}
