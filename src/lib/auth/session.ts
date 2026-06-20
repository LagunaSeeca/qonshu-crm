import { auth } from "@/lib/auth/config";
import type { SessionUser } from "@/lib/auth/guards";

export async function getSessionUser(): Promise<SessionUser | null> {
  const s = await auth();
  if (!s?.user) return null;
  // session.user was shaped in the session callback as SessionUser
  return s.user as unknown as SessionUser;
}
