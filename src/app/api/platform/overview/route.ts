import { NextResponse } from "next/server";
import { prisma } from "@/db/client";
import { getSessionUser } from "@/lib/auth/session";
import { getPlatformOverview } from "@/lib/platform/overview";
import { errorResponse, UnauthorizedError } from "@/lib/http";

// getPlatformOverview asserts SUPER_ADMIN internally (ForbiddenError -> 403 via errorResponse);
// this route only needs the session guard.
export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) throw new UnauthorizedError();
    return NextResponse.json(await getPlatformOverview(prisma, user));
  } catch (e) {
    return errorResponse(e);
  }
}
