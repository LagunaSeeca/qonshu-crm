import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listUsers, createUser, InvalidUserRoleError } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const CreateBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["COMPANY_ADMIN", "MEMBER", "PARTNER_VIEWER"]),
  accountId: z.string().min(1).optional(),
  // Replaces the old `companyId` field, which is gone: with one org, the question is never "which
  // company" but "which TEAM". A SUPER_ADMIN must name it (it has no team of its own). A team
  // admin may omit it — createUser() uses their own team — but if they DO send one it has to be
  // their own: createUser rejects another team's id outright (400) rather than quietly
  // substituting their own team and reporting 201 for something other than what was asked.
  teamId: z.string().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    // Includes SUPER_ADMIN via assertRole's widening (see guards.ts).
    assertRole(user, ["COMPANY_ADMIN"]);
    // Optional filter, SUPER_ADMIN-facing: pick one team out of the org. A team admin passing
    // another team's id is rejected inside listUsers (403), not narrowed to their own.
    const teamId = req.nextUrl.searchParams.get("teamId") ?? undefined;
    const users = await listUsers(prisma, user, { teamId });
    return NextResponse.json(
      users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        status: u.status,
        teamId: u.teamId,
        accountId: u.accountId,
      })),
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const data = CreateBody.parse(await req.json());
    const created = await createUser(prisma, user, data);
    return NextResponse.json(
      {
        id: created.id,
        email: created.email,
        name: created.name,
        role: created.role,
        status: created.status,
        teamId: created.teamId,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof InvalidUserRoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
