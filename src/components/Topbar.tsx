"use client";

import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { signOut } from "next-auth/react";
import { Sun, Moon, LogOut, ChevronDown, KeyRound, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

interface TopbarProps {
  title?: string;
  userName?: string;
  userEmail?: string;
  /** When provided, a hamburger button is shown (< lg) that calls this to open the mobile nav drawer. */
  onMenuClick?: () => void;
}

function getInitials(name?: string): string {
  if (!name) return "?";
  return name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function Topbar({
  title = "Dashboard",
  userName,
  userEmail,
  onMenuClick,
}: TopbarProps) {
  const { theme, setTheme } = useTheme();
  const router = useRouter();

  function toggleTheme() {
    setTheme(theme === "dark" ? "light" : "dark");
  }

  function handleSignOut() {
    signOut({ callbackUrl: "/login" });
  }

  const initials = getInitials(userName);

  return (
    <header className="h-14 border-b border-border bg-background flex items-center px-4 md:px-6 gap-2 md:gap-4 shrink-0">
      {/* Mobile nav trigger */}
      {onMenuClick && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          aria-label="Open navigation menu"
          className="h-8 w-8 -ml-1 shrink-0 text-muted-foreground hover:text-foreground lg:hidden"
        >
          <Menu size={18} aria-hidden="true" />
        </Button>
      )}

      {/* Page title */}
      <h1 className="text-base font-semibold text-foreground flex-1 min-w-0 truncate">
        {title}
      </h1>

      {/* Right side controls */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Theme toggle */}
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleTheme}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
        >
          {theme === "dark" ? (
            <Sun size={16} aria-hidden="true" />
          ) : (
            <Moon size={16} aria-hidden="true" />
          )}
        </Button>

        {/* User dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2 h-8 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent/10 transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            aria-label="User menu"
          >
            <Avatar className="h-6 w-6">
              <AvatarFallback className="text-[10px] font-semibold bg-accent text-accent-foreground">
                {initials}
              </AvatarFallback>
            </Avatar>
            <ChevronDown size={12} aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col gap-0.5">
                  {userName && (
                    <span className="text-sm font-medium text-foreground">
                      {userName}
                    </span>
                  )}
                  {userEmail && (
                    <span className="text-xs text-muted-foreground truncate">
                      {userEmail}
                    </span>
                  )}
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => router.push("/profile")}
              className="cursor-pointer gap-2"
            >
              <KeyRound size={14} aria-hidden="true" />
              Change password
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-destructive focus:text-destructive cursor-pointer gap-2"
            >
              <LogOut size={14} aria-hidden="true" />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
