import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listCompanySettlements } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET() {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await listCompanySettlements(prisma, user));
  } catch (e) { return errorResponse(e); }
}
