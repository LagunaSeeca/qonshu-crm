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

// `companyName` is REQUIRED and trimmed: it is the BUILDING name, which is what a lead claims
// (one building, one record, org-wide). A blank or whitespace-only name would normalize to the
// empty claim key — a single claim shared by every unnamed building in the company — so it is
// rejected here as a 400 rather than reaching createLead.
const Create = z.object({
  title: z.string().min(1), contactName: z.string().min(1), stageId: z.string().min(1),
  companyName: z.string().trim().min(1),
  email: z.string().email().optional().or(z.literal("")), phone: z.string().optional(),
  source: z.string().optional(),
  priority: z.enum(["LOW","MEDIUM","HIGH"]).optional(),
  ownerId: z.string().optional(), expectedCloseDate: z.string().datetime().optional(),
  // Honoured ONLY when the SUPER_ADMIN names itself as the owner (see resolveLeadOwner in
  // scope.ts); dropped for every other actor, so it cannot be used to plant a lead in another
  // team's book.
  teamId: z.string().optional(),
});
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    // SUPER_ADMIN is here because the owner may now hold a lead of its own (and has always been
    // able to create one on a team member's behalf — resolveLeadOwner makes it name the owner
    // explicitly). It is NOT a wider grant: who the lead may be assigned to, and which team it
    // lands in, are still decided by scope.ts against the database.
    assertRole(user, ["SUPER_ADMIN", "COMPANY_ADMIN", "MEMBER"]);
    const d = Create.parse(await req.json());
    const lead = await createLead(prisma, user, { ...d, email: d.email || undefined, expectedCloseDate: d.expectedCloseDate ? new Date(d.expectedCloseDate) : null });
    return NextResponse.json(lead, { status: 201 });
  } catch (e) { return errorResponse(e); }
}
