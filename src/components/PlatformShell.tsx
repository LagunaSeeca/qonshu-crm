"use client";

import { useState } from "react";
import Link from "next/link";
import { Building } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { SidebarDrawer } from "@/components/SidebarDrawer";

interface PlatformShellProps {
  userName?: string;
  userEmail?: string;
  children: React.ReactNode;
}

function PlatformNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col w-60 h-full border-r border-border bg-card shrink-0" aria-label="Platform navigation">
      <div className="h-14 flex items-center px-5 border-b border-border">
        <span className="text-[17px] font-bold tracking-tight text-foreground select-none">Qonshu</span>
        <span className="ml-2 text-xs font-medium text-muted-foreground">Platform</span>
      </div>
      <div className="flex flex-col gap-0.5 p-3 flex-1">
        <Link
          href="/platform/companies"
          onClick={onNavigate}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors duration-150 cursor-pointer"
        >
          <Building size={16} className="shrink-0" aria-hidden="true" />
          Companies
        </Link>
      </div>
    </nav>
  );
}

export function PlatformShell({ userName, userEmail, children }: PlatformShellProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      <div className="hidden lg:flex">
        <PlatformNav />
      </div>

      <SidebarDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)}>
        <PlatformNav onNavigate={() => setDrawerOpen(false)} />
      </SidebarDrawer>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Topbar
          title="Platform Admin"
          userName={userName}
          userEmail={userEmail}
          onMenuClick={() => setDrawerOpen(true)}
        />
        <main className="flex-1 overflow-y-auto overflow-x-hidden">
          <div className="mx-auto max-w-7xl min-w-0 p-4 md:p-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
