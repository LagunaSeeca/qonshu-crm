import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listAccounts, createAccount } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    return NextResponse.json(await listAccounts(prisma, user, {
      status: (sp.get("status") as "ACTIVE"|"AT_RISK"|"CHURNED"|null) ?? undefined,
      accountManagerId: sp.get("accountManagerId") ?? undefined, q: sp.get("q") ?? undefined,
    }));
  } catch (e) { return errorResponse(e); }
}
const Create = z.object({ name: z.string().min(1), website: z.string().optional(), industry: z.string().optional(),
  status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(), accountManagerId: z.string().optional(),
  primaryContactName: z.string().optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")), primaryContactPhone: z.string().optional() });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Create.parse(await req.json());
    return NextResponse.json(await createAccount(prisma, user, { ...d, primaryContactEmail: d.primaryContactEmail || undefined }), { status: 201 });
  } catch (e) { return errorResponse(e); }
}
