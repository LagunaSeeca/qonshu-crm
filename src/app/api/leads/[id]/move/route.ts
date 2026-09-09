import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { moveLeadStage } from "@/lib/tenant/leads";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ toStageId: z.string().min(1), lostReason: z.string().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { toStageId, lostReason } = Body.parse(await req.json());
    // Body is `{ lead, autoConverted }`, not the bare lead: a move into Won also tries to create
    // the account, and that side effect is swallowed on failure (the stage move must stand alone).
    // `autoConverted` is how the client tells "Won, account ready" from "Won, no account" — the
    // board should surface the difference instead of reporting an unqualified success.
    const result = await moveLeadStage(prisma, user, (await params).id, toStageId, lostReason);
    return NextResponse.json(result);
  } catch (e) { return errorResponse(e); }
}
