import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listAccounts, createAccountWithLogin, InvalidTrialError } from "@/lib/tenant/accounts";
import { maskAccount } from "@/lib/tenant/account-dto";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    const accounts = await listAccounts(prisma, user, {
      status: (sp.get("status") as "DEMO"|"ACTIVE"|"AT_RISK"|"CHURNED"|null) ?? undefined,
      accountManagerId: sp.get("accountManagerId") ?? undefined, q: sp.get("q") ?? undefined,
    });
    return NextResponse.json(accounts.map((a) => maskAccount(a, user)));
  } catch (e) { return errorResponse(e); }
}
const Create = z.object({ name: z.string().min(1), website: z.string().optional(), industry: z.string().optional(),
  // DEMO = a building on a 2-3 month TRIAL: an account with live statistics and no signed
  // contract, deliberately NOT counted as a won customer. It is only valid at CREATE time —
  // updateAccount refuses every transition INTO it — and it requires `trialEndsAt`.
  status: z.enum(["DEMO","ACTIVE","AT_RISK","CHURNED"]).optional(), accountManagerId: z.string().optional(),
  // ISO in, Date out: `z.coerce.date()` rejects an unparseable value as a ZodError (400) here,
  // so the service layer only ever sees Dates. The columns are `@db.Date` calendar days, which
  // the service normalizes — a time component in the payload is harmless.
  trialStartsAt: z.coerce.date().optional(), trialEndsAt: z.coerce.date().optional(),
  primaryContactName: z.string().optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")), primaryContactPhone: z.string().optional(),
  // NO `externalPartnerKey` HERE, ON PURPOSE. The external partner namespace is GLOBAL (one
  // shared PARTNER_API_KEY; `?partner=<name>` is the only discriminator), so a tenant naming an
  // arbitrary partner would pull another company's debt, payments and unit-level owner
  // names/phones into their own account. Assigning a partner is SUPER_ADMIN-only — see
  // src/lib/platform/account-partners.ts. Zod strips the field if a client sends it anyway.
  //
  // The automatic link still happens: createAccountWithLogin resolves an exact, unambiguous,
  // UNCLAIMED name match as a SYSTEM action (src/lib/tenant/accounts.ts).
  // ADMIN-ONLY, enforced in createAccountWithLogin rather than by the route's role gate, which
  // must keep admitting a MEMBER so members can still create accounts. Sending this field as a
  // MEMBER is a 403 and creates nothing — minting a PARTNER_VIEWER grants the very capabilities a
  // MEMBER is denied (see src/app/api/accounts/[id]/partner-login/route.ts).
  partnerLogin: z.object({
    name: z.string().min(1),
    email: z.string().email(),
    password: z.string().min(8),
  }).optional(),
});
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Create.parse(await req.json());
    const { account, partnerUser } = await createAccountWithLogin(prisma, user, {
      ...d, primaryContactEmail: d.primaryContactEmail || undefined,
    });
    // Never leak passwordHash back to the client, even on the just-created partner login.
    return NextResponse.json({
      account: maskAccount(account, user),
      partnerUser: partnerUser ? { id: partnerUser.id, name: partnerUser.name, email: partnerUser.email, role: partnerUser.role, status: partnerUser.status } : null,
    }, { status: 201 });
  } catch (e) {
    // 400, not 500: "a trial needs an end date" / "the trial cannot end before it starts" is a
    // mistake in the request, and the DB CHECK behind it would only produce an unmappable 500.
    if (e instanceof InvalidTrialError)
      return NextResponse.json({ error: "invalid_trial", message: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
