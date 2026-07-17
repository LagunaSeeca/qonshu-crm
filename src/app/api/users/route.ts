import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers, createUser, InvalidUserRoleError } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const CreateBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["COMPANY_ADMIN", "MEMBER", "PARTNER_VIEWER"]),
  accountId: z.string().min(1).optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const users = await listUsers(prisma, getTenantContext(user));
    return NextResponse.json(
      users.map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status }))
    );
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN"]);
    const data = CreateBody.parse(await req.json());
    const created = await createUser(prisma, user, data);
    return NextResponse.json(
      { id: created.id, email: created.email, name: created.name, role: created.role, status: created.status },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof InvalidUserRoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    return errorResponse(e);
  }
}
