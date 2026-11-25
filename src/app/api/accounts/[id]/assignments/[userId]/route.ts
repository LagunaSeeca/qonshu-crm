import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { unassignUserFromAccount } from "@/lib/tenant/account-assignments";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// Revoking a grant. No route-level role list: the capability (manage_account_assignments) is
// asserted inside the service BEFORE either id is read, so a MEMBER or an ONBOARDING caller gets
// the identical 403 for a real, a foreign and an invented account id.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id, userId } = await params;
    await unassignUserFromAccount(prisma, user, id, userId);
    // `{ ok: true }`, matching the neighbouring service-fees/attachments DELETEs, rather than a
    // 204: the client fetch helpers in this app all parse a JSON body.
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
