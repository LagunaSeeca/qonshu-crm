import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { updateStage, deleteStage, StageHasLeadsError, LastStageError } from "@/lib/tenant/stages";
import { stageScopeFromRequest } from "../scope";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// The scope is part of the WHERE in updateStage/deleteStage, so a stage id belonging to another
// team (or to the org template) is a 404 here rather than an edit. A team admin's scope is
// always their own team; a SUPER_ADMIN names the team with `?teamId=`.
const Patch = z.object({ name: z.string().min(1).optional(), type: z.enum(["OPEN","WON","LOST"]).optional(), probability: z.number().int().min(0).max(100).optional() });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const scope = await stageScopeFromRequest(prisma, req, user);
    const { id } = await params;
    return NextResponse.json(await updateStage(prisma, scope, id, Patch.parse(await req.json())));
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const scope = await stageScopeFromRequest(prisma, req, user);
    const { id } = await params;
    await deleteStage(prisma, scope, id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof StageHasLeadsError) return NextResponse.json({ error: "stage_has_leads" }, { status: 409 });
    // "last stage of this TYPE in this TEAM" now — the guard counts per team, so one team cannot
    // be left with a pipeline that has no Won column just because a sibling team still has one.
    if (e instanceof LastStageError) return NextResponse.json({ error: "last_stage_of_type" }, { status: 409 });
    return errorResponse(e);
  }
}
