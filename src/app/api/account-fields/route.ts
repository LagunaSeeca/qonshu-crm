import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listFieldDefs, createFieldDef } from "@/lib/tenant/account-fields";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    return NextResponse.json(await listFieldDefs(prisma, user));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ label: z.string().min(1), type: z.enum(["TEXT", "NUMBER", "CURRENCY", "DATE"]) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const data = Body.parse(await req.json());
    return NextResponse.json(await createFieldDef(prisma, user, data), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
