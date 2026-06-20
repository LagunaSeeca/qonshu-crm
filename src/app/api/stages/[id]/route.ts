import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { updateStage, deleteStage, StageHasLeadsError } from "@/lib/tenant/stages";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Patch = z.object({ name: z.string().min(1).optional(), type: z.enum(["OPEN","WON","LOST"]).optional(), probability: z.number().int().min(0).max(100).optional() });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { id } = await params;
    return NextResponse.json(await updateStage(prisma, getTenantContext(user), id, Patch.parse(await req.json())));
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { id } = await params;
    await deleteStage(prisma, getTenantContext(user), id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StageHasLeadsError) return NextResponse.json({ error: "stage_has_leads" }, { status: 409 });
    return errorResponse(e);
  }
}
