import type { PrismaClient } from "@prisma/client";
import { verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/guards";

export async function authorizeCredentials(
  db: PrismaClient,
  creds: { email: string; password: string },
): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: creds.email } });
  if (!user || user.status !== "ACTIVE") return null;
  if (!(await verifyPassword(creds.password, user.passwordHash))) return null;
  return { id: user.id, companyId: user.companyId, role: user.role };
}
