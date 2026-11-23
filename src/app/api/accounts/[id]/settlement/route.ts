import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { getAccountSettlement, addSettlementEntry, resolveSettlementPeriod } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let period;
    try {
      period = resolveSettlementPeriod({ from: sp.get("from"), to: sp.get("to") });
    } catch {
      return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    }
    // view_settlements is asserted inside the service — this tab is also server-rendered.
    return NextResponse.json(await getAccountSettlement(prisma, user, (await params).id, period));
  } catch (e) { return errorResponse(e); }
}

// No `type`: Collected now comes from the partner API's card total, so the only settlement row a
// human creates is a TRANSFER. A client still posting `type` must say TRANSFER or be rejected —
// accepting "COLLECTED" silently would record a row that nothing ever reads.
const Body = z.object({
  type: z.literal("TRANSFER").optional(),
  amount: z.number().positive(),
  method: z.enum(["CASH", "BANK_TRANSFER", "MANUAL"]),
  occurredAt: z.string().min(1),
  note: z.string().optional(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Cheap 403 before the body is read; addSettlementEntry asserts the same action again, and
    // THAT assertion is the one that actually guards the write.
    assertCan(user, "write_settlements");
    const d = Body.parse(await req.json());
    const occurredAt = new Date(d.occurredAt);
    if (isNaN(occurredAt.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    const entry = await addSettlementEntry(prisma, user, (await params).id, { amount: d.amount, method: d.method, occurredAt, note: d.note });
    return NextResponse.json(entry, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
