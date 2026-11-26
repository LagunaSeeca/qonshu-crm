import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { FeeRateSchema, setServiceFeeRate } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// The amount is a STRING ("1234.50") or null (clear). Never z.number(): a JSON float would reach the
// Decimal column through binary floating point.
const Body = z.object({ monthlyServiceFee: FeeRateSchema });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Cheap 403 before the body is read; setServiceFeeRate asserts the same action again and that one
    // actually guards the write. Missing or out-of-scope account ids are a 404 from the service.
    assertCan(user, "write_settlements");
    const d = Body.parse(await req.json());
    return NextResponse.json(await setServiceFeeRate(prisma, user, (await params).id, d.monthlyServiceFee));
  } catch (e) { return errorResponse(e); }
}
