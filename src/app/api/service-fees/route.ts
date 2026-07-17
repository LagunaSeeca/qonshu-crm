import { NextRequest, NextResponse } from "next/server";
import type { ServiceFeeStatus } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listCompanyServiceFees } from "@/lib/tenant/service-fees";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const status = req.nextUrl.searchParams.get("status");
    const opts: { status?: ServiceFeeStatus } | undefined =
      status === "UNPAID" || status === "PAID" ? { status } : undefined;
    return NextResponse.json(await listCompanyServiceFees(prisma, user, opts));
  } catch (e) { return errorResponse(e); }
}
