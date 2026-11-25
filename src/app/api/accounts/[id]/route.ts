import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import {
  getAccount, updateAccount, deleteAccount,
  InvalidTrialError, InvalidStatusTransitionError,
} from "@/lib/tenant/accounts";
import { maskAccount } from "@/lib/tenant/account-dto";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const account = await getAccount(prisma, user, (await params).id);
    if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(maskAccount(account, user));
  } catch (e) { return errorResponse(e); }
}
const Patch = z.object({
  name: z.string().min(1).optional(), website: z.string().nullable().optional(),
  // DEMO is accepted BY THE SCHEMA and REFUSED BY THE SERVICE: an account can only START as a
  // trial (assertStatusTransition in src/lib/tenant/accounts.ts), so sending it here is a 400
  // "invalid_status_transition" rather than a silently stripped field that looks like it worked.
  industry: z.string().nullable().optional(), status: z.enum(["DEMO","ACTIVE","AT_RISK","CHURNED"]).optional(),
  // EXTENDING A TRIAL. Accepted only while the account IS DEMO — the service refuses them on any
  // other status. ISO in, Date out; see POST /api/accounts.
  trialStartsAt: z.coerce.date().optional(), trialEndsAt: z.coerce.date().optional(),
  // min(1): an empty string is falsy, so updateAccount skips the reassignment branch, but `...data`
  // still writes accountManagerId: "" and Postgres answers with an FK violation that surfaces as
  // an unmapped 500. "Don't change the manager" is expressed by omitting the field.
  accountManagerId: z.string().min(1).optional(),
  primaryContactName: z.string().nullable().optional(), primaryContactEmail: z.string().email().nullable().optional(),
  primaryContactPhone: z.string().nullable().optional(),
  // NO `externalPartnerKey` HERE, ON PURPOSE. The external partner namespace is GLOBAL (one
  // shared PARTNER_API_KEY; `?partner=<name>` is the only discriminator), so letting a tenant
  // re-point their account at any partner name would expose another company's debt, payments
  // and unit-level owner names/phones. Assigning/clearing the link is SUPER_ADMIN-only — see
  // src/lib/platform/account-partners.ts. Zod strips the field if a client sends it anyway.
});
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Patch.parse(await req.json());
    const id = (await params).id;
    const account: Account = await updateAccount(prisma, user, id, d);
    return NextResponse.json(maskAccount(account, user));
  } catch (e) {
    // Both are 400s the caller can act on, not server faults: an illegal lifecycle step
    // (ACTIVE -> DEMO, DEMO -> AT_RISK) and a trial window that is missing, backwards, or being
    // edited on an account that is not on trial.
    if (e instanceof InvalidStatusTransitionError)
      return NextResponse.json({ error: "invalid_status_transition", message: e.message }, { status: 400 });
    if (e instanceof InvalidTrialError)
      return NextResponse.json({ error: "invalid_trial", message: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteAccount(prisma, user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
