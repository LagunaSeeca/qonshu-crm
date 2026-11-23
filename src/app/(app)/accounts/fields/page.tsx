import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { listFieldDefs, resolveFieldDefScope, type FieldDefScope } from "@/lib/tenant/account-fields";
import { TeamSwitcher, TEMPLATE_VALUE } from "@/components/TeamSwitcher";
import { FieldSettings } from "./FieldSettings";
import { chooseTeamScope, loadTeams } from "../../_lib/pickers";

// Admins edit their OWN team's custom fields. The owner can pick any team, plus the "Default
// template" that new teams are seeded from — editing the template never touches existing teams.
export default async function AccountFieldsPage({ searchParams }: { searchParams: Promise<{ teamId?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isAdmin(user)) redirect("/accounts");
  const sp = await searchParams;

  const isSuper = user.role === "SUPER_ADMIN";
  const teams = await loadTeams(user);
  const choice = isSuper ? chooseTeamScope(sp.teamId, teams, true) : ({ kind: "none" } as const);

  // Resolved through the same code the API routes use, so the page and the API agree on scope.
  let scope: FieldDefScope | null;
  if (!isSuper) scope = await resolveFieldDefScope(prisma, user, {});
  else if (choice.kind === "none") scope = null;
  else scope = await resolveFieldDefScope(prisma, user, { teamId: choice.kind === "template" ? null : choice.teamId });
  const defs = scope ? await listFieldDefs(prisma, user, scope) : [];

  const isTemplate = choice.kind === "template";
  // Present-but-empty `?teamId=` is how the API says "the org template".
  const scopeQuery = !isSuper ? "" : isTemplate ? "?teamId=" : choice.kind === "team" ? `?teamId=${encodeURIComponent(choice.teamId)}` : "";
  const switcherValue = isTemplate ? TEMPLATE_VALUE : choice.kind === "team" ? choice.teamId : "";

  return (
    <FieldSettings
      key={scopeQuery}
      initialDefs={defs.map((d) => ({
        id: d.id,
        label: d.label,
        type: d.type as "TEXT" | "NUMBER" | "CURRENCY" | "DATE",
        order: d.order,
      }))}
      scopeQuery={scopeQuery}
      isTemplate={isTemplate}
      switcher={isSuper ? <TeamSwitcher teams={teams} value={switcherValue} includeTemplate /> : undefined}
    />
  );
}
