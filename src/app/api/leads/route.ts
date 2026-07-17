import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listLeads, createLead } from "@/lib/tenant/leads";
import { errorResponse, UnauthorizedError } from "@/lib/http";

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const sp = req.nextUrl.searchParams;
    const leads = await listLeads(prisma, user, {
      stageId: sp.get("stageId") ?? undefined, ownerId: sp.get("ownerId") ?? undefined,
      q: sp.get("q") ?? undefined, sort: (sp.get("sort") as "createdAt" | null) ?? undefined,
      skip: sp.get("skip") ? Number(sp.get("skip")) : undefined, take: sp.get("take") ? Number(sp.get("take")) : undefined,
    });
    return NextResponse.json(leads);
  } catch (e) { return errorResponse(e); }
}

const Create = z.object({
  title: z.string().min(1), contactName: z.string().min(1), stageId: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")), phone: z.string().optional(),
  companyName: z.string().optional(), source: z.string().optional(),
  priority: z.enum(["LOW","MEDIUM","HIGH"]).optional(),
  ownerId: z.string().optional(), expectedCloseDate: z.string().datetime().optional(),
});
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "MEMBER"]);
    const d = Create.parse(await req.json());
    const lead = await createLead(prisma, user, { ...d, email: d.email || undefined, expectedCloseDate: d.expectedCloseDate ? new Date(d.expectedCloseDate) : null });
    return NextResponse.json(lead, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
