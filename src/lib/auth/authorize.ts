import type { PrismaClient } from "@prisma/client";
import { verifyPassword } from "@/lib/auth/password";
import type { SessionUser } from "@/lib/auth/guards";

export async function authorizeCredentials(
  db: PrismaClient,
  creds: { email: string; password: string },
): Promise<SessionUser | null> {
  const user = await db.user.findUnique({ where: { email: creds.email } });
  if (!user || user.status !== "ACTIVE") return null;
  // Password FIRST, then the company check. Ordered deliberately: the company lookup is a ~1ms
  // query while verifyPassword is a full bcrypt round (~100ms), so running it first let an
  // attacker time the response and learn that a credential belongs to a suspended company —
  // i.e. that the account exists — without ever knowing the password. Every rejection now pays
  // the same bcrypt cost.
  if (!(await verifyPassword(creds.password, user.passwordHash))) return null;
  // A suspended company must not be able to log in at all — not just be blocked from new
  // provisioning (see createUser's super-admin branch in tenant/users.ts, which already refuses
  // to provision INTO a suspended company). A SUPER_ADMIN has no companyId and is unaffected.
  if (user.companyId) {
    const company = await db.company.findUnique({ where: { id: user.companyId } });
    if (!company || company.status !== "ACTIVE") return null;
  }
  return { id: user.id, companyId: user.companyId, role: user.role, accountId: user.accountId };
}
