import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccount } from "@/lib/tenant/accounts";
import {
  listOnboardingSteps, listOnboardingAssignees, addOnboardingStep, setTakesOnlinePayments,
} from "@/lib/tenant/onboarding";
import { NotFoundError } from "@/lib/auth/guards";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).transform((s) => new Date(`${s}T00:00:00.000Z`));

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id } = await params;
    // listOnboardingSteps asserts manage_onboarding + scope first, so by the time getAccount runs
    // below for the flag, a caller without the capability has already been refused.
    const steps = await listOnboardingSteps(prisma, user, id);
    const assignees = await listOnboardingAssignees(prisma, user, id);
    const account = await getAccount(prisma, user, id);
    if (!account) throw new NotFoundError("account not in scope");
    return NextResponse.json({ steps, assignees, takesOnlinePayments: account.takesOnlinePayments });
  } catch (e) { return errorResponse(e); }
}

const AddBody = z.object({
  title: z.string().trim().min(1).max(200),
  assigneeId: z.string().nullish(),
  dueDate: DateStr.nullish(),
}).strict();
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = AddBody.parse(await req.json());
    const step = await addOnboardingStep(prisma, user, (await params).id, d);
    return NextResponse.json(step, { status: 201 });
  } catch (e) { return errorResponse(e); }
}

const FlagBody = z.object({ takesOnlinePayments: z.boolean().nullable() }).strict();
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = FlagBody.parse(await req.json());
    const takesOnlinePayments = await setTakesOnlinePayments(prisma, user, (await params).id, d.takesOnlinePayments);
    return NextResponse.json({ takesOnlinePayments });
  } catch (e) { return errorResponse(e); }
}
