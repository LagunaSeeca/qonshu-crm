import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { deleteSettlementEntry } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteSettlementEntry(prisma, user, (await params).entryId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
