import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { addActivity, listActivities } from "@/lib/tenant/activities";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listActivities(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}
const Body = z.object({ kind: z.enum(["NOTE","CALL","MEETING","EMAIL"]), body: z.string().min(1), outcome: z.string().optional(), occurredAt: z.string().datetime().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Body.parse(await req.json());
    const act = await addActivity(prisma, user, (await params).id, { ...d, occurredAt: d.occurredAt ? new Date(d.occurredAt) : undefined });
    return NextResponse.json(act, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
