import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { BillingMonthSchema, generateMonthlyFees } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ month: BillingMonthSchema });

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertCan(user, "write_settlements");
    const d = Body.parse(await req.json());
    return NextResponse.json(await generateMonthlyFees(prisma, user, d.month));
  } catch (e) { return errorResponse(e); }
}
