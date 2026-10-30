import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { listStages } from "@/lib/tenant/stages";
import { TeamSwitcher, TEMPLATE_VALUE } from "@/components/TeamSwitcher";
import { StageSettings } from "./StageSettings";
import { loadTeams, resolveViewScope } from "../../_lib/pickers";

// Admins edit their OWN team's stages. The owner can pick any team, plus the "Default template"
// that new teams are seeded from — editing the template never touches existing teams.
export default async function StageSettingsPage({ searchParams }: { searchParams: Promise<{ teamId?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isAdmin(user)) redirect("/crm");
  const sp = await searchParams;

  const isSuper = user.role === "SUPER_ADMIN";
  const teams = await loadTeams(user);
  const { scope, choice } = await resolveViewScope(user, teams, sp.teamId, true);
  const stages = scope ? await listStages(prisma, scope) : [];

  const isTemplate = choice.kind === "template";
  // Present-but-empty `?teamId=` is how the stages API says "the org template".
  const scopeQuery = !isSuper ? "" : isTemplate ? "?teamId=" : choice.kind === "team" ? `?teamId=${encodeURIComponent(choice.teamId)}` : "";
  const switcherValue = isTemplate ? TEMPLATE_VALUE : choice.kind === "team" ? choice.teamId : "";

  return (
    <StageSettings
      key={scopeQuery}
      initialStages={stages.map((s) => ({
        id: s.id,
        name: s.name,
        type: s.type as "OPEN" | "WON" | "LOST",
        probability: s.probability,
        order: s.order,
      }))}
      scopeQuery={scopeQuery}
      isTemplate={isTemplate}
      switcher={isSuper ? <TeamSwitcher teams={teams} value={switcherValue} includeTemplate /> : undefined}
    />
  );
}
