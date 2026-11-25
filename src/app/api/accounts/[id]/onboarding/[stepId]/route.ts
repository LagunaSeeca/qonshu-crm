import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { updateOnboardingStep, deleteOnboardingStep } from "@/lib/tenant/onboarding";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00.000Z`));
const Body = z.object({
  done: z.boolean().optional(),
  assigneeId: z.string().nullable().optional(),
  dueDate: DateStr.nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
}).strict();

type Ctx = { params: Promise<{ id: string; stepId: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id, stepId } = await params;
    const d = Body.parse(await req.json());
    return NextResponse.json(await updateOnboardingStep(prisma, user, stepId, d, id));
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id, stepId } = await params;
    await deleteOnboardingStep(prisma, user, stepId, id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
