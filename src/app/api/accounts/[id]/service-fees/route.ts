import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccountServiceFees, addServiceFee } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountServiceFees(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({
  periodMonth: z.string().min(1),
  amount: z.number().positive(),
  dueDate: z.string().optional(),
  note: z.string().optional(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const d = Body.parse(await req.json());
    const periodMonth = new Date(d.periodMonth);
    if (isNaN(periodMonth.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    let dueDate: Date | undefined;
    if (d.dueDate) {
      dueDate = new Date(d.dueDate);
      if (isNaN(dueDate.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    }
    const fee = await addServiceFee(prisma, user, (await params).id, { periodMonth, amount: d.amount, dueDate, note: d.note });
    return NextResponse.json(fee, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
