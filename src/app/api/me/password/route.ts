import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { changeOwnPassword, InvalidCurrentPasswordError } from "@/lib/tenant/password";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8) });

// Any authenticated role, including PARTNER_VIEWER, may hit this route: it only ever
// touches the caller's own row, so there is no session-role gate beyond "signed in".
export async function PATCH(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    const { currentPassword, newPassword } = Body.parse(await req.json());
    await changeOwnPassword(prisma, user, { currentPassword, newPassword });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof InvalidCurrentPasswordError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
