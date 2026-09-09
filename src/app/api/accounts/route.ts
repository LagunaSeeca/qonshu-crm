import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listAccounts, createAccountWithLogin } from "@/lib/tenant/accounts";
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

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    const accounts = await listAccounts(prisma, user, {
      status: (sp.get("status") as "ACTIVE"|"AT_RISK"|"CHURNED"|null) ?? undefined,
      accountManagerId: sp.get("accountManagerId") ?? undefined, q: sp.get("q") ?? undefined,
    });
    return NextResponse.json(accounts.map(maskAccount));
  } catch (e) { return errorResponse(e); }
}
const Create = z.object({ name: z.string().min(1), website: z.string().optional(), industry: z.string().optional(),
  status: z.enum(["ACTIVE","AT_RISK","CHURNED"]).optional(), accountManagerId: z.string().optional(),
  primaryContactName: z.string().optional(),
  primaryContactEmail: z.string().email().optional().or(z.literal("")), primaryContactPhone: z.string().optional(),
  // Partner NAME for the external analytics API — the account goes "live" off this plus the
  // shared PARTNER_API_KEY env var (see src/lib/partner-api/credentials.ts). No per-account
  // key entry: the Django backend authenticates every partner with one shared X-API-Key.
  externalPartnerKey: z.string().optional(),
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
      account: maskAccount(account),
      partnerUser: partnerUser ? { id: partnerUser.id, name: partnerUser.name, email: partnerUser.email, role: partnerUser.role, status: partnerUser.status } : null,
    }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
