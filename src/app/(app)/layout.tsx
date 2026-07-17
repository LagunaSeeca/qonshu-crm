import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/tenant/me";
import { prisma } from "@/db/client";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";

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
  // Super Admin (no company) belongs in the platform area, not the tenant CRM.
  if (!sessionUser.companyId) redirect("/platform/companies");

  if (sessionUser.role === "PARTNER_VIEWER") {
    const pathname = (await headers()).get("x-pathname") ?? "";
    if (!isPartnerAllowed(pathname)) redirect("/analytics");
  }

  const currentUser = await getCurrentUser(prisma, sessionUser);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <Sidebar
        role={currentUser.role}
        companyName={currentUser.companyName}
      />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar
          userName={currentUser.name}
          userEmail={currentUser.email}
        />
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
