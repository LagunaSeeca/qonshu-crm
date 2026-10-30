import type { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import type { SessionUser } from "@/lib/auth/guards";
import { resolveStageScope, type StageScope } from "@/lib/tenant/stages";

// Shared by all three stage routes so the three-state `teamId` is parsed in exactly one place.
//
//   ?teamId=<id>   that team's own pipeline (a SUPER_ADMIN may name any team; a team admin or
//                  member may only name their own, and is refused otherwise)
//   ?teamId=       PRESENT BUT EMPTY — the ORG DEFAULT STAGE TEMPLATE. Super-admin only; it is
//                  what every newly created team is seeded from, so one team's admin reshaping
//                  it would silently reshape every team created after them.
//   (absent)       not named. A team admin/member gets their own team; a SUPER_ADMIN is refused,
//                  because it has no team to default to and guessing one would edit the wrong
//                  team's pipeline.
//
// `sp.has` and `sp.get` are both consulted because `sp.get` collapses "absent" and "present but
// empty" into the same `null`, and those two mean opposite things here.
export function stageScopeFromRequest(
  db: Pick<PrismaClient, "team">, req: NextRequest, user: SessionUser,
): Promise<StageScope> {
  const sp = req.nextUrl.searchParams;
  return resolveStageScope(db, user, {
    teamId: sp.has("teamId") ? (sp.get("teamId") || null) : undefined,
    // Only read for the template scope, where there is no team to derive the company from.
    companyId: sp.get("companyId") ?? undefined,
  });
}
