import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import {
  listPartnerAllowlist,
  grantPartnerToCompany,
  PartnerAllowlistConflictError,
  PartnerAllowlistLinkConflictError,
} from "@/lib/platform/partner-allowlist";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// SUPER_ADMIN-only management of the partner allowlist — the table that decides which company
// may auto-link to which external complex (src/lib/platform/partner-allowlist.ts).
//
// SUPER_ADMIN ONLY, deliberately, for the same reason as GET /api/partners: these rows name
// complexes belonging to other companies, and a grant is the authorization that lets a tenant's
// account read a complex's debt, payments and unit-level owner names/phones.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    // Role FIRST, before any other work — listPartnerAllowlist asserts it again internally.
    assertRole(user, ["SUPER_ADMIN"]);
    return NextResponse.json(await listPartnerAllowlist(prisma, user));
  } catch (e) {
    return errorResponse(e);
  }
}

const Body = z.object({
  partnerName: z.string().min(1),
  companyId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    // Role FIRST, then parse: a non-super-admin must get 403, never a 400 that confirms the
    // route and its body shape.
    assertRole(user, ["SUPER_ADMIN"]);
    const { partnerName, companyId } = Body.parse(await req.json());
    const row = await grantPartnerToCompany(prisma, user, partnerName, companyId);
    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    if (e instanceof PartnerAllowlistConflictError)
      return NextResponse.json({ error: "partner_already_granted" }, { status: 409 });
    // Distinct from the above: nobody has been GRANTED this complex, but an account in another
    // company is already linked to it. Clear that link before granting it elsewhere.
    if (e instanceof PartnerAllowlistLinkConflictError)
      return NextResponse.json({ error: "partner_linked_elsewhere" }, { status: 409 });
    return errorResponse(e);
  }
}
