import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { reorderStages } from "@/lib/tenant/stages";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ orderedIds: z.array(z.string()).min(1) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await reorderStages(prisma, getTenantContext(user), Body.parse(await req.json()).orderedIds);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
