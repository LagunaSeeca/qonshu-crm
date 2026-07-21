import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { ForbiddenError, NotFoundError } from "@/lib/auth/guards";
export { ForbiddenError, NotFoundError };

export class UnauthorizedError extends Error {}

// Build a safe Content-Disposition for a download. The filename is user-supplied (uploaded),
// so injecting it raw lets a `"`, `\`, or CR/LF break the header. Emit an ASCII-sanitized
// `filename="…"` fallback plus an RFC 5987 `filename*` that carries the real (unicode) name.
export function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[\r\n"\\]/g, "_").replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof UnauthorizedError)
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (e instanceof ForbiddenError)
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (e instanceof ZodError)
    return NextResponse.json({ error: e.message }, { status: 400 });
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return NextResponse.json({ error: "conflict" }, { status: 409 });
  }
  if (e instanceof NotFoundError)
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ error: "server_error" }, { status: 500 });
}
