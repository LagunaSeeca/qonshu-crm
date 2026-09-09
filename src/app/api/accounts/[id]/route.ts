import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccount, updateAccount, deleteAccount } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// Strip the partner-API secret columns from an account row before it ever reaches JSON. There is
// no per-account key entry anymore (the Partner API uses one shared X-API-Key from env — see
// src/lib/partner-api/credentials.ts), but the `externalApiKeyEnc`/`externalApiKeyLast4` columns
// still exist as a dormant override and must never leak to a client even if a row somehow has one
// set (e.g. seeded directly in the DB).
function maskAccount(account: Account) {
  return {
    ...account,
    externalApiKeyEnc: undefined,
    externalApiKeyLast4: undefined,
  };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const account = await getAccount(prisma, user, (await params).id);
    if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(maskAccount(account));
  } catch (e) { return errorResponse(e); }
}
const Patch = z.object({
  name: z.string().min(1).optional(), website: z.string().nullable().optional(),
  industry: z.string().nullable().optional(), status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(),
  accountManagerId: z.string().optional(),
  primaryContactName: z.string().nullable().optional(), primaryContactEmail: z.string().email().nullable().optional(),
  primaryContactPhone: z.string().nullable().optional(),
  // Partner NAME for the external analytics API — the account goes "live" off this plus the
  // shared PARTNER_API_KEY env var (see src/lib/partner-api/credentials.ts). No per-account
  // key entry: the Django backend authenticates every partner with one shared X-API-Key.
  externalPartnerKey: z.string().nullable().optional(),
});
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Patch.parse(await req.json());
    const id = (await params).id;
    const account: Account = await updateAccount(prisma, user, id, d);
    return NextResponse.json(maskAccount(account));
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
