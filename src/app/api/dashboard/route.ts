import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getDashboardStats } from "@/lib/tenant/dashboard";
import { resolvePeriod, type PeriodType } from "@/lib/reports/period";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let range;
    try {
      range = resolvePeriod({
        type: (sp.get("period") as PeriodType | null) ?? "MONTHLY",
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
      });
    } catch (e) {
      if (e instanceof RangeError) return NextResponse.json({ error: "invalid_range" }, { status: 400 });
      throw e;
    }
    return NextResponse.json(await getDashboardStats(prisma, user, { from: range.from, to: range.to }));
  } catch (e) { return errorResponse(e); }
}
