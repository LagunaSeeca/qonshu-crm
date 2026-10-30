import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { resolveFieldDefScope, type FieldDefScope } from "@/lib/tenant/account-fields";

// Shared by all three account-fields routes so the three-state `teamId` is parsed in one place.
// Same contract as stageScopeFromRequest (src/app/api/stages/scope.ts):
//
//   ?teamId=<id>   that team's definitions (SUPER_ADMIN may name any team; a team admin/member
//                  may only name their own, and is refused otherwise)
//   ?teamId=       PRESENT BUT EMPTY: the ORG TEMPLATE. Super-admin only.
//   (absent)       a team admin/member gets their own team; a SUPER_ADMIN is refused, because
//                  it has no team to default to and guessing would edit the wrong team's fields.
//
// `sp.get` collapses "absent" and "present but empty" into `null`, so `sp.has` is consulted too.
export function fieldScopeFromRequest(
  db: Pick<PrismaClient, "team">, req: NextRequest, user: SessionUser,
): Promise<FieldDefScope> {
  const sp = req.nextUrl.searchParams;
  return resolveFieldDefScope(db, user, {
    teamId: sp.has("teamId") ? (sp.get("teamId") || null) : undefined,
    // Only read for the template scope, where there is no team to derive the company from.
    companyId: sp.get("companyId") ?? undefined,
  });
}
