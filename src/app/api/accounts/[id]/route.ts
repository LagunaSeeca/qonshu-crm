import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccount, updateAccount, deleteAccount } from "@/lib/tenant/accounts";
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
  industry: z.string().nullable().optional(), status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(),
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
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    await deleteAccount(prisma, user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
