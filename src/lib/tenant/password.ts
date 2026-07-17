import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

export class InvalidCurrentPasswordError extends Error {}

// The only write a PARTNER_VIEWER may ever perform: changing their own password.
// Verifies the caller's current password against their own row before rotating it.
export async function changeOwnPassword(
  db: PrismaClient, user: SessionUser,
  args: { currentPassword: string; newPassword: string },
): Promise<void> {
  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  const ok = await verifyPassword(args.currentPassword, dbUser.passwordHash);
  if (!ok) throw new InvalidCurrentPasswordError("current password is incorrect");
  const passwordHash = await hashPassword(args.newPassword);
  await db.user.update({ where: { id: user.id }, data: { passwordHash } });
}
