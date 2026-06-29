import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { convertLeadToAccount, AlreadyConvertedError } from "@/lib/tenant/accounts";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ leadId: z.string().min(1) });
export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser(); if (!user) throw new UnauthorizedError();
    const { leadId } = Body.parse(await req.json());
    return NextResponse.json(await convertLeadToAccount(prisma, user, leadId), { status: 201 });
  } catch (e) {
    if (e instanceof AlreadyConvertedError) return NextResponse.json({ error: "already_converted" }, { status: 409 });
    return errorResponse(e);
  }
}
