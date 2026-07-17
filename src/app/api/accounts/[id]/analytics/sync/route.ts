import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccount } from "@/lib/tenant/accounts";
import { syncAccountAnalytics } from "@/lib/analytics/sync";
import { MockPartnerAnalyticsSource } from "@/lib/analytics/source";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const { id } = await params;
    const acc = await getAccount(prisma, user, id);
    if (!acc) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const r = await syncAccountAnalytics(prisma, id, user.companyId!, new MockPartnerAnalyticsSource());
    return NextResponse.json(r);
  } catch (e) { return errorResponse(e); }
}
