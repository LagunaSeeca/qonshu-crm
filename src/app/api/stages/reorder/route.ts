import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { reorderStages } from "@/lib/tenant/stages";
import { stageScopeFromRequest } from "../scope";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ orderedIds: z.array(z.string()).min(1) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    // Scoped reorder: ids outside this team (or the template) match nothing instead of being
    // renumbered, so a posted id list cannot reach into a sibling team's pipeline.
    const scope = await stageScopeFromRequest(prisma, req, user);
    await reorderStages(prisma, scope, Body.parse(await req.json()).orderedIds);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
