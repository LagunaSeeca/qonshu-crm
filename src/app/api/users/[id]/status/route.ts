import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { setUserStatus } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ status: z.enum(["ACTIVE", "INACTIVE"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    // Team admins AND the owner: assertRole's widening admits SUPER_ADMIN to any gate that admits
    // COMPANY_ADMIN (see guards.ts), so the owner can deactivate a team admin without this route
    // spelling both roles. The former getTenantContext(user) call is gone with it — it threw for
    // the owner's null companyId, which is what locked the owner out of this route.
    assertRole(user, ["COMPANY_ADMIN"]);
    const { id } = await params;
    const { status } = Body.parse(await req.json());
    // Scope, self-deactivation and super-admin protection all live in setUserStatus.
    const updated = await setUserStatus(prisma, user, id, status);
    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (e) {
    return errorResponse(e);
  }
}
