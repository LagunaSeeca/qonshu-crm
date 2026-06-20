import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { toggleTask } from "@/lib/tenant/tasks";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ done: z.boolean() });
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; taskId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { taskId } = await params;
    return NextResponse.json(await toggleTask(prisma, user, taskId, Body.parse(await req.json()).done));
  } catch (e) { return errorResponse(e); }
}
