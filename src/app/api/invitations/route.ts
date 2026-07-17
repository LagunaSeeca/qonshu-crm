import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { createInvitation, InvalidInvitationRoleError } from "@/lib/tenant/invitations";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({
  email: z.string().email(),
  role: z.enum(["COMPANY_ADMIN", "MEMBER", "PARTNER_VIEWER"]),
  accountId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const ctx = getTenantContext(user);
    const { email, role, accountId } = Body.parse(await req.json());
    const inv = await createInvitation(prisma, ctx, { email, role, accountId, invitedById: user.id });
    return NextResponse.json(inv, { status: 201 });
  } catch (e) {
    if (e instanceof InvalidInvitationRoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
