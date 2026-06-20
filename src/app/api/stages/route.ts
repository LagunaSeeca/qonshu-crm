import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { listStages, createStage } from "@/lib/tenant/stages";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listStages(prisma, getTenantContext(user)));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ name: z.string().min(1), type: z.enum(["OPEN", "WON", "LOST"]).optional(), probability: z.number().int().min(0).max(100).optional() });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const data = Body.parse(await req.json());
    return NextResponse.json(await createStage(prisma, getTenantContext(user), data), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
