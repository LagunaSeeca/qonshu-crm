import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { acceptInvitation } from "@/lib/tenant/invitations";
import { errorResponse } from "@/lib/http";

const Body = z.object({ token: z.string().min(1), name: z.string().min(1), password: z.string().min(8) });

export async function POST(req: NextRequest) {
  try {
    const { token, name, password } = Body.parse(await req.json());
    const user = await acceptInvitation(prisma, { token, name, password });
    return NextResponse.json({ id: user.id }, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}
