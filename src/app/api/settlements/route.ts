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
    // `status` is validated rather than cast: an unrecognized value must not silently behave as
    // "no filter", which would show the caller every row when they asked for one bucket.
    const rawStatus = sp.get("status");
    let status: "owed" | "settled" | undefined;
    if (rawStatus === "owed" || rawStatus === "settled") status = rawStatus;
    else if (rawStatus !== null) return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    const filters = {
      q: sp.get("q") ?? undefined,
      accountId: sp.get("accountId") ?? undefined,
      status,
    };
    return NextResponse.json(await listCompanySettlements(prisma, user, period, filters));
  } catch (e) { return errorResponse(e); }
}
