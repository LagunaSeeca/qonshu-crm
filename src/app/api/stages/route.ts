import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listStages, createStage } from "@/lib/tenant/stages";
import { stageScopeFromRequest } from "./scope";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// GET now takes `?teamId=` (see stageScopeFromRequest): a team admin or member always reads
// their own team's pipeline, a SUPER_ADMIN reads any team's with `?teamId=<id>` or the org
// default template with a bare `?teamId=`. Stages used to be company-wide, so this route
// returned one list for everyone.
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const scope = await stageScopeFromRequest(prisma, req, user);
    return NextResponse.json(await listStages(prisma, scope));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ name: z.string().min(1), type: z.enum(["OPEN", "WON", "LOST"]).optional(), probability: z.number().int().min(0).max(100).optional() });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const scope = await stageScopeFromRequest(prisma, req, user);
    const data = Body.parse(await req.json());
    return NextResponse.json(await createStage(prisma, scope, data), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
