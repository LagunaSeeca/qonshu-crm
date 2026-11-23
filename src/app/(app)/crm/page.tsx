import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { listStages } from "@/lib/tenant/stages";
import { listLeadCards } from "@/lib/tenant/leads";
import { PageHeader } from "@/components/PageHeader";
import { TeamSwitcher } from "@/components/TeamSwitcher";
import { Board } from "./Board";
import { loadTeams, resolveViewScope } from "../_lib/pickers";

export default async function CrmBoardPage({ searchParams }: { searchParams: Promise<{ teamId?: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  const sp = await searchParams;

  // The owner has no team of their own: the board shows ONE team's pipeline at a time, picked by
  // `?teamId=`. Everyone else always gets their own team's pipeline.
  const isSuper = user.role === "SUPER_ADMIN";
  const teams = await loadTeams(user);
  const { scope, choice } = await resolveViewScope(user, teams, sp.teamId, false);
  const stages = scope ? await listStages(prisma, scope) : [];
  const stageIds = new Set(stages.map((s) => s.id));
  const allLeads = await listLeadCards(prisma, user);
  // listLeadCards for the owner spans every team; keep only the chosen team's pipeline.
  const leads = isSuper ? allLeads.filter((l) => stageIds.has(l.stageId)) : allLeads;
  const teamId = choice.kind === "team" ? choice.teamId : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sales CRM"
        subtitle="Manage your pipeline"
        action={isSuper && teamId ? <TeamSwitcher teams={teams} value={teamId} /> : undefined}
      />
      <Board
        stages={stages.map((s) => ({ id: s.id, name: s.name, probability: s.probability, type: s.type }))}
        leads={leads}
        isAdmin={isAdmin(user)}
        stagesHref={teamId ? `/crm/stages?teamId=${encodeURIComponent(teamId)}` : "/crm/stages"}
      />
    </div>
  );
}
