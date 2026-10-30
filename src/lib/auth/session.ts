import { prisma } from "@/db/client";
import { auth } from "@/lib/auth/config";
import type { SessionUser } from "@/lib/auth/guards";

// The ONE place app code turns a request into a SessionUser.
//
// The JWT is treated as proof of IDENTITY ONLY — nothing more. Every authorization-relevant
// field (role, status, companyId, teamId, accountId) is re-read from the row on every call,
// because a next-auth JWT is self-contained and immutable until it expires, which made two
// things wrong:
//
//   1. Deactivating a user had no effect until their token expired — they kept working, with
//      their old role, for the rest of the token's life. Now status is checked per request and
//      an INACTIVE user resolves to null, i.e. logged out on their next request.
//   2. Tokens minted before Teams landed carry no `teamId`. Trusting the token would hand the
//      scope helpers `teamId: null`, which (fail-closed) locks out every pre-upgrade session
//      until it expires. Reading it from the row makes the upgrade invisible to users.
//
// It is one primary-key lookup, by design: deliberately not a join, and deliberately not cached.
// Correct revocation on every request is worth one indexed point read per request.
export async function getSessionUser(): Promise<SessionUser | null> {
  const s = await auth();
  // `id` is the only token field used: it is immutable, and the signature already proves it.
  const id = (s?.user as { id?: string } | undefined)?.id;
  if (!id) return null;

  const row = await prisma.user.findUnique({
    where: { id },
    select: { id: true, companyId: true, teamId: true, role: true, accountId: true, status: true },
  });
  // Fail closed on both arms: a token whose user was deleted, and one whose user was
  // deactivated, are equally no session at all.
  if (!row || row.status !== "ACTIVE") return null;

  return {
    id: row.id,
    companyId: row.companyId,
    teamId: row.teamId,
    role: row.role,
    accountId: row.accountId,
  };
}
