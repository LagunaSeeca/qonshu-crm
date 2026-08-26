import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccountInstallSnapshots, upsertInstallSnapshot } from "@/lib/tenant/platform-installs";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getAccountInstallSnapshots(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const Body = z.object({
  capturedOn: z.string().regex(DATE_ONLY, "invalid_date"),
  iosInstalls: z.number().int().nonnegative(),
  androidInstalls: z.number().int().nonnegative(),
});
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const d = Body.parse(await req.json());
    const [y, m, day] = d.capturedOn.split("-").map(Number);
    const capturedOn = new Date(Date.UTC(y, m - 1, day));
    // Date.UTC silently normalizes out-of-range days (e.g. Feb 30 -> Mar 2), so require the
    // parsed date to round-trip back to the exact y/m/d that was sent.
    if (capturedOn.getUTCFullYear() !== y || capturedOn.getUTCMonth() !== m - 1 || capturedOn.getUTCDate() !== day) {
      return NextResponse.json({ error: "invalid_date" }, { status: 400 });
    }
    const snapshot = await upsertInstallSnapshot(prisma, user, (await params).id, {
      capturedOn, iosInstalls: d.iosInstalls, androidInstalls: d.androidInstalls,
    });
    return NextResponse.json(snapshot, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
