import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { getAccountServiceFees, addServiceFee, FeeAmountSchema } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountServiceFees(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({
  periodMonth: z.string().min(1),
  // FeeAmountSchema, not z.number(): creating a fee SETS a price, and the amount reaches a Prisma
  // Decimal column. A JSON number would be parsed as a float first, which is where a cent goes
  // missing. A client still sending a number is now rejected (400) rather than silently coerced.
  amount: FeeAmountSchema,
  dueDate: z.string().optional(),
  note: z.string().optional(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Creating a fee row is PRICING, which is owner-only. This used to be
    // assertRole(["COMPANY_ADMIN"]), which no longer matches the service: addServiceFee asserts
    // write_settlements (SUPER_ADMIN). Leaving the stale admin gate here meant a COMPANY_ADMIN got
    // past the route only to be refused one call later — same outcome, misleading read.
    assertCan(user, "write_settlements");
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
