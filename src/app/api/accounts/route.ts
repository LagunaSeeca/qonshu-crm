import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listAccounts, createAccountWithLogin } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError, ForbiddenError } from "@/lib/http";
import { encryptSecret, last4 } from "@/lib/crypto/secret";

// Strip the partner-API secret from an account row before it ever reaches JSON: the
// ciphertext (externalApiKeyEnc) and even the "safe" last4 are dropped from the payload
// (set to `undefined`, which JSON.stringify omits entirely) in favor of a single masked
// hint. Callers never receive the plaintext or ciphertext key, only "••••<last4>" / null.
function maskAccount(account: Account) {
  return {
    ...account,
    externalApiKeyEnc: undefined,
    externalApiKeyLast4: undefined,
    externalApiKeyMasked: account.externalApiKeyLast4 ? `••••${account.externalApiKeyLast4}` : null,
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
  externalPartnerKey: z.string().optional(),
  // Secret Partner-API key (admin-only; write-only — never echoed back). Empty/absent
  // leaves the stored key untouched; see PATCH for the explicit "clear" path.
  partnerApiKey: z.string().optional(),
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
    const { partnerApiKey, ...d } = Create.parse(await req.json());
    const trimmedKey = partnerApiKey?.trim();
    if (trimmedKey && user.role !== "COMPANY_ADMIN") throw new ForbiddenError("requires COMPANY_ADMIN");
    const { account, partnerUser } = await createAccountWithLogin(prisma, user, {
      ...d, primaryContactEmail: d.primaryContactEmail || undefined,
    });
    // Encrypt-at-rest, stored separately from the rest of the account fields above; the
    // account we just created is already scoped to this company, so this can't cross tenants.
    const finalAccount: Account = trimmedKey
      ? await prisma.account.update({
          where: { id: account.id },
          data: { externalApiKeyEnc: encryptSecret(trimmedKey), externalApiKeyLast4: last4(trimmedKey) },
        })
      : account;
    // Never leak passwordHash back to the client, even on the just-created partner login.
    return NextResponse.json({
      account: maskAccount(finalAccount),
      partnerUser: partnerUser ? { id: partnerUser.id, name: partnerUser.name, email: partnerUser.email, role: partnerUser.role, status: partnerUser.status } : null,
    }, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
