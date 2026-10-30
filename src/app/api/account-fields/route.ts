import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listFieldDefs, createFieldDef } from "@/lib/tenant/account-fields";
import { fieldScopeFromRequest } from "./scope";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// `?teamId=` selects the definition set (see fieldScopeFromRequest): a team admin/member always
// gets their own team's; a SUPER_ADMIN names a team, or `?teamId=` (empty) for the org template.
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const scope = await fieldScopeFromRequest(prisma, req, user);
    return NextResponse.json(await listFieldDefs(prisma, user, scope));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ label: z.string().min(1), type: z.enum(["TEXT", "NUMBER", "CURRENCY", "DATE"]) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const scope = await fieldScopeFromRequest(prisma, req, user);
    const data = Body.parse(await req.json());
    return NextResponse.json(await createFieldDef(prisma, user, data, scope), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
