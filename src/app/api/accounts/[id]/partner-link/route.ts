import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import {
  confirmPartnerLink,
  rejectPartnerLink,
  NoPendingPartnerLinkError,
  SelfApprovalError,
} from "@/lib/tenant/partner-link-approval";
import {
  UnknownPartnerNameError,
  PartnerAlreadyClaimedError,
  PartnerListUnavailableError,
} from "@/lib/platform/account-partners";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// THE DECISION on a pending partner link (security review finding F1).
//
// A salesperson naming a building stakes a PENDING link, which grants nothing. This route is how
// such a link becomes live (the owner's direct assign, PATCH /api/platform/accounts/[id]/partner,
// is the other and only other writer). It is TENANT-scoped, not platform-scoped: confirming is the
// team admin's call for their own team, so authorization is ordinary account scoping and lives in
// the lib (getAccount -> null -> 404 for another team's account, the same shape as every other
// cross-team miss). A MEMBER is refused by the role check inside, including on their own proposal.
//
// NO ROLE ASSERTION HERE, on purpose: confirmPartnerLink/rejectPartnerLink each assert
// COMPANY_ADMIN before they touch the database, so calling straight into the lib fails closed and
// the rule lives in exactly one place. (assertRole admits a SUPER_ADMIN through a COMPANY_ADMIN
// list, and getAccount's own super-admin branch gives them every team.)
//
// THE LIVE COMPLEX LIST IS NOT EXPOSED BY THIS ROUTE. confirm re-checks the proposed name against
// the upstream list server-side and the response says only what happened to that one account;
// GET /api/partners, which names every team's complexes, stays SUPER_ADMIN-only.
export const dynamic = "force-dynamic";

// Explicit verb, no default. "confirm" grants a complex's debt, payments and unit-level owner
// names/phones to an account; a malformed or missing field must never be read as either decision.
const Body = z.object({ action: z.enum(["confirm", "reject"]) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    const { action } = Body.parse(await req.json());
    const id = (await params).id;

    const account = action === "confirm"
      ? await confirmPartnerLink(prisma, user, id)
      : await rejectPartnerLink(prisma, user, id);

    return NextResponse.json({
      id: account.id,
      name: account.name,
      externalPartnerKey: account.externalPartnerKey,
      partnerLinkConfirmedAt: account.partnerLinkConfirmedAt,
    });
  } catch (e) {
    // Distinct, typed statuses so the queue can tell the admin which rule they hit.
    if (e instanceof SelfApprovalError)
      return NextResponse.json({ error: "self_approval" }, { status: 403 });
    if (e instanceof NoPendingPartnerLinkError)
      return NextResponse.json({ error: "no_pending_link" }, { status: 409 });
    if (e instanceof PartnerAlreadyClaimedError)
      return NextResponse.json({ error: "partner_already_claimed" }, { status: 409 });
    // The proposed name matches no single live complex any more (renamed, removed, or two upstream
    // spellings collapsing onto one building). The admin's move is to reject it.
    if (e instanceof UnknownPartnerNameError)
      return NextResponse.json({ error: "unknown_partner" }, { status: 400 });
    if (e instanceof PartnerListUnavailableError)
      return NextResponse.json({ error: "partner_api_unavailable" }, { status: 503 });
    // NotFoundError (another team's account, or none) and ForbiddenError (a MEMBER) go through the
    // shared mapper, so a cross-team confirm is a plain 404 like every other out-of-scope access.
    return errorResponse(e);
  }
}
