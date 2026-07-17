import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { markFeePaid, markFeeUnpaid, updateServiceFee, deleteServiceFee } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const PatchBody = z.union([
  z.object({
    action: z.literal("markPaid"),
    method: z.enum(["CASH", "BANK_TRANSFER", "MANUAL"]).optional(),
    paidAt: z.string().optional(),
  }),
  z.object({ action: z.literal("markUnpaid") }),
  z.object({
    amount: z.number().positive().optional(),
    dueDate: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    periodMonth: z.string().optional(),
  }),
]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; feeId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { feeId } = await params;
    const d = PatchBody.parse(await req.json());

    if ("action" in d && d.action === "markPaid") {
      let paidAt: Date | undefined;
      if (d.paidAt) {
        paidAt = new Date(d.paidAt);
        if (isNaN(paidAt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
      }
      const fee = await markFeePaid(prisma, user, feeId, { method: d.method, paidAt });
      return NextResponse.json(fee);
    }
    if ("action" in d && d.action === "markUnpaid") {
      const fee = await markFeeUnpaid(prisma, user, feeId);
      return NextResponse.json(fee);
    }

    const data: Partial<{ amount: number; dueDate: Date | null; note: string | null; periodMonth: Date }> = {};
    if ("amount" in d && d.amount !== undefined) data.amount = d.amount;
    if ("dueDate" in d && d.dueDate !== undefined) {
      if (d.dueDate === null) data.dueDate = null;
      else {
        const dt = new Date(d.dueDate);
        if (isNaN(dt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
        data.dueDate = dt;
      }
    }
    if ("note" in d && d.note !== undefined) data.note = d.note;
    if ("periodMonth" in d && d.periodMonth !== undefined) {
      const pm = new Date(d.periodMonth);
      if (isNaN(pm.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
      data.periodMonth = pm;
    }
    const fee = await updateServiceFee(prisma, user, feeId, data);
    return NextResponse.json(fee);
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; feeId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteServiceFee(prisma, user, (await params).feeId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
