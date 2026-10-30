import type { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";

export type CurrentUser = {
  name: string;
  email: string;
  role: Role;
  companyName: string | null;
  // The team whose book this person works. Null for the SUPER_ADMIN (who sees every team) and for
  // a PARTNER_VIEWER (pinned to one Account instead). The app shell shows it next to the role,
  // because with one company the company name no longer tells anyone which book they are in.
  teamName: string | null;
};

export async function getCurrentUser(
  db: PrismaClient,
  user: SessionUser
): Promise<CurrentUser> {
  // One read with both relations instead of a user read plus a separate company read: the session
  // was already re-derived from this row (see session.ts), so the row — not the session — is the
  // freshest source for the company and team the person belongs to.
  const dbUser = await db.user.findUniqueOrThrow({
    where: { id: user.id },
    include: { company: { select: { name: true } }, team: { select: { name: true } } },
  });
  return {
    name: dbUser.name,
    email: dbUser.email,
    role: dbUser.role,
    companyName: dbUser.company?.name ?? null,
    teamName: dbUser.team?.name ?? null,
  };
}
