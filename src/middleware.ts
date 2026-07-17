import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
  });

  if (!token) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("callbackUrl", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Surface the current pathname to Server Components (e.g. (app)/layout.tsx) via a request
  // header — usePathname() only works in Client Components, so this is how the tenant layout
  // knows which route a PARTNER_VIEWER is hitting in order to gate it.
  const headers = new Headers(req.headers);
  headers.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/crm/:path*",
    "/accounts/:path*",
    "/analytics/:path*",
    "/users/:path*",
    "/platform/:path*",
    "/work/:path*",
    "/reports/:path*",
    "/settlements/:path*",
    "/service-fees/:path*",
  ],
};
