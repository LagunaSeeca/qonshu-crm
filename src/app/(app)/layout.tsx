import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/tenant/me";
import { prisma } from "@/db/client";
import { AppShell } from "@/components/AppShell";

// Partner logins are read-only and tied to exactly one account — everywhere else in the
// tenant app (CRM, accounts, reports, users…) is off-limits and bounces to /analytics.
// /profile is the one exception: changing their own password is the only write a partner may perform.
const PARTNER_ALLOWED_PREFIXES = ["/analytics", "/settlements", "/service-fees", "/profile"];

function isPartnerAllowed(pathname: string): boolean {
  return PARTNER_ALLOWED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");
  // The owner (SUPER_ADMIN) now lives in this same app — there is no separate platform area. A
  // login with no company has nothing to show here.
  if (!sessionUser.companyId) redirect("/login");

  if (sessionUser.role === "PARTNER_VIEWER") {
    const pathname = (await headers()).get("x-pathname") ?? "";
    if (!isPartnerAllowed(pathname)) redirect("/analytics");
  }

  const currentUser = await getCurrentUser(prisma, sessionUser);

  return (
    <AppShell
      role={currentUser.role}
      companyName={currentUser.companyName}
      teamName={currentUser.teamName}
      userName={currentUser.name}
      userEmail={currentUser.email}
    >
      {children}
    </AppShell>
  );
}
