import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertCan } from "@/lib/auth/guards";
import { setCollectionMode } from "@/lib/tenant/settlements";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// DELIBERATELY ITS OWN ROUTE, not a field on PATCH /api/accounts/[id]. That handler is gated by
// `edit_accounts`, which includes MEMBER; this flag decides whether Qonshu owes a building money
// at all, so it is gated by `write_settlements` (SUPER_ADMIN alone) like every other write that
// moves a settlement figure. Merging the two would hand members the lever.
const Body = z.object({ collectionMode: z.enum(["QONSHU", "SELF"]) });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Cheap 403 before the body is read; setCollectionMode asserts the same action again, and
    // THAT assertion is the one that actually guards the write.
    assertCan(user, "write_settlements");
    const d = Body.parse(await req.json());
    // An out-of-scope or non-existent id raises NotFoundError inside the service -> 404, the same
    // answer for both, exactly like the sibling sub-resources.
    return NextResponse.json(await setCollectionMode(prisma, user, (await params).id, d.collectionMode));
  } catch (e) { return errorResponse(e); }
}
