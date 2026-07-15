import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getAccountAnalytics } from "@/lib/tenant/partner-analytics";
import { resolveRange, type RangePreset } from "@/lib/analytics/range";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let range; try { range = resolveRange({ preset: (sp.get("preset") as RangePreset) ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }); }
    catch { return NextResponse.json({ error: "invalid_range" }, { status: 400 }); }
    return NextResponse.json(await getAccountAnalytics(prisma, user, (await params).id, range));
  } catch (e) { return errorResponse(e); }
}
