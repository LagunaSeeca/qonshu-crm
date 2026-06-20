import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { createCompany } from "@/lib/platform/companies";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({ name: z.string().min(1), slug: z.string().min(1), adminEmail: z.string().email() });

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    const data = Body.parse(await req.json());
    const result = await createCompany(prisma, user, data);
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
