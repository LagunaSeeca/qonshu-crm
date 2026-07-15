import { NextRequest, NextResponse } from "next/server";
import type { PaymentMethod, PaymentCategory } from "@prisma/client";
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
    const method = sp.get("method") as PaymentMethod | null;
    const category = sp.get("category") as PaymentCategory | null;
    const skip = sp.get("skip") ? parseInt(sp.get("skip")!, 10) : undefined;
    const take = sp.get("take") ? parseInt(sp.get("take")!, 10) : undefined;
    return NextResponse.json(await listAccountPayments(prisma, user, (await params).id, { ...range, method: method ?? undefined, category: category ?? undefined, skip, take }));
  } catch (e) { return errorResponse(e); }
}
