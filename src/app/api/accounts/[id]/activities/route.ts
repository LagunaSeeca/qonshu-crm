import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { AccountActivityKind } from "@prisma/client";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { addAccountActivity, listAccountActivities } from "@/lib/tenant/account-activities";
import { isPartnerLinkOutcome } from "@/lib/tenant/partner-link-audit";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// Pinned to the Prisma enum: `satisfies` makes TS fail the build if any value stops being a
// valid AccountActivityKind, so the two never silently drift apart.
const ACTIVITY_KINDS = ["NOTE", "CALL", "MEETING", "EMAIL"] as const satisfies readonly AccountActivityKind[];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // SUPER_ADMIN reads only (listAccountActivities resolves the account cross-tenant for them):
    // the partner-link audit rows live in this timeline and the platform admin who writes them
    // must be able to read them back. They stay OUT of POST below.
    assertRole(user, ["COMPANY_ADMIN", "MEMBER", "SUPER_ADMIN"]);
    return NextResponse.json(await listAccountActivities(prisma, user, (await params).id));
  } catch (e) { return errorResponse(e); }
}
// `outcome` is free text a tenant chooses, so it is refused the `partner_link:` prefix that marks
// the SUPER_ADMIN partner-link audit trail (src/lib/tenant/partner-link-audit.ts) — otherwise a
// COMPANY_ADMIN/MEMBER could plant rows, with any occurredAt they like, that read exactly like
// platform-admin audit entries. addAccountActivity refuses it again, so the guarantee does not
// depend on this route being the only door.
const Body = z.object({ kind: z.enum(ACTIVITY_KINDS), body: z.string().min(1), outcome: z.string().refine((v) => !isPartnerLinkOutcome(v), { message: "reserved outcome prefix" }).optional(), occurredAt: z.string().datetime().optional() });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Body.parse(await req.json());
    const act = await addAccountActivity(prisma, user, (await params).id, { ...d, occurredAt: d.occurredAt ? new Date(d.occurredAt) : undefined });
    return NextResponse.json(act, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
