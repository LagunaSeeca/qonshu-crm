import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccountSettlement, addSettlementEntry } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountSettlement(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({
  type: z.enum(["COLLECTED", "TRANSFER"]),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER"]).optional(),
  occurredAt: z.string().min(1),
  note: z.string().optional(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const d = Body.parse(await req.json());
    const occurredAt = new Date(d.occurredAt);
    if (isNaN(occurredAt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    const entry = await addSettlementEntry(prisma, user, (await params).id, { type: d.type, amount: d.amount, method: d.method, occurredAt, note: d.note });
    return NextResponse.json(entry, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
