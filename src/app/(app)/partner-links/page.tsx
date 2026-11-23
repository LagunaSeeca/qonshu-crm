import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listAllAccountsForPartnerAssignment } from "@/lib/platform/account-partners";
import { listPendingPartnerLinks } from "@/lib/tenant/partner-link-approval";
import { PageHeader } from "@/components/PageHeader";
import { PartnerAssign } from "./PartnerAssign";
import { PendingLinks } from "./PendingLinks";

// The one place partner links are governed. Account forms show the link read-only, because the
// partner namespace is global — see src/lib/platform/account-partners.ts.
//
// TWO CARDS WITH TWO DIFFERENT AUDIENCES, and that split is the security boundary, not a layout
// choice:
//
//   * CONFIRMATION QUEUE — a TEAM ADMIN and the owner. Links staked by a salesperson naming a
//     building grant nothing until confirmed here (security review finding F1). A team admin sees
//     only their own team's queue; the scoping is done by listPendingPartnerLinks, never by
//     filtering in the component. Each decision re-checks the one proposed name against the live
//     upstream list server-side, so an admin never needs the complex list to approve.
//
//   * DIRECT ASSIGN — the SUPER_ADMIN alone. It is driven by GET /api/partners, which names
//     complexes belonging to every team and is therefore owner-only; handing it to a team admin
//     would reintroduce exactly the cross-team enumeration the gate exists to close. So a team
//     admin does not get this card at all.
//
// A MEMBER has no business here: listPendingPartnerLinks refuses them outright, and the redirect
// below is the UX half of that guard.
export default async function PartnerLinksPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const isOwner = user.role === "SUPER_ADMIN";
  if (!isOwner && user.role !== "COMPANY_ADMIN") redirect("/dashboard");

  const [pending, accounts] = await Promise.all([
    listPendingPartnerLinks(prisma, user),
    isOwner ? listAllAccountsForPartnerAssignment(prisma, user) : Promise.resolve(null),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Partner links"
        subtitle={
          isOwner
            ? "Confirm which external complexes Qonshu may read, and link them to the accounts that work them"
            : "Confirm which external complexes your team may read"
        }
      />
      <div className="flex flex-col lg:flex-row items-start gap-6">
        <PendingLinks
          showTeam={isOwner}
          links={pending.map((p) => ({
            accountId: p.accountId,
            accountName: p.accountName,
            companyName: p.companyName,
            teamName: p.teamName,
            partnerName: p.partnerName,
            requestedBy: p.requestedBy,
            proposedByMe: p.proposedByMe,
            // Serialized for the client boundary: a Date crosses it as a string anyway, so say so
            // in the type rather than letting the component receive something its props deny.
            requestedAt: p.requestedAt?.toISOString() ?? null,
          }))}
        />
        {accounts && <PartnerAssign accounts={accounts} />}
      </div>
    </div>
  );
}
