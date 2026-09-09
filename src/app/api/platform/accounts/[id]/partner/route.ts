import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import {
  setAccountPartner,
  UnknownPartnerNameError,
  PartnerAlreadyClaimedError,
  PartnerAllowlistMismatchError,
  PartnerListUnavailableError,
} from "@/lib/platform/account-partners";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// The ONLY human-driven way to set an account's external partner link. SUPER_ADMIN-only, and
// deliberately platform-scoped rather than tenant-scoped: a SUPER_ADMIN has companyId: null and
// so cannot use /api/accounts/[id] at all, while a COMPANY_ADMIN must never be able to point
// their account at another tenant's partner (the namespace is global — see
// src/lib/platform/account-partners.ts). setAccountPartner asserts the role again internally, so
// calling straight into the lib still fails closed.
export const dynamic = "force-dynamic";

// `null` clears the link. `z.string().nullable()` (not `.optional()`): the caller must state
// the intent explicitly, so a typo'd field name can't silently read as "clear it".
const Body = z.object({ externalPartnerKey: z.string().nullable() });

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    // Role FIRST, then parse — matching every other route. Parsing first made a non-super-admin's
    // malformed body answer 400 instead of 403, which confirms the route exists and is reachable
    // to exactly the callers who must learn nothing about it.
    assertRole(user, ["SUPER_ADMIN"]);
    const { externalPartnerKey } = Body.parse(await req.json());
    const account = await setAccountPartner(prisma, user, (await params).id, externalPartnerKey);
    return NextResponse.json({
      id: account.id, name: account.name, externalPartnerKey: account.externalPartnerKey,
    });
  } catch (e) {
    // Distinct, typed statuses so the platform card can tell the admin which rule they hit.
    if (e instanceof PartnerAlreadyClaimedError)
      return NextResponse.json({ error: "partner_already_claimed" }, { status: 409 });
    if (e instanceof PartnerAllowlistMismatchError)
      return NextResponse.json({ error: "partner_allowlist_mismatch" }, { status: 409 });
    if (e instanceof UnknownPartnerNameError)
      return NextResponse.json({ error: "unknown_partner" }, { status: 400 });
    if (e instanceof PartnerListUnavailableError)
      return NextResponse.json({ error: "partner_api_unavailable" }, { status: 503 });
    return errorResponse(e);
  }
}
