import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { deleteSettlementEntry, updateSettlementEntry } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Patch = z.object({
  amount: z.number().positive().optional(),
  method: z.enum(["CASH", "BANK_TRANSFER", "MANUAL"]).optional(),
  occurredAt: z.string().min(1).optional(),
  note: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertCan(user, "write_settlements"); // re-asserted inside the service, which is the real gate
    const d = Patch.parse(await req.json());
    let occurredAt: Date | undefined;
    if (d.occurredAt !== undefined) {
      occurredAt = new Date(d.occurredAt);
      if (isNaN(occurredAt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    }
    const entry = await updateSettlementEntry(prisma, user, (await params).entryId, {
      amount: d.amount, method: d.method, occurredAt, note: d.note,
    });
    return NextResponse.json(entry);
  } catch (e) { return errorResponse(e); }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string; entryId: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertCan(user, "write_settlements");
    await deleteSettlementEntry(prisma, user, (await params).entryId);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
