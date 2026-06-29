import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { resolveAsk, reopenAsk } from "@/lib/tenant/account-asks";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ action: z.enum(["resolve", "reopen"]) });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; askId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { askId } = await params;
    const { action } = Body.parse(await req.json());
    const ask = action === "resolve" ? await resolveAsk(prisma, user, askId) : await reopenAsk(prisma, user, askId);
    return NextResponse.json(ask);
  } catch (e) { return errorResponse(e); }
}
