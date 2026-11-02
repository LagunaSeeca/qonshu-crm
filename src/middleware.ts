import { getToken } from "next-auth/jwt";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function middleware(req: NextRequest) {
  // On HTTPS (production) Auth.js writes a `__Secure-`prefixed session cookie. getToken only
  // looks for that name when told the connection is secure — without this the token is never
  // found in production and every authenticated page redirects to /login.
  const isSecure = req.nextUrl.protocol === "https:";
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: isSecure,
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

// EVERY AUTHENTICATED PAGE MUST BE LISTED — including the ones a PARTNER_VIEWER is allowed to
// reach. (app)/layout.tsx gates partners on the `x-pathname` header this middleware sets, and an
// unmatched path means the header is absent, the layout reads "", and no prefix matches — so a
// partner is bounced to /analytics. That is how /profile, the ONE write a partner is permitted
// (their own password), was unreachable for the only role that needed it: the route was in the
// layout's allow-list and missing from this matcher.
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/profile/:path*",
    "/crm/:path*",
    "/accounts/:path*",
    "/analytics/:path*",
    "/users/:path*",
    "/teams/:path*",
    "/partner-links/:path*",
    "/work/:path*",
    "/reports/:path*",
    "/settlements/:path*",
    "/service-fees/:path*",
  ],
};
