import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ shareAllLeads: z.boolean() });
export async function PATCH(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const ctx = getTenantContext(user);
    const { shareAllLeads } = Body.parse(await req.json());
    await prisma.company.update({ where: { id: ctx.companyId }, data: { shareAllLeads } });
    return NextResponse.json({ ok: true, shareAllLeads });
  } catch (e) { return errorResponse(e); }
}
