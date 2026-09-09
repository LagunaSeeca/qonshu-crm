import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { convertLeadToAccount } from "@/lib/tenant/lead-conversion";
import { maskAccount } from "@/lib/tenant/account-dto";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ leadId: z.string().min(1) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Creating an account is admin/member work — same gate as POST /api/accounts. Without this
    // a PARTNER_VIEWER could mint accounts in the tenant off any lead id it could name.
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const { leadId } = Body.parse(await req.json());
    // Idempotent: an already-converted lead (e.g. auto-converted on the move to Won) returns
    // its existing account as 200 instead of erroring, so the button always lands somewhere.
    const { account, created } = await convertLeadToAccount(prisma, user, leadId);
    // maskAccount is NOT optional on the created===false branch: that returns a pre-existing row
    // which is exactly the one that could still carry a dormant externalApiKeyEnc override.
    return NextResponse.json(maskAccount(account), { status: created ? 201 : 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
