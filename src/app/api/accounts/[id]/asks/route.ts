import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listAsks, addAsk } from "@/lib/tenant/account-asks";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    return NextResponse.json(await listAsks(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}
const Body = z.object({ title: z.string().min(1), detail: z.string().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Body.parse(await req.json());
    const ask = await addAsk(prisma, user, (await params).id, { title: d.title, detail: d.detail });
    return NextResponse.json(ask, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
