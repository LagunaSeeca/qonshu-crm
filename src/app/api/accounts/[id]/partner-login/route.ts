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

// The representative login for ONE building.
//
// CREATING ONE IS ADMIN-ONLY (assertRole admits a SUPER_ADMIN wherever it admits a COMPANY_ADMIN —
// see src/lib/auth/guards.ts). A PARTNER_VIEWER is granted exactly the capabilities a MEMBER is
// denied (view_settlements, view_payment_detail, view_object_detail), so a member allowed to mint
// one — with a password they choose — on an account they manage can log in as it and read the
// settlement and payment data their own gate refuses. Scope does not contain that: the account is
// legitimately theirs. Hence the role gate, and hence the SAME gate inside createPartnerLogin,
// which is the authoritative one; this route gate only makes the refusal cheap and keeps the
// reply a 403 rather than a 400 about the body.
//
// LISTING stays open to a MEMBER: the rows are masked (id/name/email/status) and a member can only
// name an account they manage, so it tells them nothing about their own building they may not see.
// `getAccount` inside the lib functions still decides WHICH account may be named. A PARTNER_VIEWER
// is refused by the role gate on both verbs, which matters — otherwise a partner could enumerate
// or mint logins on its own account.
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
    assertRole(user, ["COMPANY_ADMIN"]);
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
