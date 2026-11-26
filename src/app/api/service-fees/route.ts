import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listCompanyServiceFees, type ServiceFeeListStatus } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const STATUSES: readonly string[] = ["PAID", "UNPAID", "OVERDUE"];

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    const status = sp.get("status");
    const opts: NonNullable<Parameters<typeof listCompanyServiceFees>[2]> = {};
    if (status && STATUSES.includes(status)) opts.status = status as ServiceFeeListStatus;
    for (const k of ["from", "to"] as const) {
      const v = sp.get(k);
      if (!v) continue;
      const d = new Date(v);
      if (isNaN(d.getTime())) return NextResponse.json({ error: "invalid_date" }, { status: 400 });
      opts[k] = d;
    }
    const q = sp.get("q"); if (q) opts.q = q;
    const accountId = sp.get("accountId"); if (accountId) opts.accountId = accountId;
    return NextResponse.json(await listCompanyServiceFees(prisma, user, opts));
  } catch (e) { return errorResponse(e); }
}
