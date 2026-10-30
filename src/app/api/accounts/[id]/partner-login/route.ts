import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import {
  listPartnerLogins,
  createPartnerLogin,
  InvalidPartnerLoginError,
  PartnerLoginExistsError,
} from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// The representative login for ONE building, created by the person who manages that building.
//
// WHY IT IS NOT BEHIND THE USER-ADMIN GATE: a sales manager owns the relationship with their
// complex's representative. Making them queue behind a team admin to hand over portal access is
// the kind of friction that ends with one shared login for every building. So MEMBER, team admin
// and SUPER_ADMIN may all call this (assertRole admits a SUPER_ADMIN wherever it admits a
// COMPANY_ADMIN — see src/lib/auth/guards.ts).
//
// `getAccount` inside the lib functions is the ENTIRE authorization: it applies accountScopeWhere,
// so a MEMBER can only name an account they themselves manage and can therefore only ever mint a
// login confined to their own building. A PARTNER_VIEWER is refused by the role gate before that,
// which matters — otherwise a partner could mint a second login on its own account.
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    // Already masked by the lib (id/name/email/status only) — passwordHash never leaves the row.
    return NextResponse.json(await listPartnerLogins(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // Role FIRST, then parse: a caller who may not use this route must get 403, never a 400 that
    // confirms the route exists and tells them its body shape.
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Body.parse(await req.json());
    const login = await createPartnerLogin(prisma, user, (await params).id, d);
    return NextResponse.json(login, { status: 201 });
  } catch (e) {
    // 409, not 500: one ACTIVE partner login per account is a rule the caller can act on — the
    // existing login has to be deactivated before a replacement is issued.
    if (e instanceof PartnerLoginExistsError)
      return NextResponse.json({ error: "partner_login_exists" }, { status: 409 });
    if (e instanceof InvalidPartnerLoginError)
      return NextResponse.json({ error: "invalid_partner_login" }, { status: 400 });
    return errorResponse(e);
  }
}
