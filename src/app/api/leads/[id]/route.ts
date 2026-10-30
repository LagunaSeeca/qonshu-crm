import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getLead, updateLead, deleteLead } from "@/lib/tenant/leads";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const lead = await getLead(prisma, user, (await params).id);
    if (!lead) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(lead);
  } catch (e) { return errorResponse(e); }
}
// `companyName` is no longer nullable: it is the building name this lead claims, and a lead
// without one has no claim. It may be CHANGED (which re-runs the claim guard in updateLead) but
// not cleared.
//
// `ownerId` is still accepted here, but updateLead now rejects it for a MEMBER: handing a lead
// to someone else is a team-admin action. Before, any member who could see a lead could PATCH
// its owner — and under the team scope rules would then never see it again.
const Patch = z.object({
  title: z.string().min(1).optional(), contactName: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(), phone: z.string().nullable().optional(),
  companyName: z.string().trim().min(1).optional(), source: z.string().nullable().optional(),
  priority: z.enum(["LOW","MEDIUM","HIGH"]).optional(),
  ownerId: z.string().optional(), expectedCloseDate: z.string().datetime().nullable().optional(),
});
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const d = Patch.parse(await req.json());
    const lead = await updateLead(prisma, user, (await params).id, { ...d, expectedCloseDate: d.expectedCloseDate === undefined ? undefined : d.expectedCloseDate ? new Date(d.expectedCloseDate) : null });
    return NextResponse.json(lead);
  } catch (e) { return errorResponse(e); }
}
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    await deleteLead(prisma, user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (e) { return errorResponse(e); }
}
