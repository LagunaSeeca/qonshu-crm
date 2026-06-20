import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ForbiddenError } from "@/lib/auth/guards";
export { ForbiddenError };

export class UnauthorizedError extends Error {}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthorizedError)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (e instanceof ForbiddenError)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (e instanceof ZodError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
