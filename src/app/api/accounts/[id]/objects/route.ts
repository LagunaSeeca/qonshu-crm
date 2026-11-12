import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { errorResponse, UnauthorizedError } from "@/lib/http";
import { getAccountObjects } from "@/lib/tenant/account-objects";

// LIVE, read-only view of a partner complex's structure. All logic — scoping, the upstream
// fetch, normalization and the per-role detail gate — lives in the service so server components
// calling it directly get the same enforcement. This handler only maps the result to HTTP.
export const dynamic = "force-dynamic";

const STATUS_CODE: Record<string, number> = {
  not_found: 404,
  invalid_api_key: 502,
  unknown_partner: 502,
  partner_api_unavailable: 503,
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();

    const result = await getAccountObjects(user, (await params).id);
    if (result.status === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(result, { status: STATUS_CODE[result.status] ?? 200 });
  } catch (e) {
    return errorResponse(e);
  }
}
