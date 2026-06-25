import type { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";

export type CurrentUser = {
  name: string;
  email: string;
  role: Role;
  companyName: string | null;
};

export async function getCurrentUser(
  db: PrismaClient,
  user: SessionUser
): Promise<CurrentUser> {
  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  let companyName: string | null = null;
  if (user.companyId) {
    const company = await db.company.findUnique({ where: { id: user.companyId } });
    companyName = company?.name ?? null;
  }
  return {
    name: dbUser.name,
    email: dbUser.email,
    role: dbUser.role,
    companyName,
  };
}
