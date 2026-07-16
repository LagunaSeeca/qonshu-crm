import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getReport, toCsv } from "@/lib/tenant/reports";
import { resolvePeriod, type PeriodType } from "@/lib/reports/period";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let period;
    try {
      period = resolvePeriod({
        type: (sp.get("period") as PeriodType | null) ?? "MONTHLY",
        from: sp.get("from") ?? undefined,
        to: sp.get("to") ?? undefined,
      });
    } catch (e) {
      if (e instanceof RangeError) return NextResponse.json({ error: "invalid_range" }, { status: 400 });
      throw e;
    }
    const report = await getReport(prisma, user, {
      range: { from: period.from, to: period.to },
      label: period.label,
      accountId: sp.get("accountId") ?? undefined,
    });
    const csv = toCsv(report);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="report-${report.label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.csv"`,
      },
    });
  } catch (e) { return errorResponse(e); }
}
