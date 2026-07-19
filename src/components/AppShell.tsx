"use client";

import { useState } from "react";
import type { Role } from "@prisma/client";
import { Sidebar } from "@/components/Sidebar";
import { Topbar } from "@/components/Topbar";
import { SidebarDrawer } from "@/components/SidebarDrawer";

interface AppShellProps {
  role: Role;
  companyName?: string | null;
  userName?: string;
  userEmail?: string;
  children: React.ReactNode;
}

// Client wrapper that owns the mobile-drawer open state shared between the Topbar's
// hamburger button and the Sidebar drawer — both are siblings under the (app) layout,
// which is a server component and can't hold state itself.
export function AppShell({ role, companyName, userName, userEmail, children }: AppShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Desktop sidebar (>= lg) */}
      <div className="hidden lg:flex">
        <Sidebar role={role} companyName={companyName} />
      </div>

      {/* Mobile sidebar drawer (< lg) */}
      <SidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <Sidebar role={role} companyName={companyName} onNavigate={() => setDrawerOpen(false)} />
      </SidebarDrawer>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar userName={userName} userEmail={userEmail} onMenuClick={() => setDrawerOpen(true)} />
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-7xl min-w-0 p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
