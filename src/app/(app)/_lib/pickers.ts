import { prisma } from "@/db/client";
import type { SessionUser } from "@/lib/auth/guards";
import { listAssignableUsers } from "@/lib/tenant/users";
import { listTeams } from "@/lib/tenant/teams";
import { listStages, resolveStageScope, type StageScope } from "@/lib/tenant/stages";

// Server-side loaders shared by the CRM / Accounts / Work pages. They exist so every owner and
// assignee picker is fed by listAssignableUsers (never the old all-company user list) and so the
// SUPER_ADMIN's team-awareness lives in one place.

export type OwnerOption = { id: string; name: string; teamId: string | null; teamName: string | null };
export type TeamOption = { id: string; name: string };
export type StageOption = { id: string; name: string };

// The owner has no team of their own, so they pick one. Everyone else never sees a team list.
export async function loadTeams(user: SessionUser): Promise<TeamOption[]> {
  if (user.role !== "SUPER_ADMIN") return [];
  const teams = await listTeams(prisma, user);
  return teams.map((t) => ({ id: t.id, name: t.name }));
}

// Who the viewer may assign a record to, with team names attached for the SUPER_ADMIN's grouped
// picker. A MEMBER gets exactly themselves; a team admin gets their own team.
export async function loadOwnerOptions(user: SessionUser, teams: TeamOption[]): Promise<OwnerOption[]> {
  const users = await listAssignableUsers(prisma, user);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  return users.map((u) => ({
    id: u.id,
    name: u.name ?? u.email,
    teamId: u.teamId,
    teamName: u.teamId ? (teamName.get(u.teamId) ?? null) : null,
  }));
}

// The viewer's own team pipeline (admins and members). Not for the SUPER_ADMIN, who has no team.
export async function loadOwnStages(user: SessionUser): Promise<StageOption[]> {
  const scope = await resolveStageScope(prisma, user, {});
  return (await listStages(prisma, scope)).map((s) => ({ id: s.id, name: s.name }));
}

// Every team's pipeline, keyed by team id — what the SUPER_ADMIN's create form needs so the stage
// picker can follow the chosen owner's team.
export async function loadStagesByTeam(user: SessionUser, teams: TeamOption[]): Promise<Record<string, StageOption[]>> {
  const out: Record<string, StageOption[]> = {};
  for (const t of teams) {
    const scope = await resolveStageScope(prisma, user, { teamId: t.id });
    out[t.id] = (await listStages(prisma, scope)).map((s) => ({ id: s.id, name: s.name }));
  }
  return out;
}

export type TeamScopeChoice =
  | { kind: "team"; teamId: string }
  | { kind: "template" }
  | { kind: "none" };

// `?teamId=` handling for the SUPER_ADMIN's switcher. Absent -> the first team (a sane default for
// a board, and the server refuses an unnamed scope anyway); `template` -> the org template (only
// where `allowTemplate`); an id that is not a real team falls back to the first team rather than
// reaching the server with a made-up id.
export function chooseTeamScope(
  raw: string | undefined,
  teams: TeamOption[],
  allowTemplate: boolean,
): TeamScopeChoice {
  if (allowTemplate && raw === "template") return { kind: "template" };
  const hit = teams.find((t) => t.id === raw);
  if (hit) return { kind: "team", teamId: hit.id };
  if (teams[0]) return { kind: "team", teamId: teams[0].id };
  return allowTemplate ? { kind: "template" } : { kind: "none" };
}

// The StageScope to read for a choice. The SUPER_ADMIN resolves through resolveStageScope too, so
// the scope is validated by the same code the API routes use.
export async function stageScopeForChoice(user: SessionUser, choice: TeamScopeChoice): Promise<StageScope | null> {
  if (choice.kind === "none") return null;
  return resolveStageScope(prisma, user, { teamId: choice.kind === "template" ? null : choice.teamId });
}

// One call for a page that edits or shows ONE team's pipeline: a team admin/member always gets
// their own team; the SUPER_ADMIN gets whatever `?teamId=` names (see chooseTeamScope). `scope`
// is null only for an owner in an org with no teams yet.
export async function resolveViewScope(
  user: SessionUser,
  teams: TeamOption[],
  rawTeamId: string | undefined,
  allowTemplate: boolean,
): Promise<{ scope: StageScope | null; choice: TeamScopeChoice }> {
  if (user.role !== "SUPER_ADMIN") {
    return { scope: await resolveStageScope(prisma, user, {}), choice: { kind: "none" } };
  }
  const choice = chooseTeamScope(rawTeamId, teams, allowTemplate);
  return { scope: await stageScopeForChoice(user, choice), choice };
}
