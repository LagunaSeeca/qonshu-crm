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
  UsersRound,
  Link2,
  Landmark,
  FileBarChart,
  ListTodo,
  ReceiptText,
} from "lucide-react";
import { isAdmin } from "@/lib/auth/guards";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/work", label: "My Work", icon: ListTodo },
  { href: "/crm", label: "Sales CRM", icon: Briefcase },
  { href: "/accounts", label: "Accounts", icon: Building2 },
  { href: "/settlements", label: "Settlements", icon: Landmark },
  { href: "/service-fees", label: "Service fees", icon: ReceiptText },
  { href: "/reports", label: "Reports", icon: FileBarChart },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
];

// Partner logins are read-only and scoped to a single account: they only ever see
// Analytics, Settlements, and Service fees — everything else (CRM, accounts, reports, team
// admin) is hidden from the nav entirely, not just gated on click.
const PARTNER_NAV_HREFS = new Set(["/analytics", "/settlements", "/service-fees"]);

interface SidebarProps {
  role: Role;
  companyName?: string | null;
  /** The viewer's team. Shown in the footer: with one company, the team is what tells people which book they are in. */
  teamName?: string | null;
  /** Called when a nav link is activated — used to close the mobile drawer on navigation. */
  onNavigate?: () => void;
}

export function Sidebar({ role, companyName, teamName, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const nav = role === "PARTNER_VIEWER" ? NAV.filter((item) => PARTNER_NAV_HREFS.has(item.href)) : NAV;

  // Team admins and the owner administer users; only the owner manages teams and partner links.
  // Built from the real role helper so the nav can never disagree with the server guards.
  const adminUser = { id: "", companyId: null, teamId: null, role };
  const adminNav = [
    ...(isAdmin(adminUser) ? [{ href: "/users", label: "Users", icon: Users }] : []),
    ...(role === "SUPER_ADMIN"
      ? [
          { href: "/teams", label: "Teams", icon: UsersRound },
          { href: "/partner-links", label: "Partner links", icon: Link2 },
        ]
      : []),
  ];

  function isActive(href: string) {
    if (!pathname) return false;
    if (href === "/dashboard") return pathname === "/dashboard";
    return pathname.startsWith(href);
  }

  const footerLabel = teamName ?? companyName;

  return (
    <nav
      className="flex flex-col w-60 h-full border-r border-border bg-card shrink-0"
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
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
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

        {adminNav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors duration-150 cursor-pointer",
              isActive(href)
                ? "bg-accent/10 text-accent border-l-2 border-accent pl-[10px]"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon
              size={16}
              className={cn("shrink-0", isActive(href) ? "text-accent" : "text-muted-foreground")}
              aria-hidden="true"
            />
            {label}
          </Link>
        ))}
      </div>

      {/* Footer — company name + role chip */}
      {(companyName || role) && (
        <div className="p-3 border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2">
            {footerLabel && (
              <span className="text-xs font-medium text-muted-foreground truncate flex-1">
                {footerLabel}
              </span>
            )}
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0 font-medium shrink-0"
            >
              {role === "SUPER_ADMIN"
                ? "Super Admin"
                : role === "COMPANY_ADMIN"
                  ? "Team Admin"
                  : role === "PARTNER_VIEWER"
                    ? "Partner"
                    : "Member"}
            </Badge>
          </div>
        </div>
      )}
    </nav>
  );
}
