import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Account } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getAccount, updateAccount, deleteAccount } from "@/lib/tenant/accounts";
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
  externalPartnerKey: z.string().nullable().optional(),
  // Secret Partner-API key (admin-only; write-only — never echoed back).
  // Non-empty string -> rotate the key. `clearPartnerApiKey: true` -> explicitly remove it.
  // Absent/empty string with no clear flag -> leave the stored key untouched.
  partnerApiKey: z.string().optional(),
  clearPartnerApiKey: z.boolean().optional(),
});
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const { partnerApiKey, clearPartnerApiKey, ...d } = Patch.parse(await req.json());
    const trimmedKey = partnerApiKey?.trim();
    if ((trimmedKey || clearPartnerApiKey) && user.role !== "COMPANY_ADMIN") {
      throw new ForbiddenError("requires COMPANY_ADMIN");
    }
    const id = (await params).id;
    let account: Account = await updateAccount(prisma, user, id, d);
    // `updateAccount` above already resolved `id` through the tenant-scoped chokepoint
    // (getAccount) and would have thrown NotFoundError otherwise — so reusing that same
    // `id` for the raw update below can't cross tenants; it never touches a client-supplied
    // account id that hasn't already been verified in scope.
    if (trimmedKey) {
      account = await prisma.account.update({
        where: { id },
        data: { externalApiKeyEnc: encryptSecret(trimmedKey), externalApiKeyLast4: last4(trimmedKey) },
      });
    } else if (clearPartnerApiKey) {
      account = await prisma.account.update({
        where: { id },
        data: { externalApiKeyEnc: null, externalApiKeyLast4: null },
      });
    }
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
