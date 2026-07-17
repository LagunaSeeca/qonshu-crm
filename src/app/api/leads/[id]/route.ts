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
const Patch = z.object({
  title: z.string().min(1).optional(), contactName: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(), phone: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(), source: z.string().nullable().optional(),
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
