import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { updateFieldDef, deleteFieldDef } from "@/lib/tenant/account-fields";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Patch = z.object({ label: z.string().min(1).optional(), type: z.enum(["TEXT", "NUMBER", "CURRENCY", "DATE"]).optional() });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ defId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { defId } = await params;
    return NextResponse.json(await updateFieldDef(prisma, user, defId, Patch.parse(await req.json())));
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ defId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { defId } = await params;
    await deleteFieldDef(prisma, user, defId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
