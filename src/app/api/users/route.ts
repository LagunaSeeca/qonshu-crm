import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { getTenantContext } from "@/lib/tenant/context";
import { listUsers } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

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
