import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/guards";
import {
  assignUserToAccount, listAccountAssignees, listAssignmentCandidates,
} from "@/lib/tenant/account-assignments";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// NO assertRole HERE, unlike the neighbouring tasks/asks routes — but that does NOT make this
// route ungated.
//
// A hardcoded `assertRole` list is what would lock out the ONBOARDING user assigned to the
// building, who must be able to see who else is on it. So the read gate is a CAPABILITY instead,
// and it lives in the service: listAccountAssignees asserts `manage_onboarding` (ONBOARDING |
// MEMBER | COMPANY_ADMIN | SUPER_ADMIN) and then scopes through getAccount, so a partner login is
// refused outright and an invisible building returns an empty list. Keeping it there rather than
// here means a second caller cannot reintroduce the leak by forgetting the gate.
//
// The WRITE paths carry their own capability gate (manage_account_assignments) inside the service,
// asserted before the id is read, so no route-level role list is needed for them either.
//
// `candidates` is included ONLY for a caller that holds manage_account_assignments, and is omitted
// (not null, absent) for everybody else — so the key's mere presence tells the UI whether to render
// the picker at all. Nothing is probed to produce it: `can()` is a pure role test on the session.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { id } = await params;
    const assignees = await listAccountAssignees(prisma, user, id);
    if (!can(user, "manage_account_assignments")) return NextResponse.json({ assignees });
    return NextResponse.json({ assignees, candidates: await listAssignmentCandidates(prisma, user, id) });
  } catch (e) { return errorResponse(e); }
}

const Body = z.object({ userId: z.string().min(1) });
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { userId } = Body.parse(await req.json());
    const row = await assignUserToAccount(prisma, user, (await params).id, userId);
    return NextResponse.json(row, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
