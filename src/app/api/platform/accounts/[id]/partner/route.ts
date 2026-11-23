import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import {
  setAccountPartner,
  UnknownPartnerNameError,
  PartnerAlreadyClaimedError,
  PartnerNameHeldError,
  PartnerListUnavailableError,
} from "@/lib/platform/account-partners";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// DIRECT assignment of an account's external partner link, off the live complex list.
// SUPER_ADMIN-only, and deliberately so: the list this is driven by (GET /api/partners) names
// complexes belonging to every team. The other way a link goes live is a team admin CONFIRMING a
// link their own team staked — POST /api/accounts/[id]/partner-link, which verifies one named
// complex server-side and so needs no list at all.
//
// It is deliberately platform-scoped rather than tenant-scoped: a SUPER_ADMIN has companyId: null
// and so cannot use /api/accounts/[id] at all, while a COMPANY_ADMIN must never be able to point
// their account at an arbitrary partner (the namespace is global — see
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
    // The name is claimed as a BUILDING by another lead or account. `message` is carried onto the
    // wire (unlike every other branch here) because it names the holding record, and this route is
    // SUPER_ADMIN-only — the admin cannot resolve the clash without knowing what to reassign.
    if (e instanceof PartnerNameHeldError)
      return NextResponse.json(
        { error: "partner_name_held", message: e.message, holder: { kind: e.holderKind, id: e.holderId } },
        { status: 409 },
      );
    if (e instanceof UnknownPartnerNameError)
      return NextResponse.json({ error: "unknown_partner" }, { status: 400 });
    if (e instanceof PartnerListUnavailableError)
      return NextResponse.json({ error: "partner_api_unavailable" }, { status: 503 });
    return errorResponse(e);
  }
}
