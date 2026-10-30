import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/db/client";
import { authorizeCredentials } from "@/lib/auth/authorize";
import type { SessionUser } from "@/lib/auth/guards";
import type { JWT } from "@auth/core/jwt";
import type { Session } from "@auth/core/types";

// next-auth v5 stores extra token fields as `unknown` — we extend JWT minimally
interface AppToken extends JWT {
  companyId?: string | null;
  teamId?: string | null;
  role?: SessionUser["role"];
  accountId?: string | null;
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      authorize: async (c) =>
        // authorizeCredentials returns SessionUser | null; next-auth expects User | null.
        // SessionUser shape (id, companyId, teamId, role) satisfies the structural User minimum (id).
        authorizeCredentials(prisma, {
          email: String(c?.email ?? ""),
          password: String(c?.password ?? ""),
        }) as Promise<SessionUser | null>,
    }),
  ],
  callbacks: {
    jwt({ token, user }): AppToken {
      if (user) {
        const su = user as unknown as SessionUser;
        (token as AppToken).companyId = su.companyId;
        (token as AppToken).teamId = su.teamId ?? null;
        (token as AppToken).role = su.role;
        (token as AppToken).accountId = su.accountId ?? null;
      }
      return token as AppToken;
    },
    session({ session, token }): Session {
      // Overwrite session.user entirely with our SessionUser shape so downstream
      // consumers only see { id, companyId, teamId, role, accountId } — no stale
      // name/email/image fields.
      //
      // These values are a SNAPSHOT taken at sign-in and are NOT authoritative: a JWT minted
      // before Teams landed carries no teamId at all, and one minted before a user was moved
      // between teams, demoted or deactivated carries the stale values until it expires.
      // getSessionUser() in session.ts therefore re-reads every field but `id` from the
      // database on every call and is the only thing app code should consume. What survives
      // here is `id`, which is immutable.
      // next-auth v5 beta types session.user as AdapterUser & User which is too strict
      // for JWT strategy — cast through unknown to avoid the incompatible union.
      const t = token as AppToken;
      const shaped: SessionUser = {
        id: t.sub ?? "",
        companyId: t.companyId ?? null,
        teamId: t.teamId ?? null,
        role: t.role as SessionUser["role"],
        accountId: t.accountId ?? null,
      };
      (session as { user: unknown }).user = shaped;
      return session;
    },
  },
  pages: { signIn: "/login" },
});
