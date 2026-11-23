import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { renameTeam, InvalidTeamError } from "@/lib/tenant/teams";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ name: z.string().min(1) });

// Rename a team. There is no DELETE: Lead.teamId and Account.teamId are RESTRICT relations, so
// removing a team means deciding what happens to its whole book — a separate operation with its
// own confirmation, not a verb on this route.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["SUPER_ADMIN"]);
    const { id } = await params;
    const { name } = Body.parse(await req.json());
    const team = await renameTeam(prisma, user, id, name);
    return NextResponse.json({ id: team.id, name: team.name });
  } catch (e) {
    if (e instanceof InvalidTeamError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
