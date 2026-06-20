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
    return NextResponse.json(await moveLeadStage(prisma, user, (await params).id, toStageId, lostReason));
  } catch (e) { return errorResponse(e); }
}
