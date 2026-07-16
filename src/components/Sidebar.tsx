"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@prisma/client";
import {
  LayoutDashboard,
  Users,
  Building2,
  BarChart3,
  Briefcase,
  Building,
  Landmark,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/crm", label: "Sales CRM", icon: Briefcase },
  { href: "/accounts", label: "Accounts", icon: Building2 },
  { href: "/settlements", label: "Settlements", icon: Landmark },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

interface SidebarProps {
  role: Role;
  companyName?: string | null;
}

export function Sidebar({ role, companyName }: SidebarProps) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (!pathname) return false;
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  return (
    <nav
      className="flex flex-col w-60 min-h-screen border-r border-border bg-card shrink-0"
      aria-label="Main navigation"
    >
      {/* Brand wordmark */}
      <div className="h-14 flex items-center px-5 border-b border-border">
        <span className="text-[17px] font-700 tracking-tight text-foreground select-none">
          Qonshu
        </span>
      </div>

      {/* Nav items */}
      <div className="flex flex-col gap-0.5 p-3 flex-1 overflow-y-auto">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150 cursor-pointer",
              isActive(href)
                ? "bg-accent/10 text-accent border-l-2 border-accent pl-[10px]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon
              size={16}
              className={cn(
                "shrink-0",
                isActive(href) ? "text-accent" : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            {label}
          </Link>
        ))}

        {role === "COMPANY_ADMIN" && (
          <Link
            href="/users"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150 cursor-pointer",
              isActive("/users")
                ? "bg-accent/10 text-accent border-l-2 border-accent pl-[10px]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Users
              size={16}
              className={cn(
                "shrink-0",
                isActive("/users") ? "text-accent" : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            Users
          </Link>
        )}

        {role === "SUPER_ADMIN" && (
          <Link
            href="/platform/companies"
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150 cursor-pointer",
              isActive("/platform/companies")
                ? "bg-accent/10 text-accent border-l-2 border-accent pl-[10px]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Building
              size={16}
              className={cn(
                "shrink-0",
                isActive("/platform/companies")
                  ? "text-accent"
                  : "text-muted-foreground"
              )}
              aria-hidden="true"
            />
            Companies
          </Link>
        )}
      </div>

      {/* Footer — company name + role chip */}
      {(companyName || role) && (
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            {companyName && (
              <span className="text-xs font-medium text-muted-foreground truncate flex-1">
                {companyName}
              </span>
            )}
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 font-medium shrink-0"
            >
              {role === "SUPER_ADMIN"
                ? "Super Admin"
                : role === "COMPANY_ADMIN"
                  ? "Admin"
                  : "Member"}
            </Badge>
          </div>
        </div>
      )}
    </nav>
  );
}
