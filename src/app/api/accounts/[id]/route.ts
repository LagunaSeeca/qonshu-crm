import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccount, updateAccount, deleteAccount } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const account = await getAccount(prisma, user, (await params).id);
    if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(account);
  } catch (e) { return errorResponse(e); }
}
const Patch = z.object({
  name: z.string().min(1).optional(), website: z.string().nullable().optional(),
  industry: z.string().nullable().optional(), status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(),
  accountManagerId: z.string().optional(),
  primaryContactName: z.string().nullable().optional(), primaryContactEmail: z.string().email().nullable().optional(),
  primaryContactPhone: z.string().nullable().optional(),
});
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Patch.parse(await req.json());
    const account = await updateAccount(prisma, user, (await params).id, d);
    return NextResponse.json(account);
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteAccount(prisma, user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
