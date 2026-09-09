import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { errorResponse, UnauthorizedError } from "@/lib/http";
import { listTakenPartnerKeys } from "@/lib/tenant/accounts";
import { fetchPartners } from "@/lib/partner-api/client";
import { resolveGlobalCredentials } from "@/lib/partner-api/credentials";
import {
  InvalidApiKeyError,
  UnknownPartnerError,
  PartnerApiUnavailableError,
} from "@/lib/partner-api/errors";
import type { PartnerListResponse } from "@/lib/partner-api/schema";

// LIVE, read-only list of the UNCLAIMED partners the shared PARTNER_API_KEY can see — powers
// the SUPER_ADMIN-only partner assignment card at /platform/accounts. GLOBAL, not per-account:
// unlike src/app/api/accounts/[id]/objects/route.ts there is no account row to resolve a partner
// name or per-account key override from, so this goes straight through
// resolveGlobalCredentials() to the shared env key. Fetched fresh on every request — nothing
// is persisted or cached.
//
// SUPER_ADMIN ONLY, deliberately. The partner namespace is shared across every tenant (one
// PARTNER_API_KEY, `?partner=<name>` is the only discriminator), so this list names complexes
// belonging to OTHER companies. Handing it to a COMPANY_ADMIN/MEMBER both leaks the tenant
// roster and lets them link their own account to someone else's partner — which would expose
// that partner's debt, payments and unit-level owner names/phones.
//
// Already-claimed names are filtered out for the same reason: two accounts on one name
// double-count every analytics fan-out and cross-expose two tenants' data. One batched query
// (listTakenPartnerKeys), not a lookup per partner.
export const dynamic = "force-dynamic";

type PartnersPayload = {
  status: "ok";
  partners: PartnerListResponse["partners"];
};

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["SUPER_ADMIN"]);

    const creds = resolveGlobalCredentials();
    if (!creds) {
      return NextResponse.json({ status: "not_configured" }, { status: 200 });
    }

    let list: PartnerListResponse;
    try {
      list = await fetchPartners({ baseUrl: creds.baseUrl, apiKey: creds.apiKey });
    } catch (e) {
      // Map each upstream failure to a distinct, typed status the picker can branch on.
      if (e instanceof InvalidApiKeyError)
        return NextResponse.json({ status: "invalid_api_key" }, { status: 502 });
      // This endpoint takes no `partner` param, so a 404 isn't a "wrong partner name" the
      // way it is for the per-account routes — fold it into the same unavailable status as
      // 5xx/network/timeout, and never echo raw error text back to the client.
      if (e instanceof UnknownPartnerError || e instanceof PartnerApiUnavailableError)
        return NextResponse.json({ status: "partner_api_unavailable" }, { status: 503 });
      // Anything else — including a zod ValidationError from upstream response-shape drift —
      // collapses to the same typed "unavailable" state.
      return NextResponse.json({ status: "partner_api_unavailable" }, { status: 503 });
    }

    // Only query the DB once the upstream call succeeded — a failed fetch short-circuits above.
    const taken = await listTakenPartnerKeys(prisma);
    const payload: PartnersPayload = {
      status: "ok",
      partners: list.partners.filter((p) => !taken.has(p.name)),
    };
    return NextResponse.json(payload, { status: 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
