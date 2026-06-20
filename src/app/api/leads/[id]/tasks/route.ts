import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { addTask, listTasks } from "@/lib/tenant/tasks";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listTasks(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}
const Body = z.object({ title: z.string().min(1), dueDate: z.string().datetime().optional(), assigneeId: z.string().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Body.parse(await req.json());
    const task = await addTask(prisma, user, (await params).id, { title: d.title, dueDate: d.dueDate ? new Date(d.dueDate) : null, assigneeId: d.assigneeId });
    return NextResponse.json(task, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
