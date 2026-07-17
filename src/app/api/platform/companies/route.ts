import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { createCompany } from "@/lib/platform/companies";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const Body = z.object({
  name: z.string().min(1),
  slug: z.string().min(1),
  adminName: z.string().min(1),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    const data = Body.parse(await req.json());
    const { company, admin } = await createCompany(prisma, user, data);
    return NextResponse.json(
      { company, admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role, status: admin.status } },
      { status: 201 },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
