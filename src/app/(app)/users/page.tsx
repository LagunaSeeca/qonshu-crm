import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { isAdmin } from "@/lib/auth/guards";
import { prisma } from "@/db/client";
import { listUsers } from "@/lib/tenant/users";
import { listAccounts } from "@/lib/tenant/accounts";
import { UserAdmin } from "./UserAdmin";
import { loadTeams } from "../_lib/pickers";

export default async function UsersPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!isAdmin(user)) redirect("/dashboard");
  const teams = await loadTeams(user);
  // listUsers / listAccounts are already scoped: a team admin gets their own team's people and
  // accounts (so the partner-login picker can only name their own buildings); the owner gets all.
  const [users, accounts] = await Promise.all([listUsers(prisma, user), listAccounts(prisma, user)]);
  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const accountTeam = new Map(accounts.map((a) => [a.id, a.teamId]));

  return (
    <UserAdmin
      initial={users.map((u) => {
        // A partner login has no team of its own; its team is whichever team owns its building.
        const tid = u.teamId ?? (u.accountId ? (accountTeam.get(u.accountId) ?? null) : null);
        return {
          id: u.id,
          email: u.email,
          name: u.name ?? "",
          role: u.role,
          status: u.status,
          teamName: tid ? (teamName.get(tid) ?? null) : null,
        };
      })}
      accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
      isSuper={user.role === "SUPER_ADMIN"}
      teams={teams}
    />
  );
}
