import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listAllAccountsForPartnerAssignment } from "@/lib/platform/account-partners";
import { listPartnerAllowlist } from "@/lib/platform/partner-allowlist";
import { PageHeader } from "@/components/PageHeader";
import { PartnerAssign } from "./PartnerAssign";
import { PartnerAllowlistManager } from "./PartnerAllowlistManager";

// The one place partner links are governed. Company-facing account forms show the link
// read-only, because the partner namespace is shared across every tenant — see
// src/lib/platform/account-partners.ts.
//
// Two cards, two different powers:
//  - Allowlist: which company MAY auto-link to which complex. Without a grant, an account named
//    after a complex links to nothing, so a tenant can no longer claim another tenant's complex
//    by naming an account after it.
//  - Partner link: the direct assignment. Still a SUPER_ADMIN call, still validated against the
//    live upstream list, and now also refused when it contradicts a grant to another company.
//
// Both lib calls assert SUPER_ADMIN themselves; the redirect here (and the (platform) layout's)
// is just the UX half of that guard.
export default async function Page() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const [accounts, allowlist, companies] = await Promise.all([
    listAllAccountsForPartnerAssignment(prisma, user),
    listPartnerAllowlist(prisma, user),
    prisma.company.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner links"
        subtitle="Grant a complex to a company, then link it to one of that company's accounts"
      />
      <div className="flex flex-col lg:flex-row items-start gap-6">
        <PartnerAllowlistManager entries={allowlist} companies={companies} />
        <PartnerAssign accounts={accounts} />
      </div>
    </div>
  );
}
