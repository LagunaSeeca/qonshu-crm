import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/tenant/me";
import { prisma } from "@/db/client";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");
  // Super Admin (no company) belongs in the platform area, not the tenant CRM.
  if (!sessionUser.companyId) redirect("/platform/companies");

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
