import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { createTeamWithAdmin, listTeams, InvalidTeamError } from "@/lib/tenant/teams";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// SUPER_ADMIN-only, and NOT by assertRole's widening: `["SUPER_ADMIN"]` does not admit a
// COMPANY_ADMIN (the widening runs the other way — see guards.ts), which is exactly right. A team
// admin administers the people inside its team, never the set of teams.
const CreateBody = z.object({
  name: z.string().min(1),
  adminName: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
  // Only needed if the owner's own companyId is unset AND the database holds more than one
  // company; with the single org it is resolved for the caller.
  companyId: z.string().min(1).optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["SUPER_ADMIN"]);
    return NextResponse.json(await listTeams(prisma, user));
  } catch (e) {
    if (e instanceof InvalidTeamError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["SUPER_ADMIN"]);
    const data = CreateBody.parse(await req.json());
    const { team, admin } = await createTeamWithAdmin(prisma, user, data);
    return NextResponse.json(
      {
        team: { id: team.id, name: team.name, createdAt: team.createdAt },
        admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, status: admin.status },
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof InvalidTeamError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
