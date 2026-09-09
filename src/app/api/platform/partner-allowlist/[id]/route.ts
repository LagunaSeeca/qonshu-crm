import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { revokePartnerAllowlistEntry } from "@/lib/platform/partner-allowlist";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// Revoke one partner grant. SUPER_ADMIN-only — see ../route.ts. Removes FUTURE auto-link
// authorization only; an account already holding the link keeps it until a platform admin
// clears it explicitly (PATCH /api/platform/accounts/[id]/partner with null).
export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["SUPER_ADMIN"]);
    await revokePartnerAllowlistEntry(prisma, user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
