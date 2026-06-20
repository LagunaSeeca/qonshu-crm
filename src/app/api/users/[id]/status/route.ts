import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { setUserStatus } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const { id } = await params;
    const { status } = Body.parse(await req.json());
    const updated = await setUserStatus(prisma, getTenantContext(user), id, status);
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (e) {
    return errorResponse(e);
  }
}
