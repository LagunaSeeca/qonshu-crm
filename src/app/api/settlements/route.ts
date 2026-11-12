import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listCompanySettlements, resolveSettlementPeriod } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// The role gate is NOT here — it is inside listCompanySettlements, because /settlements renders
// server-side and calls the service directly. This handler only resolves the period.
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let period;
    try {
      period = resolveSettlementPeriod({ from: sp.get("from"), to: sp.get("to") });
    } catch {
      return NextResponse.json({ error: "invalid_period" }, { status: 400 });
    }
    return NextResponse.json(await listCompanySettlements(prisma, user, period));
  } catch (e) { return errorResponse(e); }
}
