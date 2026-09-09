import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { assertRole } from "@/lib/auth/guards";
import { listUsers, createUser, InvalidUserRoleError } from "@/lib/tenant/users";
import { errorResponse, UnauthorizedError } from "@/lib/http";

const CreateBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(["COMPANY_ADMIN", "MEMBER", "PARTNER_VIEWER"]),
  accountId: z.string().min(1).optional(),
  // Only meaningful when the actor is a SUPER_ADMIN (who has no company of their own, so must
  // name the target company). For a COMPANY_ADMIN actor, createUser() always uses their own
  // companyId; passing a DIFFERENT company's id here is rejected (400) rather than silently
  // ignored, so a tenant-scoped caller can't smuggle a cross-tenant create through this field
  // and get back a misleading 201.
  companyId: z.string().min(1).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    assertRole(user, ["COMPANY_ADMIN", "SUPER_ADMIN"]);
    const companyIdParam = req.nextUrl.searchParams.get("companyId");
    let companyId: string;
    if (user.companyId) {
      // COMPANY_ADMIN is always scoped to their own company. A companyId param naming a
      // DIFFERENT company is rejected outright (400) — silently substituting their own company
      // would return 200 for something other than what was asked (same rationale as the
      // companyId check in createUser).
      if (companyIdParam && companyIdParam !== user.companyId) {
        return NextResponse.json({ error: "cannot list another company's users" }, { status: 400 });
      }
      companyId = user.companyId;
    } else {
      // SUPER_ADMIN has no company of their own, so the target must be named explicitly.
      if (!companyIdParam) {
        return NextResponse.json({ error: "companyId is required to list users as a super admin" }, { status: 400 });
      }
      companyId = companyIdParam;
    }
    const users = await listUsers(prisma, { companyId });
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
    assertRole(user, ["COMPANY_ADMIN", "SUPER_ADMIN"]);
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
