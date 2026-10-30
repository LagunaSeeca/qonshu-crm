import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { prisma } from "@/db/client";
import { listTeams } from "@/lib/tenant/teams";
import { TeamAdmin } from "./TeamAdmin";

// SUPER_ADMIN only. Replaces the old company-create and platform user-create screens: Qonshu is one
// company, so provisioning now means creating a TEAM together with its one admin.
export default async function TeamsPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== "SUPER_ADMIN") redirect("/dashboard");

  const teams = await listTeams(prisma, user);

  return (
    <TeamAdmin
      initial={teams.map((t) => ({
        id: t.id,
        name: t.name,
        createdAt: t.createdAt.toISOString(),
        admins: t.admins,
        members: t.members,
        admin: t.admin,
      }))}
    />
  );
}
