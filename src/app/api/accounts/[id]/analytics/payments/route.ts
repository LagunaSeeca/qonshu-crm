import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { listAccountPayments } from "@/lib/tenant/partner-analytics";
import { resolveRange, type RangePreset } from "@/lib/analytics/range";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    let range; try { range = resolveRange({ preset: (sp.get("preset") as RangePreset) ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }); }
    catch { return NextResponse.json({ error: "invalid_range" }, { status: 400 }); }
    // page / page_size flow straight through to the partner API (the client normalizes/clamps them).
    const page = sp.get("page") ? parseInt(sp.get("page")!, 10) : undefined;
    const pageSize = sp.get("page_size") ? parseInt(sp.get("page_size")!, 10) : undefined;
    return NextResponse.json(await listAccountPayments(prisma, user, (await params).id, { ...range, page, pageSize }));
  } catch (e) { return errorResponse(e); }
}
