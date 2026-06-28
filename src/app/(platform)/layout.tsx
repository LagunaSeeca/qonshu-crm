import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";
import { getCurrentUser } from "@/lib/tenant/me";
import { prisma } from "@/db/client";
import { Topbar } from "@/components/Topbar";
import Link from "next/link";
import { Building } from "lucide-react";

export default async function PlatformLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const sessionUser = await getSessionUser();
  if (!sessionUser) redirect("/login");
  if (sessionUser.role !== "SUPER_ADMIN") redirect("/dashboard");

  const currentUser = await getCurrentUser(prisma, sessionUser);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Simplified platform sidebar */}
      <nav
        className="flex flex-col w-60 min-h-screen border-r border-border bg-card shrink-0"
        aria-label="Platform navigation"
      >
        {/* Brand wordmark */}
        <div className="h-14 flex items-center px-5 border-b border-border">
          <span className="text-[17px] font-bold tracking-tight text-foreground select-none">
            Qonshu
          </span>
          <span className="ml-2 text-xs font-medium text-muted-foreground">
            Platform
          </span>
        </div>
        <div className="flex flex-col gap-0.5 p-3 flex-1">
          <Link
            href="/platform/companies"
            className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-150 cursor-pointer"
          >
            <Building size={16} className="shrink-0" aria-hidden="true" />
            Companies
          </Link>
        </div>
      </nav>

      {/* Main content area */}
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar
          title="Platform Admin"
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
